#!/usr/bin/env node
import { loadPrompt } from '../../lib/agent/md-llm.js';
import {
  classifySelfInspection,
  buildSelfInspectionIntentPlan,
} from '../../lib/agent/self-inspection.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const prompt = loadPrompt('self-inspection-classifier');
  assert(prompt.includes('is_self_inspection'), 'prompt documents is_self_inspection');
  assert(prompt.includes('Pasture/CowCode'), 'prompt anchors on Pasture/CowCode');

  const brainFeature = await classifySelfInspection({
    userText: 'Does this project have brain feature?',
    llmChat: async () => JSON.stringify({
      is_self_inspection: true,
      needs_tools: true,
      target: 'feature_or_capability',
      starting_points: ['runtime_home', 'source_tree', 'memory', 'bad'],
      reason: 'Feature question about this project.',
      confidence: 0.92,
    }),
  });
  assert(brainFeature.is_self_inspection === true, 'brain feature should classify as self inspection');
  assert(brainFeature.needs_tools === true, 'self inspection needs tools');
  assert(brainFeature.target === 'feature_or_capability', 'target preserved');
  assert(brainFeature.starting_points.join(',') === 'runtime_home,source_tree,memory', 'starting points filtered');

  const plan = buildSelfInspectionIntentPlan(brainFeature, ['memory', 'read', 'go-read', 'core', 'http']);
  assert(plan && plan.mode === 'tool', 'plan should require tools');
  assert(plan.skills.join(',') === 'read,go-read,core', 'plan should choose local inspection tools');
  assert(plan.plan.includes('Do not answer from memory alone'), 'plan should require grounding');

  const uiPlan = buildSelfInspectionIntentPlan({
    ...brainFeature,
    starting_points: ['runtime_home', 'ui_or_http'],
  }, ['read', 'go-read', 'http']);
  assert(uiPlan.skills.includes('http'), 'UI self-inspection can add http');

  const casual = await classifySelfInspection({
    userText: 'hi',
    llmChat: async () => JSON.stringify({
      is_self_inspection: false,
      needs_tools: false,
      target: 'none',
      starting_points: [],
      reason: 'Greeting.',
      confidence: 0.99,
    }),
  });
  assert(buildSelfInspectionIntentPlan(casual, ['read']) === null, 'casual turn gets no plan');

  const lowConfidence = buildSelfInspectionIntentPlan({
    is_self_inspection: true,
    needs_tools: true,
    target: 'unknown',
    starting_points: ['runtime_home'],
    confidence: 0.3,
  }, ['read']);
  assert(lowConfidence === null, 'low-confidence self-inspection does not force tools');

  const malformed = await classifySelfInspection({
    userText: 'check yourself',
    llmChat: async () => 'not json',
  });
  assert(malformed === null, 'malformed JSON returns null');

  console.log('self-inspection tests passed');
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
