/**
 * Skip E2E suites when optional external setup is missing (exit 0, not fail).
 */

/**
 * @param {string} suiteName
 * @param {() => string | null | undefined | false} check - return skip reason or falsy to run
 */
export function skipSuiteIf(suiteName, check) {
  const reason = check();
  if (reason) {
    console.log(`SKIP ${suiteName}: ${reason}`);
    process.exit(0);
  }
}

export function hasEnv(name) {
  return Boolean(process.env[name] && String(process.env[name]).trim());
}
