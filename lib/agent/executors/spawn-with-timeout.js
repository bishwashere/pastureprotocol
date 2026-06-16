/**
 * Shared helper for executor spawns. Adds a hard kill timer and an output
 * cap to every external CLI call so a stuck OAuth refresh, hung subprocess,
 * or runaway command never freezes the agent's tool loop indefinitely.
 *
 * Replaces ad-hoc `spawn(...)` blocks in gog/gmail/calendar/home-assistant
 * executors that previously had no timeout — see audit finding #12.
 */

import { spawn } from 'child_process';

export const DEFAULT_SPAWN_TIMEOUT_MS = 30_000;
export const DEFAULT_SPAWN_MAX_OUTPUT_CHARS = 16_000;

/**
 * @param {string} cmd
 * @param {string[]} argv
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   stdio?: any,
 *   timeoutMs?: number,
 *   maxOutputChars?: number,
 *   killSignal?: NodeJS.Signals,
 * }} [opts]
 * @returns {Promise<{ ok: boolean, code: number|null, stdout: string, stderr: string, timedOut: boolean, error?: string }>}
 */
export function spawnWithTimeout(cmd, argv = [], opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : DEFAULT_SPAWN_TIMEOUT_MS;
  const maxOutputChars = Number.isFinite(opts.maxOutputChars)
    ? opts.maxOutputChars
    : DEFAULT_SPAWN_MAX_OUTPUT_CHARS;
  const killSignal = opts.killSignal || 'SIGKILL';

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, argv, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: opts.stdio,
      });
    } catch (err) {
      resolve({
        ok: false,
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        error: err?.message || String(err),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill(killSignal);
      } catch (_) {}
      settle({
        ok: false,
        code: null,
        stdout,
        stderr,
        timedOut: true,
        error: `Command timed out after ${Math.round(timeoutMs / 1000)}s.`,
      });
    }, timeoutMs);

    if (child.stdout) {
      child.stdout.setEncoding?.('utf8');
      child.stdout.on('data', (chunk) => {
        if (stdout.length < maxOutputChars) stdout += chunk.toString();
      });
    }
    if (child.stderr) {
      child.stderr.setEncoding?.('utf8');
      child.stderr.on('data', (chunk) => {
        if (stderr.length < maxOutputChars) stderr += chunk.toString();
      });
    }

    child.on('error', (err) => {
      settle({
        ok: false,
        code: null,
        stdout,
        stderr,
        timedOut: false,
        error: err?.message || String(err),
      });
    });

    child.on('close', (code) => {
      if (timedOut) return;
      settle({
        ok: code === 0,
        code,
        stdout,
        stderr,
        timedOut: false,
      });
    });
  });
}

/**
 * Convenience wrapper for "run gog and return the executor-shaped string"
 * pattern shared by gog/gmail/calendar executors. Capped output, normalized
 * `{"error": "..."}` JSON on failure, plain prose on success.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, maxOutputChars?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function runCliAsExecutor(cmd, argv, opts = {}) {
  const maxOutputChars = Number.isFinite(opts.maxOutputChars)
    ? opts.maxOutputChars
    : DEFAULT_SPAWN_MAX_OUTPUT_CHARS;
  const result = await spawnWithTimeout(cmd, argv, opts);
  const truncate = (text) => {
    const s = String(text || '').trim();
    return s.length <= maxOutputChars ? s : s.slice(0, maxOutputChars) + '\n…(truncated)';
  };
  const out = truncate(result.stdout);
  const err = truncate(result.stderr);
  if (result.error && !result.code && !out && !err) {
    return JSON.stringify({ error: result.error });
  }
  if (result.timedOut) {
    return JSON.stringify({ error: result.error || 'Command timed out.' });
  }
  if (result.ok) {
    return out || err || 'OK';
  }
  const message = err || out || `${cmd} exited with code ${result.code}`;
  return JSON.stringify({ error: message });
}
