#!/usr/bin/env node
/**
 * Audit finding #10: the completeness-retry tool-dispatch path used to skip
 * skill_start / skill_done / logTiming hooks and the full-skill-doc dedupe.
 * Retried tool calls were invisible to team activity, metrics, and the doc
 * cache. Now the retry path emits the same observability the main loop does.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const agent = readFileSync(join(root, 'lib/agent/agent.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.log(`[FAIL] ${name}${detail ? ' :: ' + detail : ''}`);
    failed++;
  }
}

// Locate the completeness-retry block by its anchor purpose tag.
const retryBlockMatch = agent.match(
  /agent_turn_completeness_retry_r\$\{cr\}[\s\S]*?agent_turn_completeness_synthesis_r\$\{cr\}/
);
check('completeness-retry block found in agent.js', !!retryBlockMatch);
const block = retryBlockMatch ? retryBlockMatch[0] : '';

check('retry calls onAgentSkillStart per tool call', /onAgentSkillStart\(\{\s*agentId:\s*currentAgentId,\s*skillId:\s*tcSkillId/.test(block));
check('retry pushes skillsCalled', /skillsCalled\.push\(tcSkillId\)/.test(block));
check('retry runs parseSkillResult on result', /parseSkillResult\(tcResult\)/.test(block));
check('retry logTeamActivity with skill_done | skill_error', /type:\s*tcRetryIsError\s*\?\s*['"]skill_error['"]\s*:\s*['"]skill_done['"]/.test(block));
check('retry logTiming emits completenessRetry: true detail', /completenessRetry:\s*true/.test(block));
check('retry calls onAgentSkillError on failure', /tcRetryIsError[\s\S]{0,200}?onAgentSkillError\(/.test(block));
check('retry sets lastToolError on failure', /lastToolError\s*=\s*skillErrMsg/.test(block));
check('retry sets lastRoundHadToolError on failure', /lastRoundHadToolError\s*=\s*true/.test(block));
check('retry tracks lastToolResult on success', /lastToolResult\s*=\s*tcResult/.test(block));
check('retry tracks write ops for post-write verification', /isWriteToolCall\(tcSkillId,\s*tc\.name\)/.test(block) && /writtenDirs\.add\(d\)/.test(block));
check('retry uses skillDocsInjected dedupe set (same as main loop)', /!skillDocsInjected\.has\(tcSkillId\)[\s\S]{0,300}?skillDocsInjected\.add\(tcSkillId\)/.test(block));
check('Comment cites audit finding #10', /audit\s+finding\s+#10/i.test(agent));

console.log(`\n[completeness-retry-observability] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
