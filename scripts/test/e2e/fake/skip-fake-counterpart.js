#!/usr/bin/env node

export function skipFakeCounterpart(name, realPath) {
  console.error(`[fake-e2e missing] ${name}`);
  console.log(`  Real counterpart: ${realPath}`);
  console.log('  Deterministic fake backend is not implemented for this E2E yet.');
  console.log('  Fake E2E counterparts must be real tests, not passing placeholders.');
  process.exitCode = 1;
}
