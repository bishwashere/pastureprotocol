#!/usr/bin/env node

export function skipFakeCounterpart(name, realPath) {
  console.log(`[fake-e2e skip] ${name}`);
  console.log(`  Real counterpart: ${realPath}`);
  console.log('  Deterministic fake backend is not implemented for this E2E yet.');
}
