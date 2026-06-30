#!/usr/bin/env node
/**
 * Cloud daily limit must not block local model fallback (alex-style config: cloud priority + local).
 * Also: when local goes down and cloud is at its daily limit, the error surfaced must describe
 * the local failure (root cause), not the misleading cloud-limit message.
 */

import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTempStateDir } from '../../support/e2e-run.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  const stateDir = createTempStateDir();
  process.env.PASTURE_STATE_DIR = stateDir;
  process.env.LLM_1_API_KEY = 'sk-test-cloud-key';

  mkdirSync(join(stateDir, 'agents', 'alex'), { recursive: true });
  writeFileSync(
    join(stateDir, 'agents', 'alex', 'config.json'),
    JSON.stringify({
      llm: {
        maxTokens: 256,
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

  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(stateDir, 'llm-usage.json'),
    JSON.stringify({ date: today, count: 100 }),
    'utf8',
  );

  const originalFetch = globalThis.fetch;
  let cloudAttempted = false;
  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.includes('api.openai.com')) {
      cloudAttempted = true;
      throw new Error('cloud fetch should not run when daily limit is reached');
    }
    if (href.includes('127.0.0.1:1234')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: 'local fallback ok' } }],
        }),
        text: async () => '',
      };
    }
    throw new Error(`unexpected fetch url: ${href}`);
  };

  try {
    const { chat } = await import('../../../../llm.js');
    const reply = await chat(
      [{ role: 'user', content: 'ping' }],
      { agentId: 'alex' },
    );
    assert(cloudAttempted === false, 'cloud model must not be called after daily limit');
    assert(reply === 'local fallback ok', `expected local fallback, got: ${reply}`);
    console.log('test-llm-daily-limit passed');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.LLM_1_API_KEY;
  }
}

async function runLocalDownCloudLimited() {
  const stateDir = createTempStateDir();
  process.env.PASTURE_STATE_DIR = stateDir;
  process.env.LLM_1_API_KEY = 'sk-test-cloud-key';

  mkdirSync(join(stateDir, 'agents', 'alex2'), { recursive: true });
  writeFileSync(
    join(stateDir, 'agents', 'alex2', 'config.json'),
    JSON.stringify({
      llm: {
        maxTokens: 256,
        models: [
          {
            provider: 'lmstudio',
            model: 'local',
            apiKey: 'not-needed',
            baseUrl: 'http://127.0.0.1:1234/v1',
            priority: true,
          },
          {
            provider: 'openai',
            model: 'gpt-5.2',
            apiKey: 'LLM_1_API_KEY',
          },
        ],
      },
    }),
    'utf8',
  );

  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    join(stateDir, 'llm-usage.json'),
    JSON.stringify({ date: today, count: 100 }),
    'utf8',
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('127.0.0.1:1234')) {
      throw new Error('fetch failed');
    }
    if (href.includes('api.openai.com')) {
      throw new Error('cloud fetch should not run when daily limit is reached');
    }
    throw new Error(`unexpected fetch url: ${href}`);
  };

  try {
    const { chat } = await import('../../../../llm.js?local-down-test');
    let threw = false;
    try {
      await chat([{ role: 'user', content: 'ping' }], { agentId: 'alex2' });
    } catch (err) {
      threw = true;
      assert(
        !/Daily cloud LLM limit reached/i.test(err.message),
        `error should NOT mention cloud daily limit when local is the root cause, got: ${err.message}`,
      );
      assert(
        /fetch failed/i.test(err.message),
        `error should mention the local fetch failure, got: ${err.message}`,
      );
    }
    assert(threw, 'expected an error when both local and cloud fail');
    console.log('test-llm-daily-limit local-down-cloud-limited passed');
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.LLM_1_API_KEY;
  }
}

/**
 * Local RPM limit is per-message (trace), not per individual LLM call.
 * Multiple calls within the same trace must all pass. A second distinct
 * trace within the same 60-second window must be rejected.
 */
async function runLocalRpmPerMessage() {
  const { checkLocalRateLimit } = await import('../../../../llm.js?rpm-per-message-test');

  const BASE = 'http://127.0.0.1:9999/v1';

  // --- First call of trace-A opens the window and is admitted ---
  checkLocalRateLimit(BASE, 1, 'trace-A');

  // --- Second and third calls of the same trace must not throw ---
  let threw = false;
  try {
    checkLocalRateLimit(BASE, 1, 'trace-A');
    checkLocalRateLimit(BASE, 1, 'trace-A');
  } catch {
    threw = true;
  }
  assert(!threw, 'multiple LLM calls within the same message trace must all be allowed');

  // --- A second distinct trace within the same window must be rejected ---
  let blocked = false;
  try {
    checkLocalRateLimit(BASE, 1, 'trace-B');
  } catch (err) {
    blocked = err?.code === 'LLM_LOCAL_RATE_LIMIT';
  }
  assert(blocked, 'a second distinct message within the same 60-second window must be rate-limited');

  console.log('test-llm-local-rpm-per-message passed');
}

run()
  .then(() => runLocalDownCloudLimited())
  .then(() => runLocalRpmPerMessage())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
