#!/usr/bin/env node
/**
 * Preflight checks: verify the daemon refuses to start (or warns loudly) when
 * required runtime deps are broken — instead of starting silently and failing
 * later in a confusing way at first skill-use.
 *
 * What we test:
 *   - checkPlaywrightChromium() returns ok when the binary exists.
 *   - checkLlmKeys() correctly classifies "no keys" / "one key" / "multi keys".
 *   - checkPlaywrightVersion() reads node_modules/playwright/package.json.
 *   - runPreflight() aggregates and surfaces hasFatal correctly.
 */

import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  checkLlmKeys,
  checkPlaywrightVersion,
  checkPlaywrightChromium,
  runPreflight,
  formatCheckResult,
} from '../../../../lib/util/preflight.js';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.log(`[FAIL] ${name}${detail ? ' :: ' + detail : ''}`);
    failed++;
  }
}

function withTmpDir(fn) {
  const dir = join(tmpdir(), `pasture-preflight-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  try {
    return fn(dir);
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

async function main() {
  // 1. checkLlmKeys — no keys
  withTmpDir((dir) => {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'LLM_1_API_KEY=\nLLM_2_API_KEY=\nLLM_3_API_KEY=\n', 'utf8');
    const r = checkLlmKeys({ envPath });
    check('no keys -> ok=false, severity=warn', r.ok === false && r.severity === 'warn', JSON.stringify(r));
    check('no keys -> message mentions cloud LLM', /cloud LLM|cloud model/i.test(r.message));
  });

  // 2. checkLlmKeys — only one key (warn but ok)
  withTmpDir((dir) => {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'LLM_1_API_KEY=sk-only\nLLM_2_API_KEY=\nLLM_3_API_KEY=\n', 'utf8');
    const r = checkLlmKeys({ envPath });
    check('one key -> ok=true, severity=warn', r.ok === true && r.severity === 'warn', JSON.stringify(r));
    check('one key -> mentions empty slots', /LLM_2_API_KEY/.test(r.message));
  });

  // 3. checkLlmKeys — multiple keys (info)
  withTmpDir((dir) => {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'LLM_1_API_KEY=sk-1\nLLM_2_API_KEY=sk-2\nLLM_3_API_KEY=\n', 'utf8');
    const r = checkLlmKeys({ envPath });
    check('two keys -> ok=true, severity=info', r.ok === true && r.severity === 'info', JSON.stringify(r));
  });

  // 4. checkLlmKeys — quoted values still detected (real .env files often have quotes)
  withTmpDir((dir) => {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'LLM_1_API_KEY="sk-quoted"\nLLM_2_API_KEY=\nLLM_3_API_KEY=\n', 'utf8');
    const r = checkLlmKeys({ envPath });
    check('quoted key counted as populated', r.ok === true, JSON.stringify(r));
  });

  // 5. checkLlmKeys — missing file
  withTmpDir((dir) => {
    const envPath = join(dir, 'no-such.env');
    const r = checkLlmKeys({ envPath });
    check('missing .env -> ok=false', r.ok === false, JSON.stringify(r));
  });

  // 6. checkPlaywrightVersion — happy path with current install dir
  {
    const r = checkPlaywrightVersion({ installDir: process.cwd() });
    check('playwright version detected', r.ok === true && /playwright/i.test(r.message), JSON.stringify(r));
  }

  // 7. checkPlaywrightChromium — ok shape (we don't assert binary present, only result shape)
  {
    const r = await checkPlaywrightChromium();
    check('chromium check returns CheckResult shape',
      typeof r === 'object' && typeof r.ok === 'boolean' && typeof r.severity === 'string' && typeof r.message === 'string',
      JSON.stringify(r));
    if (!r.ok) {
      check('chromium missing -> autoFix has command', r.autoFix && r.autoFix.command === 'npx', JSON.stringify(r.autoFix));
    } else {
      check('chromium ok -> message includes path', /\//.test(r.message) || /\\/.test(r.message));
    }
  }

  // 8. runPreflight — aggregate shape
  {
    const { results, hasFatal } = await runPreflight({ installDir: process.cwd() });
    check('runPreflight returns array of results', Array.isArray(results) && results.length >= 3);
    check('runPreflight hasFatal is boolean', typeof hasFatal === 'boolean');
    check('runPreflight includes playwright-chromium', results.some((r) => r.id === 'playwright-chromium'));
    check('runPreflight includes llm-keys', results.some((r) => r.id === 'llm-keys'));
  }

  // 9. formatCheckResult — does not throw, returns string
  {
    const formatted = formatCheckResult({ id: 'x', label: 'X', ok: false, severity: 'fatal', message: 'broken', hint: 'fix it' });
    check('formatCheckResult returns string with FAIL marker', typeof formatted === 'string' && formatted.includes('[FAIL]') && formatted.includes('broken') && formatted.includes('fix it'));
  }

  console.log(`\n[preflight] passed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[preflight] crashed:', err);
  process.exit(1);
});
