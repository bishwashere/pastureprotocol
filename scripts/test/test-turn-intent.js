#!/usr/bin/env node
import { classifyTurnIntent, buildCasualPlanFromTurnIntent } from '../../lib/agent/turn-intent.js';
import { loadPrompt } from '../../lib/agent/md-llm.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const prompt = loadPrompt('turn-intent-classifier');
  assert(prompt.includes('project_or_mission_intent'), 'prompt documents project_or_mission_intent');
  assert(prompt.includes('github_source_intent'), 'prompt documents github_source_intent');

  const availableSkillIds = ['github', 'browse', 'memory', 'search'];
  const availableSkillSummaries = availableSkillIds.map((id) => ({ id, description: id }));

  const casual = await classifyTurnIntent({
    userText: 'hi',
    availableSkillIds,
    availableSkillSummaries,
    llmChat: async () => JSON.stringify({
      message_kind: 'casual',
      session_action: 'none',
      reply_mode_action: 'none',
      work_mode_action: 'none',
      should_use_tools: false,
      candidate_skills: [],
      project_or_mission_intent: 'none',
      github_source_intent: false,
      confidence: 0.97,
      reason: 'Greeting.',
    }),
  });
  assert(casual.message_kind === 'casual', 'casual message_kind');
  assert(casual.confidence === 0.97, 'confidence preserved');
  const casualPlan = buildCasualPlanFromTurnIntent(casual);
  assert(casualPlan && casualPlan.mode === 'chat', 'casual plan built');
  assert(casualPlan.skills.length === 0, 'casual plan has no tools');

  const project = await classifyTurnIntent({
    userText: 'find out what this project is about',
    availableSkillIds,
    availableSkillSummaries,
    llmChat: async () => JSON.stringify({
      message_kind: 'task',
      session_action: 'none',
      reply_mode_action: 'none',
      work_mode_action: 'none',
      should_use_tools: true,
      candidate_skills: ['browse', 'github', 'not-a-skill'],
      project_or_mission_intent: 'discover',
      github_source_intent: false,
      confidence: 1.7,
      reason: 'Investigate project.',
    }),
  });
  assert(project.project_or_mission_intent === 'discover', 'project intent');
  assert(project.should_use_tools === true, 'should_use_tools true');
  assert(project.candidate_skills.join(',') === 'browse,github', 'filters unknown skills');
  assert(project.confidence === 1, 'confidence clamps high values');

  const invalid = await classifyTurnIntent({
    userText: 'whatever',
    availableSkillIds,
    llmChat: async () => JSON.stringify({
      message_kind: 'banana',
      session_action: 'reset',
      reply_mode_action: 'audio',
      work_mode_action: 'team',
      should_use_tools: 'yes',
      candidate_skills: ['github'],
      project_or_mission_intent: 'mystery',
      github_source_intent: 'true',
      confidence: -2,
      reason: 'x'.repeat(300),
    }),
  });
  assert(invalid.message_kind === 'task', 'invalid message_kind falls back to task');
  assert(invalid.session_action === 'none', 'invalid session_action fallback');
  assert(invalid.reply_mode_action === 'none', 'invalid reply mode fallback');
  assert(invalid.work_mode_action === 'none', 'invalid work mode fallback');
  assert(invalid.project_or_mission_intent === 'none', 'invalid project intent fallback');
  assert(invalid.github_source_intent === false, 'boolean must be real boolean');
  assert(invalid.confidence === 0, 'confidence clamps low values');
  assert(invalid.reason.length === 240, 'reason capped');

  const malformed = await classifyTurnIntent({
    userText: 'hello',
    availableSkillIds,
    llmChat: async () => 'not json',
  });
  assert(malformed === null, 'malformed JSON returns null');

  const thrown = await classifyTurnIntent({
    userText: 'hello',
    availableSkillIds,
    llmChat: async () => { throw new Error('LLM down'); },
  });
  assert(thrown === null, 'LLM throw returns null');

  console.log('turn-intent tests passed');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
