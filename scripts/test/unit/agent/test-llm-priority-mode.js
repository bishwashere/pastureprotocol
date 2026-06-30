#!/usr/bin/env node
/**
 * Agent LLM priorityMode=system inherits project model order.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const stateDir = join(tmpdir(), `pasture-llm-priority-${Date.now()}`);
  mkdirSync(join(stateDir, 'agents', 'alex'), { recursive: true });

  writeFileSync(
    join(stateDir, 'config.json'),
    JSON.stringify({
      llm: {
        models: [
          { provider: 'lmstudio', model: 'local', apiKey: 'not-needed', baseUrl: 'http://127.0.0.1:1234/v1', priority: true },
          { provider: 'openai', model: 'gpt-5.2', apiKey: 'LLM_1_API_KEY' },
        ],
      },
    }),
    'utf8',
  );

  writeFileSync(
    join(stateDir, 'agents', 'alex', 'config.json'),
    JSON.stringify({
      llm: {
        priorityMode: 'system',
        models: [
          { provider: 'lmstudio', model: 'local', apiKey: 'not-needed', baseUrl: 'http://127.0.0.1:1234/v1' },
          { provider: 'openai', model: 'gpt-5.2', apiKey: 'LLM_1_API_KEY', priority: true },
        ],
      },
    }),
    'utf8',
  );

  process.env.PASTURE_STATE_DIR = stateDir;
  process.env.LLM_1_API_KEY = 'sk-test';

  const { loadConfig } = await import('../../../../llm.js');
  const { models } = loadConfig({ agentId: 'alex' });
  assert(models.length >= 2, 'expected at least two models');
  assert(/127\.0\.0\.1|localhost/i.test(models[0].baseUrl || ''), `system mode should prefer local first, got ${models[0].model || models[0].baseUrl}`);

  writeFileSync(
    join(stateDir, 'agents', 'alex', 'config.json'),
    JSON.stringify({
      llm: {
        priorityMode: 'custom',
        models: [
          { provider: 'lmstudio', model: 'local', apiKey: 'not-needed', baseUrl: 'http://127.0.0.1:1234/v1' },
          { provider: 'openai', model: 'gpt-5.2', apiKey: 'LLM_1_API_KEY', priority: true },
        ],
      },
    }),
    'utf8',
  );

  const { models: customModels } = loadConfig({ agentId: 'alex' });
  assert(!/127\.0\.0\.1|localhost/i.test(customModels[0].baseUrl || ''), `custom mode should prefer openai first, got ${customModels[0].model || customModels[0].baseUrl}`);

  console.log('test-llm-priority-mode passed');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
