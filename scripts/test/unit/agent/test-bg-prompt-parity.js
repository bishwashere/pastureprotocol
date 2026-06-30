#!/usr/bin/env node
/**
 * Audit finding #24: background-task turns previously had a far thinner
 * system prompt than the main chat or internal-agent-turn. They missed
 * team roster, missions, projects/workflow, and retrospective lessons.
 * That meant background work behaved as if the agent had no team and no
 * existing world model.
 *
 * Now runBackgroundAgentTurn must build the same blocks (modulo the
 * channel-only ones: session bootstrap and pair history have no meaning
 * outside an interactive turn).
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const bg = readFileSync(join(root, 'lib/agent/background-tasks.js'), 'utf8');

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { console.log(`[PASS] ${name}`); passed++; }
  else { console.log(`[FAIL] ${name}${detail ? ' :: ' + detail : ''}`); failed++; }
}

check(
  'imports buildAgentTeamPromptBlock',
  /import\s*\{\s*buildAgentTeamPromptBlock\s*\}\s*from\s*['"]\.\/agent-config\.js['"]/.test(bg)
);
check(
  'imports buildMissionsContextBlock',
  /import\s*\{\s*buildMissionsContextBlock\s*\}\s*from\s*['"]\.\.\/context\/missions-context\.js['"]/.test(bg)
);
check(
  'imports buildProjectsContextBlock',
  /import\s*\{\s*buildProjectsContextBlock\s*\}\s*from\s*['"]\.\.\/context\/projects-context\.js['"]/.test(bg)
);
check(
  'imports buildProjectWorkflowContextBlock',
  /import\s*\{\s*buildProjectWorkflowContextBlock\s*\}\s*from\s*['"]\.\.\/context\/project-workflow\.js['"]/.test(bg)
);
check(
  'imports buildRetrospectiveContextBlock',
  /import\s*\{\s*buildRetrospectiveContextBlock\s*\}\s*from\s*['"]\.\/retrospective\.js['"]/.test(bg)
);
check(
  'baseSystemPrompt now includes buildAgentTeamPromptBlock',
  /buildOneOnOneSystemPrompt\(ctx\.workspaceDir\)\s*\+\s*buildAgentTeamPromptBlock\(agentId\)/.test(bg)
);
check(
  'task-mode prompt appends retrospective block',
  /buildRetrospectiveContextBlock\(prompt,\s*memoryConfig\)[\s\S]{0,200}?systemPrompt\s*\+=\s*retroBlock/.test(bg)
);
check(
  'task-mode prompt appends missions block',
  /buildMissionsContextBlock\(\{\s*userText:\s*prompt[\s\S]{0,200}?systemPrompt\s*\+=\s*missionsBlock/.test(bg)
);
check(
  'task-mode prompt appends projects block',
  /buildProjectsContextBlock\(\{\s*userText:\s*prompt[\s\S]{0,200}?systemPrompt\s*\+=\s*projectsBlock/.test(bg)
);
check(
  'task-mode prompt appends project-workflow block',
  /buildProjectWorkflowContextBlock\(\{\s*userText:\s*prompt[\s\S]{0,200}?systemPrompt\s*\+=\s*workflowBlock/.test(bg)
);
check(
  'context blocks gated on !isNonTaskMessage(prompt) (skips for casual)',
  /if\s*\(!isNonTaskMessage\(prompt\)\)\s*\{/.test(bg)
);
check(
  'comment cites audit finding #24',
  /audit\s+finding\s+#24/i.test(bg)
);

console.log(`\n[bg-prompt-parity] passed=${passed} failed=${failed}`);
process.exit(failed === 0 ? 0 : 1);
