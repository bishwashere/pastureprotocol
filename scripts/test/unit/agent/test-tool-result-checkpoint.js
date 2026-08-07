#!/usr/bin/env node

import { loadPrompt } from '../../../../lib/agent/md-llm.js';
import {
  normalizeToolResultCheckpoint,
  summarizeToolResultsForCheckpoint,
  summarizeToolResultsForCheckpointOutcome,
} from '../../../../lib/agent/tool-result-checkpoint.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const prompt = loadPrompt('tool-result-checkpoint');
assert(prompt.includes('Exact user-relevant facts'), 'checkpoint importance is decided in Markdown');
assert(prompt.includes('Never return passwords'), 'checkpoint prompt forbids secret persistence');
assert(prompt.includes('distinct project results'), 'checkpoint prompt preserves broad inventory results');

const direct = normalizeToolResultCheckpoint({
  save: true,
  summary: 'Checked two projects.',
  facts: ['Alpha users: 41', 'Beta users: 73'],
  evidence: ['Both queries completed'],
  completed: ['Alpha', 'Beta'],
  failures: [],
  nextSteps: [],
  supersedes: [],
});
assert(direct?.facts?.length === 2, 'valid checkpoint preserves distinct facts');
assert(normalizeToolResultCheckpoint({ save: false, summary: 'noise' }) === null,
  'save=false does not create a checkpoint');

let sentPayload = '';
const tailFact = 'TAIL_FACT=preserved';
const summarized = await summarizeToolResultsForCheckpoint({
  objective: 'Check every project and report user counts.',
  plan: 'Inspect Alpha and Beta, then synthesize.',
  toolResults: [
    {
      skill: 'exec',
      action: 'node_script',
      status: 'ok',
      output: `mongodb+srv://admin:super-secret@cluster.example/db\nAlpha users: 41\n${'x'.repeat(20_000)}\n${tailFact}`,
    },
  ],
  llmChat: async (messages) => {
    sentPayload = String(messages?.[1]?.content || '');
    return JSON.stringify({
      save: true,
      summary: 'Checked Alpha.',
      completed: ['Alpha count'],
      facts: ['Alpha users: 41'],
      evidence: ['Count query succeeded'],
      failures: [],
      nextSteps: ['Check Beta'],
      supersedes: [],
    });
  },
});
assert(summarized?.facts?.[0] === 'Alpha users: 41', 'MD-backed summary returns exact safe fact');
assert(!sentPayload.includes('super-secret'), 'credential is redacted before checkpoint LLM input');
assert(sentPayload.includes('Alpha users: 41'), 'safe tool evidence reaches checkpoint LLM');
assert(sentPayload.includes(tailFact), 'large-result tail evidence reaches checkpoint LLM');

const malformed = await summarizeToolResultsForCheckpoint({
  objective: 'test',
  toolResults: [{ skill: 'read', status: 'ok', output: 'fact' }],
  llmChat: async () => 'not-json',
});
assert(malformed === null, 'malformed checkpoint output degrades gracefully');
const malformedOutcome = await summarizeToolResultsForCheckpointOutcome({
  objective: 'test',
  toolResults: [{ skill: 'read', status: 'ok', output: 'fact' }],
  llmChat: async () => 'not-json',
});
assert(malformedOutcome.status === 'failed', 'runtime can distinguish retryable malformed output');
const skippedOutcome = await summarizeToolResultsForCheckpointOutcome({
  objective: 'test',
  toolResults: [{ skill: 'read', status: 'ok', output: 'noise' }],
  llmChat: async () => JSON.stringify({
    save: false,
    summary: '',
    completed: [],
    facts: [],
    evidence: [],
    failures: [],
    nextSteps: [],
    supersedes: [],
  }),
});
assert(skippedOutcome.status === 'skipped', 'intentional save=false is not retried as a failure');

console.log('tool-result-checkpoint tests passed');
