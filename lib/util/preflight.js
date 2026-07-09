/**
 * Preflight checks run on `pasture start` / `pasture restart`.
 *
 * Why this exists: previously the daemon would happily start with a broken
 * Playwright install (browser binary at the wrong revision after a Playwright
 * version bump). The error only surfaced minutes-to-hours later, when a cron
 * job or the user finally invoked the `browse` skill, and the failure mode
 * looked like an LLM hallucination ("I can't reach localhost from here") rather
 * than a missing dep. Surface that earlier, prompt the user, and fix it.
 *
 * Each check returns a uniform shape so the CLI can render results and decide
 * whether to prompt for an auto-install.
 *
 * Result shape:
 *   { id, label, ok, severity: 'fatal' | 'warn' | 'info', message, hint?, autoFix? }
 *
 * - severity 'fatal': the daemon should not start without fixing this.
 * - severity 'warn':  daemon will start, but a feature is broken (logged loudly).
 * - severity 'info':  printed for visibility; not actionable.
 * - autoFix:          { label, command, args }  — the CLI may offer to run this.
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getConfigPath } from './paths.js';
import { getLlmAuthStatus, normalizeLlmAuth } from '../llm/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @typedef {{ id: string, label: string, ok: boolean, severity: 'fatal'|'warn'|'info', message: string, hint?: string, autoFix?: { label: string, command: string, args: string[] } }} CheckResult */

/**
 * Verify the Playwright Chromium binary the installed Playwright version
 * expects actually exists on disk AND can launch in the same mode the daemon
 * uses (`headless: true`, which on recent Playwright versions resolves to a
 * separate `chromium_headless_shell-<rev>` binary, NOT the full Chrome that
 * `executablePath()` returns).
 *
 * Strategy:
 *   1. Try a real `chromium.launch({ headless: true })` and immediately close.
 *      Playwright's own error message tells the user exactly what's missing
 *      (revision, path) — that's the most accurate diagnostic possible.
 *   2. If launch fails, surface the message + offer `npx playwright install
 *      chromium` as the auto-fix.
 *   3. If launch succeeds, also report the resolved executablePath() for
 *      visibility.
 *
 * Cost: a real headless Chromium spin-up is ~0.5–2s. That's acceptable for
 * `pasture start` and *much* cheaper than the alternative of starting clean
 * and dying mid-cron later.
 *
 * @returns {Promise<CheckResult>}
 */
export async function checkPlaywrightChromium() {
  const id = 'playwright-chromium';
  const label = 'Playwright Chromium binary';
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    return {
      id,
      label,
      ok: false,
      severity: 'fatal',
      message: `Could not load 'playwright' module: ${err?.message || err}`,
      hint: 'Install dependencies: `npm install` (or `pnpm install`) from the pasture install dir.',
    };
  }

  // Static path check first (cheap). If the full Chrome binary isn't there
  // the headless shell almost certainly isn't either, and this is faster.
  let expected = '';
  try {
    expected = chromium.executablePath();
  } catch (err) {
    return {
      id,
      label,
      ok: false,
      severity: 'fatal',
      message: `Playwright did not return an executable path: ${err?.message || err}`,
      hint: 'Try: `npx playwright install chromium`',
      autoFix: { label: 'npx playwright install chromium', command: 'npx', args: ['playwright', 'install', 'chromium'] },
    };
  }
  if (!expected || !existsSync(expected)) {
    return {
      id,
      label,
      ok: false,
      severity: 'fatal',
      message: `Chromium binary missing at: ${expected || '(unknown path)'}.`,
      hint: 'Playwright was likely upgraded without re-running its post-install. Run: `npx playwright install chromium`',
      autoFix: { label: 'npx playwright install chromium', command: 'npx', args: ['playwright', 'install', 'chromium'] },
    };
  }

  // Live launch — catches the headless-shell-revision-mismatch case that
  // executablePath() alone misses (this is the exact failure mode that the
  // pasture daemon hit in production).
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    const msg = String(err?.message || err);
    return {
      id,
      label,
      ok: false,
      severity: 'fatal',
      message: `Headless Chromium failed to launch: ${msg.split('\n')[0]}`,
      hint: msg.includes('Executable doesn\'t exist')
        ? 'The headless-shell binary for the installed Playwright version is missing. Run: `npx playwright install chromium`'
        : 'Try: `npx playwright install chromium` (or check launch sandboxing/permissions).',
      autoFix: { label: 'npx playwright install chromium', command: 'npx', args: ['playwright', 'install', 'chromium'] },
    };
  }
  try { await browser.close(); } catch (_) {}

  return {
    id,
    label,
    ok: true,
    severity: 'info',
    message: `OK (launches headless; chrome at ${expected})`,
  };
}

/**
 * Read ~/.pasture/.env and report which LLM_*_API_KEY slots are populated.
 * Cloud LLMs are how the planner gets reliable tool calls; running purely on
 * the local fallback for long stretches produces hallucinated tool calls
 * (observed in production logs). This is informational + warning level: a
 * missing key is annoying, not fatal — the daemon still works degraded.
 *
 * @param {{ envPath?: string }} [opts]
 * @returns {CheckResult}
 */
