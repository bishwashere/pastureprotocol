#!/usr/bin/env node
/**
 * Unit tests for intent-planner routing with skill summaries.
 *
 * Verifies that planIntent() selects the correct skill based on meaning
 * (via descriptions), not just skill names. Key regression: a filesystem
 * query ("check a folder on my computer") must route to go-read, NOT browse.
 */

import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

dotenv.config({ path: join(homedir(), '.pasture', '.env') });

const { planIntent } = await import('../../lib/intent-planner.js');
const { getEnabledSkillSummaries } = await import('../../skills/loader.js');

const TIMEOUT_MS = 30_000;

const SKILL_SUMMARIES = getEnabledSkillSummaries();

/** @type {Array<{ label: string, message: string, expectSkill?: string, expectMode?: string, forbidSkill?: string }>} */
const CASES = [
  {
    label: 'Filesystem query → go-read (regression)',
    message: 'Can you check in my computer a folder called main projects?',
    expectSkill: 'go-read',
    forbidSkill: 'browse',
  },
  {
    label: 'List directory → go-read',
    message: 'List the files in my Downloads folder.',
    expectSkill: 'go-read',
  },
  {
    label: 'Web browsing → browse',
    message: 'Open slickdeals.net and show me the top deals.',
    expectSkill: 'browse',
    forbidSkill: 'go-read',
  },
  {
    label: 'Web search → search',
    message: 'What are the latest Node.js release notes?',
    expectSkill: 'search',
  },
  {
    label: 'Plain greeting → chat, no tools',
    message: 'Hi',
    expectMode: 'chat',
    expectNoSkills: true,
  },
];

function timeout(ms) {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
  );
}

async function runCase(tc) {
  const plan = await Promise.race([
    planIntent({
      userText: tc.message,
      availableSkillIds: SKILL_SUMMARIES.map((s) => s.id),
      availableSkillSummaries: SKILL_SUMMARIES,
    }),
    timeout(TIMEOUT_MS),
  ]);

  if (!plan) throw new Error('planIntent returned null');

  if (tc.expectMode && plan.mode !== tc.expectMode) {
    throw new Error(`Expected mode="${tc.expectMode}" but got "${plan.mode}". Plan: ${JSON.stringify(plan)}`);
  }
  if (tc.expectSkill && !plan.skills.includes(tc.expectSkill)) {
    throw new Error(
      `Expected skill "${tc.expectSkill}" in [${plan.skills.join(', ')}]. Plan: ${JSON.stringify(plan)}`
    );
  }
  if (tc.forbidSkill && plan.skills.includes(tc.forbidSkill)) {
    throw new Error(
      `Skill "${tc.forbidSkill}" should NOT be selected, but was. Skills: [${plan.skills.join(', ')}]. Plan: ${JSON.stringify(plan)}`
    );
  }
  if (tc.expectNoSkills && plan.skills.length > 0) {
    throw new Error(`Expected no skills but got [${plan.skills.join(', ')}]. Plan: ${JSON.stringify(plan)}`);
  }
  return plan;
}

async function main() {
  console.log('Intent planner routing tests (with skill summaries)\n');

  const rows = [];
  let failed = 0;

  for (const tc of CASES) {
    process.stdout.write(`  ${tc.label} … `);
    try {
      const plan = await runCase(tc);
      console.log(`✅  mode=${plan.mode} skills=[${plan.skills.join(', ')}]`);
      rows.push({ test: tc.label, result: '✅ Pass', detail: `mode=${plan.mode} skills=[${plan.skills.join(', ')}]` });
    } catch (err) {
      console.log(`❌  ${err.message}`);
      rows.push({ test: tc.label, result: '❌ Fail', detail: err.message });
      failed++;
    }
  }

  console.log('\n--- Results ---');
  console.log(
    `${'Test'.padEnd(50)} ${'Result'.padEnd(10)} Detail`
  );
  console.log('-'.repeat(120));
  for (const r of rows) {
    console.log(`${r.test.padEnd(50)} ${r.result.padEnd(10)} ${r.detail}`);
  }
  console.log();
  console.log(`${CASES.length - failed}/${CASES.length} passed.`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
