/**
 * E2E expect modes for skill tests.
 *
 * - behavior: LLM judge only — skill routing / polite handling is enough.
 * - actual: judge passed AND hard checks — skill ran and reply is not failure-only;
 *           optional file/reply substring checks via actualChecks.
 *
 * Set on each test object: { expectMode: 'actual', skill: 'search', actualChecks?: {...} }
 * skill-test-runner.js calls assertActualResult after a successful run when expectMode is 'actual'.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

/** @typedef {'behavior' | 'actual'} ExpectMode */

export const ExpectMode = {
  BEHAVIOR: 'behavior',
  ACTUAL: 'actual',
};

/** Reply shapes that usually mean no real data was returned. */
export const FAILURE_ONLY_REPLY_PATTERNS = [
  /\b(couldn'?t|could not|unable to|can't|cannot)\b.{0,50}\b(reach|connect|access|fetch|get|retrieve|load|obtain)\b/i,
  /\b(not configured|no (api )?key|missing (token|credentials|configuration))\b/i,
  /\b(i don'?t have (any )?(information|access|details|data))\b/i,
  /\b(unable to (complete|fulfill|help with|assist))\b/i,
  /\b(having trouble (connecting|reaching|accessing))\b/i,
  /\b(sorry,? i (couldn'?t|could not|wasn'?t able to))\b/i,
];

/**
 * @param {string[]} skillsCalled
 * @param {string | string[]} skillOrSkills
 */
export function assertSkillCalled(skillsCalled, skillOrSkills) {
  const expected = Array.isArray(skillOrSkills) ? skillOrSkills : [skillOrSkills];
  const missing = expected.filter((s) => !skillsCalled.includes(s));
  if (missing.length) {
    throw new Error(
      `Actual-result test requires skill(s) [${missing.join(', ')}] to be called; got [${skillsCalled.join(', ') || 'none'}]`
    );
  }
}

/**
 * @param {string} reply
 * @param {{ minLength?: number }} [opts]
 */
export function assertNotFailureOnlyReply(reply, opts = {}) {
  const minLength = opts.minLength ?? 20;
  if (!reply || reply.trim().length < minLength) {
    throw new Error(`Actual-result test: reply too short or empty (${(reply || '').length} chars)`);
  }
  for (const pattern of FAILURE_ONLY_REPLY_PATTERNS) {
    if (pattern.test(reply)) {
      throw new Error(
        `Actual-result test: reply looks like failure-only, not real data. Reply (first 300): ${reply.slice(0, 300)}`
      );
    }
  }
}

/**
 * @typedef {object} ActualChecks
 * @property {string[]} [replyIncludesAny] - reply must contain at least one substring
 * @property {string} [fileExists] - path relative to stateDir
 * @property {{ path: string, text: string }} [fileContains]
 */

/**
 * @param {{ reply?: string, skillsCalled?: string[], stateDir?: string }} result
 * @param {{ skill?: string | string[], actualChecks?: ActualChecks, stateDir?: string }} testDef
 */
export function assertActualResult(result, testDef) {
  const reply = result?.reply ?? '';
  const skillsCalled = result?.skillsCalled ?? [];
  const stateDir = result?.stateDir || testDef.stateDir;
  const checks = testDef.actualChecks || {};

  if (testDef.skill) {
    assertSkillCalled(skillsCalled, testDef.skill);
  }
  assertNotFailureOnlyReply(reply);

  if (checks.replyIncludesAny?.length) {
    const hit = checks.replyIncludesAny.some((s) => reply.includes(s));
    if (!hit) {
      throw new Error(
        `Actual-result test: reply must include one of [${checks.replyIncludesAny.join(', ')}]. Reply (first 400): ${reply.slice(0, 400)}`
      );
    }
  }

  if (checks.fileExists) {
    if (!stateDir) throw new Error('Actual-result test fileExists check requires stateDir');
    const path = join(stateDir, checks.fileExists);
    if (!existsSync(path)) {
      throw new Error(`Actual-result test: expected file at ${path}`);
    }
  }

  if (checks.fileContains) {
    if (!stateDir) throw new Error('Actual-result test fileContains check requires stateDir');
    const path = join(stateDir, checks.fileContains.path);
    if (!existsSync(path)) {
      throw new Error(`Actual-result test: file missing at ${path}`);
    }
    const content = readFileSync(path, 'utf8');
    if (!content.includes(checks.fileContains.text)) {
      throw new Error(
        `Actual-result test: ${path} must contain "${checks.fileContains.text}"`
      );
    }
  }
}

/**
 * @param {ExpectMode | undefined} mode
 * @returns {string}
 */
export function formatExpectModeLabel(mode) {
  return mode === ExpectMode.ACTUAL ? ' [actual]' : mode === ExpectMode.BEHAVIOR ? ' [behavior]' : '';
}