export function checkLlmKeys({ envPath } = {}) {
  const id = 'llm-keys';
  const label = 'Cloud LLM auth';
  const path = envPath || process.env.PASTURE_ENV_PATH || join(process.env.HOME || process.env.USERPROFILE || '.', '.pasture', '.env');
  let raw = '';
  try {
    raw = existsSync(path) ? readFileSync(path, 'utf8') : '';
  } catch (err) {
    return { id, label, ok: false, severity: 'warn', message: `Could not read ${path}: ${err?.message || err}` };
  }
  const slots = ['LLM_1_API_KEY', 'LLM_2_API_KEY', 'LLM_3_API_KEY'];
  const populated = [];
  const empty = [];
  for (const slot of slots) {
    // Important: use [ \t]* (not \s*) around the value so an empty assignment
    // like `LLM_2_API_KEY=` does NOT greedily match the newline + the next
    // line's contents. \s matches \n, which would make `LLM_2_API_KEY=` look
    // populated by capturing the following `LLM_3_API_KEY=` line.
    const re = new RegExp('^[ \\t]*' + slot + '[ \\t]*=[ \\t]*([^\\r\\n]*)$', 'm');
    const m = raw.match(re);
    const value = m ? m[1].trim().replace(/^["']|["']$/g, '') : '';
    if (value) populated.push(slot);
    else empty.push(slot);
  }
  let configuredAuth = [];
  try {
    const cfgRaw = existsSync(getConfigPath()) ? readFileSync(getConfigPath(), 'utf8') : '';
    const cfg = cfgRaw && cfgRaw.trim() ? JSON.parse(cfgRaw) : {};
    const models = Array.isArray(cfg?.llm?.models) ? cfg.llm.models : [];
    configuredAuth = models
      .map((entry, index) => ({ entry, index, auth: normalizeLlmAuth(entry, index) }))
      .filter(({ entry }) => !/127\.0\.0\.1|localhost/i.test(entry?.baseUrl || ''))
      .map(({ entry, auth }) => getLlmAuthStatus(auth, entry))
      .filter((status) => status.configured);
  } catch (_) {}

  if (populated.length === 0 && configuredAuth.length === 0) {
    return {
      id,
      label,
      ok: false,
      severity: 'warn',
      message: `No cloud LLM auth configured in ${path} or config.json.`,
      hint: 'Configure an LLM auth entry, such as auth.type=oauth/bearer_token/api_key, so the daemon has a usable cloud model.',
    };
  }
  if (configuredAuth.length > 0 && populated.length === 0) {
    return {
      id,
      label,
      ok: true,
      severity: 'info',
      message: `OK (${configuredAuth.length} configured cloud auth entr${configuredAuth.length === 1 ? 'y' : 'ies'}).`,
    };
  }
  if (populated.length === 1) {
    return {
      id,
      label,
      ok: true,
      severity: 'warn',
      message: `Only ${populated[0]} is set; ${empty.join(', ')} are empty.`,
      hint: 'Add at least one backup cloud key so the daemon does not drop to a local model when the primary hits its daily cap.',
    };
  }
  return {
    id,
    label,
    ok: true,
    severity: 'info',
    message: `OK (${populated.length} key${populated.length === 1 ? '' : 's'}: ${populated.join(', ')}).`,
  };
}

/**
 * Best-effort report of which Playwright revision is installed in node_modules.
 * Purely informational — useful when debugging "the binary is at rev X but
 * Playwright wants rev Y" mismatches.
 *
 * @param {{ installDir?: string }} [opts]
 * @returns {CheckResult}
 */
export function checkPlaywrightVersion({ installDir } = {}) {
  const id = 'playwright-version';
  const label = 'Playwright version';
  const root = installDir || join(__dirname, '..', '..');
  const candidates = [
    join(root, 'node_modules', 'playwright', 'package.json'),
    join(root, 'node_modules', 'playwright-core', 'package.json'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8'));
      return {
        id,
        label,
        ok: true,
        severity: 'info',
        message: `${pkg.name}@${pkg.version}`,
      };
    } catch (_) {}
  }
  return {
    id,
    label,
    ok: false,
    severity: 'warn',
    message: 'playwright not found in node_modules (skipping version check).',
  };
}

/**
 * Run all preflight checks. Order matters — version is reported first as
 * context for the chromium check.
 *
 * @param {{ installDir?: string, envPath?: string }} [opts]
 * @returns {Promise<{ results: CheckResult[], hasFatal: boolean }>}
 */
export async function runPreflight(opts = {}) {
  const results = [];
  results.push(checkPlaywrightVersion(opts));
  results.push(await checkPlaywrightChromium());
  results.push(checkLlmKeys(opts));
  const hasFatal = results.some((r) => !r.ok && r.severity === 'fatal');
  return { results, hasFatal };
}

/**
 * Pretty-print a single check result. Returns a plain string, no ANSI.
 * @param {CheckResult} r
 */
export function formatCheckResult(r) {
  const mark = r.ok ? 'OK ' : (r.severity === 'fatal' ? 'FAIL' : 'WARN');
  const head = `  [${mark}] ${r.label}: ${r.message}`;
  const hint = r.hint ? `\n         hint: ${r.hint}` : '';
  return head + hint;
}
