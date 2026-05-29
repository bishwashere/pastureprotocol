/**
 * Tests for skill install onboarding (cowcode add).
 */

import { mkdtempSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import {
  normalizeSkillId,
  getSkillsToEnable,
  runSkillInstall,
} from '../../lib/skill-install.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

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

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

console.log('\nSkill install tests\n');

test('normalizeSkillId maps google alias to gog', () => {
  if (normalizeSkillId('google') !== 'gog') throw new Error('expected gog');
});

test('getSkillsToEnable bundles google into gog+gmail+calendar', () => {
  const list = getSkillsToEnable('google', 'gog');
  if (!list.includes('gog') || !list.includes('gmail') || !list.includes('calendar')) {
    throw new Error(`expected full google bundle, got ${list.join(',')}`);
  }
});

test('getSkillsToEnable keeps github as single skill', () => {
  const list = getSkillsToEnable('github', 'github');
  if (list.length !== 1 || list[0] !== 'github') throw new Error('expected github only');
});

await testAsync('runSkillInstall saves GitHub token to secrets.json', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-skill-install-'));
  const prev = process.env.COWCODE_STATE_DIR;
  process.env.COWCODE_STATE_DIR = stateDir;
  try {
    const result = await runSkillInstall('github', ROOT, {
      ask: async () => 'bishwashere/cowCode',
      promptSecret: async () => 'ghp_test_token_for_install',
    });
    if (!result.ok) throw new Error(result.message);
    const secretsPath = join(stateDir, 'secrets.json');
    if (!existsSync(secretsPath)) throw new Error('secrets.json not created');
    const secrets = JSON.parse(readFileSync(secretsPath, 'utf8'));
    if (secrets.github?.token !== 'ghp_test_token_for_install') {
      throw new Error('token not saved in secrets.json');
    }
    const config = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'));
    if (!config.skills.enabled.includes('github')) throw new Error('github not enabled');
    if (config.skills.github.defaultRepo !== 'bishwashere/cowCode') {
      throw new Error('defaultRepo not saved');
    }
  } finally {
    process.env.COWCODE_STATE_DIR = prev || '';
  }
});

await testAsync('runSkillInstall saves Brave key to .env for search', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'cowcode-skill-install-'));
  const prev = process.env.COWCODE_STATE_DIR;
  process.env.COWCODE_STATE_DIR = stateDir;
  try {
    const result = await runSkillInstall('search', ROOT, {
      ask: async () => '',
      promptSecret: async (_p, existing) => existing || 'BSA_test_brave_key',
    });
    if (!result.ok) throw new Error(result.message);
    const envPath = join(stateDir, '.env');
    if (!existsSync(envPath)) throw new Error('.env not created');
    const envText = readFileSync(envPath, 'utf8');
    if (!envText.includes('BRAVE_API_KEY=BSA_test_brave_key')) {
      throw new Error('BRAVE_API_KEY not in .env');
    }
    const config = JSON.parse(readFileSync(join(stateDir, 'config.json'), 'utf8'));
    if (!config.skills.enabled.includes('search')) throw new Error('search not enabled');
    if (config.skills.search.apiKey !== 'BRAVE_API_KEY') throw new Error('search apiKey ref missing');
  } finally {
    process.env.COWCODE_STATE_DIR = prev || '';
  }
});

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
