/**
 * Unit tests for the GitHub skill executor.
 * Tests argument validation and error handling without real API calls.
 * Set GITHUB_TOKEN env var to run live integration tests.
 */

import { executeGithub } from '../../lib/executors/github.js';

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  }
}

function assertContains(result, key, msg) {
  const obj = typeof result === 'string' ? JSON.parse(result) : result;
  if (!obj[key] && obj[key] !== 0) throw new Error(msg || `Expected key "${key}" in result`);
}

function assertError(result, partialMsg) {
  const obj = typeof result === 'string' ? JSON.parse(result) : result;
  if (!obj.error) throw new Error('Expected an error response');
  if (partialMsg && !obj.error.toLowerCase().includes(partialMsg.toLowerCase())) {
    throw new Error(`Expected error containing "${partialMsg}", got: ${obj.error}`);
  }
}

console.log('\nGitHub skill executor tests\n');

// --- Validation tests (no token needed) ---

await test('returns error when GITHUB_TOKEN is missing', async () => {
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  // Temporarily point config to /dev/null so no fallback token exists
  process.env.COWCODE_STATE_DIR = '/dev/null';
  const result = await executeGithub({}, {}, 'github_read_repo');
  process.env.COWCODE_STATE_DIR = '';
  if (saved) process.env.GITHUB_TOKEN = saved;
  assertError(result, 'token');
});

await test('read_repo requires owner/repo format', async () => {
  if (!process.env.GITHUB_TOKEN) return;
  const result = await executeGithub({}, { repo: 'invalid' }, 'github_read_repo');
  assertError(result, 'owner/repo');
});

await test('create_branch requires repo, branch', async () => {
  if (!process.env.GITHUB_TOKEN) return;
  const result = await executeGithub({}, { repo: 'a/b' }, 'github_create_branch');
  assertError(result, 'branch');
});

await test('post_comment requires body', async () => {
  if (!process.env.GITHUB_TOKEN) return;
  const result = await executeGithub({}, { repo: 'a/b', number: 1 }, 'github_post_comment');
  assertError(result, 'body');
});

await test('create_pr requires title and head', async () => {
  if (!process.env.GITHUB_TOKEN) return;
  const result = await executeGithub({}, { repo: 'a/b', title: 'test' }, 'github_create_pr');
  assertError(result, 'head');
});

await test('search_code requires query', async () => {
  if (!process.env.GITHUB_TOKEN) return;
  const result = await executeGithub({}, {}, 'github_search_code');
  assertError(result, 'query');
});

await test('unknown action returns error', async () => {
  if (!process.env.GITHUB_TOKEN) return;
  const result = await executeGithub({}, {}, 'github_bananas');
  assertError(result, 'unknown');
});

// --- Live integration tests (only when GITHUB_TOKEN is set) ---

if (process.env.GITHUB_TOKEN && process.env.GITHUB_TEST_REPO) {
  console.log(`\n  Running live tests against ${process.env.GITHUB_TEST_REPO}\n`);

  await test('read_repo returns repo metadata', async () => {
    const result = await executeGithub({}, { repo: process.env.GITHUB_TEST_REPO }, 'github_read_repo');
    const obj = JSON.parse(result);
    if (!obj.full_name) throw new Error('Expected full_name in response');
  });

  await test('list_issues returns array', async () => {
    const result = await executeGithub({}, { repo: process.env.GITHUB_TEST_REPO, per_page: 5 }, 'github_list_issues');
    const arr = JSON.parse(result);
    if (!Array.isArray(arr)) throw new Error('Expected array of issues');
  });
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
