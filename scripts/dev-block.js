#!/usr/bin/env node
/**
 * Pasture Protocol has no dev server. This script explains how to run the project instead.
 */

console.error('');
console.error('pnpm dev is not available for Pasture Protocol.');
console.error('');
console.error('Pasture runs as a local daemon plus an optional dashboard — there is no watch/dev server.');
console.error('');
console.error('From a git clone:');
console.error('  pnpm install');
console.error('  node setup.js              # interactive onboarding (or: pasture setup)');
console.error('  pnpm start                 # start the bot (or: pasture start)');
console.error('  pnpm run dashboard         # web UI at http://127.0.0.1:3847 (or: pasture dashboard)');
console.error('  pnpm run auth              # WhatsApp QR/pairing (or: pasture auth)');
console.error('');
console.error('After install (pasture CLI):');
console.error('  pasture start');
console.error('  pasture dashboard');
console.error('  pasture status | stop | restart | logs');
console.error('  pasture update | uninstall');
console.error('');
console.error('Tests:');
console.error('  pnpm run test:all');
console.error('');

process.exit(1);
