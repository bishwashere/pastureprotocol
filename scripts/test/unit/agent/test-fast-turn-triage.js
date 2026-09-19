#!/usr/bin/env node

import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-fast-triage-test-'));
  mkdirSync(join(stateDir, 'workspace'), { recursive: true });
  writeFileSync(join(stateDir, 'config.json'), JSON.stringify({ agents: { defaults: {} } }), 'utf8');
  process.env.PASTURE_STATE_DIR = stateDir;

  const { loadPrompt } = await import('../../../../lib/agent/md-llm.js');
  const { fastTriageToTurnRoute, planFastTurnTriage } = await import('../../../../lib/agent/fast-turn-triage.js');
  const { getActiveTaskFrame, upsertTaskFrame } = await import('../../../../lib/context/task-frame.js');

  const prompt = loadPrompt('fast-turn-triage');
  assert(prompt.includes('existing_pipeline'), 'prompt documents existing pipeline fallback');
  assert(prompt.includes('active task frame'), 'prompt protects active task frames');
  assert(prompt.includes('simple_live_lookup'), 'prompt documents live lookup route');

  const availableSkillIds = ['search', 'read', 'go-read'];

  const weather = await planFastTurnTriage({
    userText: 'what is the weather in Enola today',
    availableSkillIds,
    llmChat: async () => JSON.stringify({
      route: 'simple_live_lookup',
      confidence: 0.96,
      skills: ['search', 'not-enabled'],
      mustUseTool: true,
      skipCompletenessProbe: true,
      plan: 'Use search once.',
      reason: 'Standalone weather lookup.',
    }),
  });
  assert(weather.route === 'simple_live_lookup', 'weather can use simple live lookup');
  assert(weather.skills.join(',') === 'search', 'triage filters unavailable skills');
  const weatherRoute = fastTriageToTurnRoute(weather);
  assert(weatherRoute.mode === 'tool', 'weather route is a tool route');
  assert(weatherRoute.skills.join(',') === 'search', 'weather route exposes search only');
  assert(weatherRoute.skipCompletenessProbe === true, 'weather route can skip completeness probe');

  const rainFromHistory = await planFastTurnTriage({
    userText: 'is there a chance of rain today',
    historyMessages: [
      { role: 'user', content: 'what is the weather in Enola today' },
      { role: 'assistant', content: 'Enola is around 72F with showers and a 75% chance of rain today.' },
    ],
    availableSkillIds,
    llmChat: async () => JSON.stringify({
      route: 'simple_chat',
      confidence: 0.95,
      skills: [],
      mustUseTool: false,
      skipCompletenessProbe: true,
      plan: 'Answer from recent weather result.',
      reason: 'Recent conversation contains rain chance.',
    }),
  });
  assert(rainFromHistory.route === 'simple_chat', 'rain follow-up can answer from recent weather context');
  assert(fastTriageToTurnRoute(rainFromHistory)?.skills.length === 0, 'rain context answer exposes no tools');

  let capturedTriagePayload = null;
  const rainAfterFailedToolLoop = await planFastTurnTriage({
    userText: 'is there a chance of rain today',
    historyMessages: [
      { role: 'user', content: 'is there a chance of rain today' },
      { role: 'assistant', content: '[Pasture] I could not finish the required tool workflow. Remaining step(s): inspect [search] args={"query":"Enola weather chance of rain today"} output includes "chance of rain". Relevant tool error: none recorded before the tool-round limit.' },
      { role: 'user', content: 'what is the weather in Enola today' },
      { role: 'assistant', content: 'Enola is cloudy and around 67F. There is a chance of showers tonight.' },
    ],
    availableSkillIds,
    llmChat: async (messages) => {
      capturedTriagePayload = JSON.parse(messages[1].content);
      return JSON.stringify({
        route: 'simple_chat',
        confidence: 0.95,
        skills: [],
        mustUseTool: false,
        skipCompletenessProbe: true,
        plan: 'Answer from recent weather result.',
        reason: 'Recent conversation contains rain context.',
      });
    },
  });
  assert(rainAfterFailedToolLoop.route === 'simple_chat', 'rain follow-up can recover after prior generated workflow failure');
  assert(capturedTriagePayload?.recentConversation.includes('chance of showers'), 'triage history keeps successful weather answer');
  assert(!capturedTriagePayload?.recentConversation.includes('Remaining step(s)'), 'triage history removes generated workflow failures');

  const ambiguousFrameFollowup = await planFastTurnTriage({
    userText: 'what is inside it?',
    availableSkillIds,
    activeFrame: {
      id: 'frame-1',
      status: 'active',
      kind: 'repo_work',
      title: 'Inspect repo',
      objective: 'Inspect a repository',
      toolProfile: ['go-read'],
    },
    llmChat: async () => JSON.stringify({
      route: 'existing_pipeline',
      confidence: 0.98,
      skills: [],
      mustUseTool: false,
      skipCompletenessProbe: false,
      plan: '',
      reason: 'May refer to the active frame.',
    }),
  });
  assert(ambiguousFrameFollowup.route === 'existing_pipeline', 'ambiguous frame follow-up stays on existing path');
  assert(fastTriageToTurnRoute(ambiguousFrameFollowup) === null, 'existing pipeline has no fast turn route');

  const standaloneSwitch = await planFastTurnTriage({
    userText: 'what is the weather in Enola today',
    availableSkillIds,
    activeFrame: {
      id: 'frame-1',
      status: 'active',
      kind: 'repo_work',
      title: 'Inspect repo',
      objective: 'Inspect a repository',
      toolProfile: ['go-read'],
    },
    llmChat: async () => JSON.stringify({
      route: 'simple_live_lookup',
      confidence: 0.94,
      skills: ['search'],
      mustUseTool: true,
      skipCompletenessProbe: true,
      plan: 'Use search for the standalone topic switch.',
      reason: 'Weather request is unrelated to the active frame.',
    }),
  });
  assert(standaloneSwitch.route === 'simple_live_lookup', 'standalone topic switch may fast route even with active frame');

  const storedFrame = upsertTaskFrame('owner', {
    action: 'new_candidate',
    confidence: 0.9,
    kind: 'repo_work',
    title: 'Inspect repo',
    objective: 'Inspect a repository',
    toolProfile: ['go-read'],
  }, null, { userText: 'inspect this repo' });
  const beforeSwitch = getActiveTaskFrame('owner');
  assert(beforeSwitch?.id === storedFrame.id, 'test frame is active before standalone switch');
  const switchRoute = fastTriageToTurnRoute(standaloneSwitch);
  assert(switchRoute?.fastTriage === true, 'standalone switch uses fast triage route');
  const afterSwitch = getActiveTaskFrame('owner');
  assert(afterSwitch?.id === storedFrame.id && afterSwitch.status === 'active',
    'standalone fast route leaves active task frame stored and active');

  const lowConfidence = await planFastTurnTriage({
    userText: 'check that thing',
    availableSkillIds,
    llmChat: async () => JSON.stringify({
      route: 'simple_live_lookup',
      confidence: 0.61,
      skills: ['search'],
      mustUseTool: true,
      skipCompletenessProbe: true,
      plan: '',
      reason: 'Uncertain.',
    }),
  });
  assert(lowConfidence.route === 'existing_pipeline', 'low confidence is forced back to existing pipeline');

  console.log('fast-turn-triage tests passed');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
