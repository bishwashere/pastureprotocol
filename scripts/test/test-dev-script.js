#!/usr/bin/env node
/**
 * pnpm dev must refuse to run and print how to start Pasture instead.
 */
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const cases = [
  {
    name: 'package.json dev script points to dev-block.js',
    input: 'package.json scripts.dev',
    run: () => {
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
      const dev = pkg.scripts?.dev || '';
      if (!dev.includes('dev-block.js')) {
        throw new Error(`expected dev-block.js in scripts.dev, got: ${dev}`);
      }
      return dev;
    },
  },
  {
    name: 'pnpm dev exits non-zero and lists run commands',
    input: 'node scripts/dev-block.js',
    run: () => {
      const result = spawnSync(process.execPath, ['scripts/dev-block.js'], {
        cwd: ROOT,
        encoding: 'utf8',
      });
      const out = (result.stdout || '') + (result.stderr || '');
      if (result.status === 0) throw new Error('dev-block.js must exit non-zero');
      const required = [
        'pnpm dev is not available',
        'pnpm install',
        'node setup.js',
        'pnpm start',
        'pnpm run dashboard',
        'pasture start',
        'pasture dashboard',
      ];
      for (const line of required) {
        if (!out.includes(line)) throw new Error(`missing output line: ${line}`);
      }
      return `exit ${result.status}, ${required.length} hints present`;
    },
  },
];

let failed = 0;
console.log('| Test | Input | Output | Status |');
console.log('|------|-------|--------|--------|');
for (const c of cases) {
  let status = '✅ Pass';
  let output = '';
  try {
    output = String(c.run());
  } catch (err) {
    status = '❌ Fail';
    output = err?.message || String(err);
    failed++;
  }
  console.log(`| ${c.name} | ${c.input} | ${output.replace(/\|/g, '\\|')} | ${status} |`);
}
if (failed) process.exit(1);
