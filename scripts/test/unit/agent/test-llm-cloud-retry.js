#!/usr/bin/env node
/**
 * Cloud LLM transient failures retry on the same model before falling back to local.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createTempStateDir } from '../../support/e2e-run.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeAlexConfig(stateDir) {
  mkdirSync(join(stateDir, 'agents', 'alex'), { recursive: true });
  writeFileSync(
    join(stateDir, 'agents', 'alex', 'config.json'),
    JSON.stringify({
      llm: {
        maxTokens: 256,
        localRpm: 0,
        models: [
          {
            provider: 'lmstudio',
            model: 'local',
            apiKey: 'not-needed',
            baseUrl: 'http://127.0.0.1:1234/v1',
          },
          {
            provider: 'openai',
            model: 'gpt-5.2',
            apiKey: 'LLM_1_API_KEY',
            priority: true,
          },
        ],
      },
    }),
    'utf8',
  );
}

async function testRetriesThenSucceeds() {
  const stateDir = createTempStateDir();
  process.env.PASTURE_STATE_DIR = stateDir;
  process.env.LLM_1_API_KEY = 'sk-test-cloud-key';
  writeAlexConfig(stateDir);

  const originalFetch = globalThis.fetch;
  let cloudCalls = 0;
  let localCalls = 0;

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('api.openai.com')) {
      cloudCalls += 1;
      if (cloudCalls < 3) {
        return {
          ok: false,
          status: 520,
          text: async () => '<html>520 error</html>',
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'cloud-after-retry' } }] }),
        text: async () => '',
      };
    }
    if (href.includes('127.0.0.1:1234')) {
      localCalls += 1;
      throw new Error('local should not be called when cloud succeeds on retry');
    }
    throw new Error(`unexpected fetch url: ${href}`);
  };

  try {
    const { chat } = await import('../../../../llm.js');
    const reply = await chat([{ role: 'user', content: 'ping' }], { agentId: 'alex' });
    assert(reply === 'cloud-after-retry', `expected cloud-after-retry, got: ${reply}`);
    assert(cloudCalls === 3, `expected 3 cloud attempts, got ${cloudCalls}`);
    assert(localCalls === 0, `local should not run, got ${localCalls} calls`);
    console.log('  retries then cloud succeeds → ✅');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.LLM_1_API_KEY;
  }
}

async function testExhaustRetriesThenLocal() {
  const stateDir = createTempStateDir();
  process.env.PASTURE_STATE_DIR = stateDir;
  process.env.LLM_1_API_KEY = 'sk-test-cloud-key';
  writeAlexConfig(stateDir);

  const originalFetch = globalThis.fetch;
  let cloudCalls = 0;
  let localCalls = 0;

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('api.openai.com')) {
      cloudCalls += 1;
      return {
        ok: false,
        status: 503,
        text: async () => 'upstream unavailable',
      };
    }
    if (href.includes('127.0.0.1:1234')) {
      localCalls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'local-fallback' } }] }),
        text: async () => '',
      };
    }
    throw new Error(`unexpected fetch url: ${href}`);
  };

  try {
    const { chat } = await import('../../../../llm.js');
    const reply = await chat([{ role: 'user', content: 'ping' }], { agentId: 'alex' });
    assert(reply === 'local-fallback', `expected local-fallback, got: ${reply}`);
    assert(cloudCalls === 3, `expected 3 cloud attempts before fallback, got ${cloudCalls}`);
    assert(localCalls === 1, `expected 1 local call, got ${localCalls}`);
    console.log('  exhaust cloud retries → local fallback → ✅');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.LLM_1_API_KEY;
  }
}

async function testNoRetryOn401() {
  const stateDir = createTempStateDir();
  process.env.PASTURE_STATE_DIR = stateDir;
  process.env.LLM_1_API_KEY = 'sk-test-cloud-key';
  writeAlexConfig(stateDir);

  const originalFetch = globalThis.fetch;
  let cloudCalls = 0;

  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('api.openai.com')) {
      cloudCalls += 1;
      return {
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ error: { message: 'invalid api key' } }),
      };
    }
    if (href.includes('127.0.0.1:1234')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: 'local-on-auth-fail' } }] }),
        text: async () => '',
      };
    }
    throw new Error(`unexpected fetch url: ${href}`);
  };

  try {
    const { chat } = await import('../../../../llm.js');
    const reply = await chat([{ role: 'user', content: 'ping' }], { agentId: 'alex' });
    assert(reply === 'local-on-auth-fail', `expected local-on-auth-fail, got: ${reply}`);
    assert(cloudCalls === 1, `401 should not retry, got ${cloudCalls} cloud calls`);
    console.log('  401 no retry → local fallback → ✅');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.LLM_1_API_KEY;
  }
}

async function testTransientClassifier() {
  const { isTransientCloudError } = await import('../../../../llm.js');
  assert(isTransientCloudError(new Error('LLM request failed 520: html')), '520 is transient');
  assert(isTransientCloudError(new Error('fetch failed')), 'fetch failed is transient');
  assert(!isTransientCloudError(new Error('LLM request failed 401: bad key')), '401 is not transient');
  assert(!isTransientCloudError(new Error('LLM request failed 400: model not found')), '400 is not transient');
  console.log('  isTransientCloudError unit checks → ✅');
}

async function main() {
  console.log('test-llm-cloud-retry\n');
  await testTransientClassifier();
  await testRetriesThenSucceeds();
  await testExhaustRetriesThenLocal();
  await testNoRetryOn401();
  console.log('\ntest-llm-cloud-retry passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
