/**
 * Unit tests for interactive CLI banner (setup / skills).
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  CLI_BANNER,
  shouldShowCliBanner,
  shouldBannerAtCliEntry,
  beginCliSession,
  endCliSession,
  isCliSessionActive,
  envForNestedCliCall,
} from '../../../../lib/util/cli-banner.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

console.log('\nCLI banner tests\n');

test('CLI_BANNER includes PASTURE art and PROTOCOL subtitle', () => {
  if (!CLI_BANNER.includes('██████╗')) throw new Error('missing PASTURE block letters');
  if (!CLI_BANNER.includes('P R O T O C O L')) throw new Error('missing PROTOCOL subtitle');
  if (!CLI_BANNER.includes('Agent ↔ Delegation ↔ State ↔ Autonomy')) {
    throw new Error('missing tagline');
  }
});

test('shouldShowCliBanner false when tests inject ask', () => {
  if (shouldShowCliBanner({ ask: async () => 'q' })) throw new Error('expected false with ask');
});

test('shouldShowCliBanner false when PASTURE_NO_BANNER=1', () => {
  const prev = process.env.PASTURE_NO_BANNER;
  process.env.PASTURE_NO_BANNER = '1';
  try {
    if (shouldShowCliBanner()) throw new Error('expected false with PASTURE_NO_BANNER');
  } finally {
    if (prev === undefined) delete process.env.PASTURE_NO_BANNER;
    else process.env.PASTURE_NO_BANNER = prev;
  }
});

test('shouldBannerAtCliEntry covers logs and skips subprocess entry points', () => {
  if (!shouldBannerAtCliEntry('logs', [])) throw new Error('logs should banner in cli.js');
  if (shouldBannerAtCliEntry('setup', [])) throw new Error('setup is subprocess-owned');
  if (shouldBannerAtCliEntry('auth', [])) throw new Error('auth is subprocess-owned');
  if (shouldBannerAtCliEntry('tide', [])) throw new Error('tide is subprocess-owned');
  if (shouldBannerAtCliEntry('index', [])) throw new Error('index is subprocess-owned');
  if (shouldBannerAtCliEntry('skills', [])) throw new Error('skills wizard is menu-owned');
  if (!shouldBannerAtCliEntry('skills', ['skills', 'list'])) throw new Error('skills list should banner');
  if (!shouldBannerAtCliEntry('start', [])) throw new Error('start should banner');
});

test('session helpers track active state without printing when not TTY', () => {
  endCliSession();
  if (isCliSessionActive()) throw new Error('expected inactive after end');
  beginCliSession();
  endCliSession();
  if (isCliSessionActive()) throw new Error('expected inactive after endCliSession');
});

test('beginCliSession prints banner at most once per session', () => {
  endCliSession();
  let prints = 0;
  const origLog = console.log;
  console.log = (...args) => {
    if (args[0] === CLI_BANNER) prints++;
    origLog(...args);
  };
  const prevNoBanner = process.env.PASTURE_NO_BANNER;
  const prevIsTTY = process.stdout.isTTY;
  delete process.env.PASTURE_NO_BANNER;
  process.stdout.isTTY = true;
  try {
    beginCliSession();
    beginCliSession();
    beginCliSession();
    if (prints !== 1) throw new Error(`expected 1 banner print, got ${prints}`);
    if (!isCliSessionActive()) throw new Error('expected active session after beginCliSession');
  } finally {
    console.log = origLog;
    endCliSession();
    if (prevNoBanner === undefined) delete process.env.PASTURE_NO_BANNER;
    else process.env.PASTURE_NO_BANNER = prevNoBanner;
    process.stdout.isTTY = prevIsTTY;
  }
});

test('skills wizard does not refresh banner on each menu turn', () => {
  const src = readFileSync(join(ROOT, 'lib/util/skill-install.js'), 'utf8');
  const fn = src.slice(src.indexOf('export async function runSkillsWizard'));
  const loopStart = fn.indexOf('while (true)');
  const beforeLoop = fn.slice(0, loopStart);
  const loopEnd = fn.indexOf('endCliSession();', loopStart);
  const loopBody = fn.slice(loopStart, loopEnd);
  if (!beforeLoop.includes('beginCliSession(deps)')) {
    throw new Error('beginCliSession must run once before the menu loop');
  }
  if (/refreshCliBanner|beginCliSession|printCliBanner/.test(loopBody)) {
    throw new Error('banner must not refresh inside the skills wizard menu loop');
  }
});

test('envForNestedCliCall suppresses banner on nested cli.js spawns', () => {
  const env = envForNestedCliCall({ FOO: 'bar' });
  if (env.PASTURE_NO_BANNER !== '1') throw new Error('expected PASTURE_NO_BANNER=1');
  if (env.FOO !== 'bar') throw new Error('expected base env preserved');
  const prev = process.env.PASTURE_NO_BANNER;
  process.env.PASTURE_NO_BANNER = '1';
  try {
    if (shouldShowCliBanner()) throw new Error('nested env should suppress banner');
  } finally {
    if (prev === undefined) delete process.env.PASTURE_NO_BANNER;
    else process.env.PASTURE_NO_BANNER = prev;
  }
});

test('post-update dashboard spawn suppresses nested CLI banner', () => {
  const src = readFileSync(join(ROOT, 'cli.js'), 'utf8');
  if (!src.includes('envForNestedCliCall')) {
    throw new Error('cli.js must use envForNestedCliCall for nested dashboard spawn');
  }
  const fn = src.slice(src.indexOf('function runPostUpdateRestartAndDashboard'));
  const fnBody = fn.slice(0, fn.indexOf('\n}', fn.indexOf('dashboard')));
  if (!/envForNestedCliCall[\s\S]*dashboard/.test(fnBody)) {
    throw new Error('runPostUpdateRestartAndDashboard must pass envForNestedCliCall to dashboard spawn');
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
