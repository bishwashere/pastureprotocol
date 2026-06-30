#!/usr/bin/env node
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { classifyTurnIntent } from '../../../../lib/agent/turn-intent.js';
import { routeTurn } from '../../../../lib/agent/turn-router.js';
import { loadPrompt } from '../../../../lib/agent/md-llm.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..', '..', '..', '..');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const WEATHER_PHRASES = [
  'Hows the weather today',
  'Is it going to rain today?',
  'What should I wear outside this morning?',
  'weather please',
  'Do I need an umbrella today?',
  'How hot will it get today?',
  'Can I go for a walk now or is it stormy?',
];

const SKILLS = [
  { id: 'search', description: 'Search the web for current, live, or recent information including weather.' },
  { id: 'memory', description: 'Read or write saved memory.' },
  { id: 'me', description: 'Read the user profile.' },
];

async function main() {
  const soul = readFileSync(join(ROOT, 'workspace-default', 'SOUL.md'), 'utf8');
  const searchSkill = readFileSync(join(ROOT, 'skills', 'search', 'SKILL.md'), 'utf8');
  const turnPrompt = loadPrompt('turn-intent-classifier');
  const plannerPrompt = loadPrompt('turn-router');

  assert(soul.includes('Give the useful answer first'), 'SOUL says to answer first for location-sensitive live requests');
  assert(soul.includes('Be concise. Say what matters, then stop.'), 'SOUL keeps replies compact');
  assert(searchSkill.includes('Search and answer for that location first'), 'search skill says to use default location and answer first');
  assert(turnPrompt.includes('answer before asking any follow-up'), 'turn intent prompt requires answer before follow-up');
  assert(plannerPrompt.includes('answer first'), 'turn router prompt requires answer first');

  for (const phrase of WEATHER_PHRASES) {
    let turnMessages = null;
    const turn = await classifyTurnIntent({
      userText: phrase,
      availableSkillIds: SKILLS.map((s) => s.id),
      availableSkillSummaries: SKILLS,
      llmChat: async (messages) => {
        turnMessages = messages;
        return JSON.stringify({
          message_kind: 'task',
          session_action: 'none',
          reply_mode_action: 'none',
          work_mode_action: 'none',
          should_use_tools: true,
          candidate_skills: ['search'],
          project_or_mission_intent: 'none',
          github_source_intent: false,
          confidence: 0.95,
          reason: 'Weather or local outdoor conditions are live information.',
        });
      },
    });
    assert(turn.message_kind === 'task', `${phrase}: classifier treats weather as a task`);
    assert(turn.should_use_tools === true, `${phrase}: classifier requires tools`);
    assert(turn.candidate_skills.join(',') === 'search', `${phrase}: classifier routes to search`);
    assert(turnMessages?.[0]?.content.includes('answer before asking any follow-up'), `${phrase}: classifier prompt carries answer-first rule`);
    assert(turnMessages?.[1]?.content.includes(phrase), `${phrase}: classifier sees the exact user phrasing`);

    let plannerMessages = null;
    const plan = await routeTurn({
      userText: phrase,
      availableSkillIds: SKILLS.map((s) => s.id),
      availableSkillSummaries: SKILLS,
      llmChat: async (messages) => {
        plannerMessages = messages;
        return JSON.stringify({
          mode: 'tool',
          skills: ['search'],
          executionMode: 'tool_use',
          usesExistingWorkIntake: false,
          plan: 'Search weather for the best known default location and answer compactly before asking any correction follow-up.',
          answer_style: 'short',
        });
      },
    });
    assert(plan.mode === 'tool', `${phrase}: planner chooses tool mode`);
    assert(plan.skills.join(',') === 'search', `${phrase}: planner routes to search`);
    assert(plan.answer_style === 'short', `${phrase}: planner requests short answer style`);
    assert(/answer compactly before asking/i.test(plan.plan), `${phrase}: planner expects compact answer before follow-up`);
    assert(plannerMessages?.[0]?.content.includes('answer first'), `${phrase}: planner prompt carries answer-first rule`);
    assert(plannerMessages?.[1]?.content.includes(phrase), `${phrase}: planner sees the exact user phrasing`);
  }

  console.log(`weather answer policy tests passed (${WEATHER_PHRASES.length} phrasings)`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
