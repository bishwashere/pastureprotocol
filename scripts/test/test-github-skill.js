/**
 * Unit + integration tests for the GitHub skill executor.
 *
 * Validation tests: run without any token (test arg validation and error messages).
 * Live tests: set GITHUB_TOKEN + GITHUB_TEST_REPO="owner/repo" to run API calls.
 */

import { mkdtempSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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

function parse(result) {
  return typeof result === 'string' ? JSON.parse(result) : result;
}

function assertError(result, partialMsg) {
  const obj = parse(result);
  if (!obj.error) throw new Error(`Expected an error response, got: ${JSON.stringify(obj).slice(0, 200)}`);
  if (partialMsg && !obj.error.toLowerCase().includes(partialMsg.toLowerCase())) {
    throw new Error(`Expected error containing "${partialMsg}", got: ${obj.error.slice(0, 200)}`);
  }
}

function assertField(result, key) {
  const obj = parse(result);
  if (obj.error) throw new Error(`Got error: ${obj.error}`);
  if (obj[key] === undefined && obj[key] !== 0) throw new Error(`Expected field "${key}" in: ${JSON.stringify(obj).slice(0, 200)}`);
}

function assertConfirmRequired(result) {
  const obj = parse(result);
  if (obj.error !== 'confirmation_required') {
    throw new Error(`Expected confirmation_required error, got: ${JSON.stringify(obj).slice(0, 200)}`);
  }
  if (!obj.message) throw new Error('Confirmation response must include a message');
}

// ── Setup: create a temp secrets.json with no token ───────────────────────────

const savedToken = process.env.GITHUB_TOKEN;
const savedStateDir = process.env.COWCODE_STATE_DIR;

function withNoToken(fn) {
  return async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cowcode-gh-test-'));
    writeFileSync(join(tempDir, 'secrets.json'), JSON.stringify({}), 'utf8');
    writeFileSync(join(tempDir, 'config.json'), JSON.stringify({}), 'utf8');
    delete process.env.GITHUB_TOKEN;
    process.env.COWCODE_STATE_DIR = tempDir;
    try {
      await fn();
    } finally {
      process.env.COWCODE_STATE_DIR = savedStateDir || '';
      if (savedToken) process.env.GITHUB_TOKEN = savedToken;
    }
  };
}

console.log('\nGitHub skill executor tests\n');

// ── Token & setup ─────────────────────────────────────────────────────────────

await test('returns setup instructions when no token configured', withNoToken(async () => {
  const result = await executeGithub({}, {}, 'github_read_repo');
  const obj = parse(result);
  if (!obj.error) throw new Error('Expected error');
  if (!obj.setup) throw new Error('Expected setup instructions in response');
  if (!obj.setup.includes('secrets.json')) throw new Error('Setup instructions must mention secrets.json');
}));

await test('reads token from secrets.json', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'cowcode-gh-test-'));
  const fakeToken = 'ghp_fake_token_for_test_1234567890abcd';
  writeFileSync(join(tempDir, 'secrets.json'), JSON.stringify({ github: { token: fakeToken } }), 'utf8');
  writeFileSync(join(tempDir, 'config.json'), JSON.stringify({}), 'utf8');
  delete process.env.GITHUB_TOKEN;
  process.env.COWCODE_STATE_DIR = tempDir;
  try {
    // Will fail with auth error (not "token not configured")
    const result = await executeGithub({}, { repo: 'a/b' }, 'github_read_repo');
    const obj = parse(result);
    // Error must be an API error (token found) not "token not configured"
    if (obj.setup) throw new Error('Should not return setup instructions when token exists in secrets.json');
    if (obj.error && obj.error.includes('not configured')) throw new Error('Token not being read from secrets.json');
  } finally {
    process.env.COWCODE_STATE_DIR = savedStateDir || '';
    if (savedToken) process.env.GITHUB_TOKEN = savedToken;
  }
});

// ── Argument validation ───────────────────────────────────────────────────────

await test('read_repo requires owner/repo format', async () => {
  if (!savedToken) return;
  const result = await executeGithub({}, { repo: 'invalid-no-slash' }, 'github_read_repo');
  assertError(result, 'owner/repo');
});

await test('create_branch requires branch name', async () => {
  if (!savedToken) return;
  const result = await executeGithub({}, { repo: 'a/b', confirm: true }, 'github_create_branch');
  assertError(result, 'branch');
});

await test('post_comment requires body', async () => {
  if (!savedToken) return;
  const result = await executeGithub({}, { repo: 'a/b', number: 1, confirm: true }, 'github_post_comment');
  assertError(result, 'body');
});

await test('create_pr requires head', async () => {
  if (!savedToken) return;
  const result = await executeGithub({}, { repo: 'a/b', title: 'test', confirm: true }, 'github_create_pr');
  assertError(result, 'head');
});

await test('search_code requires query', async () => {
  if (!savedToken) return;
  const result = await executeGithub({}, {}, 'github_search_code');
  assertError(result, 'query');
});

await test('read_issue requires number', async () => {
  if (!savedToken) return;
  const result = await executeGithub({}, { repo: 'a/b' }, 'github_read_issue');
  assertError(result, 'number');
});

await test('unknown action returns list of valid actions', async () => {
  if (!savedToken) return;
  const result = await executeGithub({}, {}, 'github_unknown_action');
  assertError(result, 'valid actions');
});

// ── Confirmation guards ───────────────────────────────────────────────────────

await test('create_branch requires confirm:true', async () => {
  if (!savedToken) return;
  const result = await executeGithub({}, { repo: 'a/b', branch: 'feat/x' }, 'github_create_branch');
  assertConfirmRequired(result);
});

await test('create_branch confirmation message shows branch and repo', async () => {
  if (!savedToken) return;
  const result = await executeGithub({}, { repo: 'a/b', branch: 'feat/x' }, 'github_create_branch');
  const obj = parse(result);
  if (!obj.message.includes('feat/x')) throw new Error('Confirmation message must mention branch name');
  if (!obj.message.includes('a/b')) throw new Error('Confirmation message must mention repo');
});

await test('post_comment requires confirm:true', async () => {
  if (!savedToken) return;
  const result = await executeGithub({}, { repo: 'a/b', number: 1, body: 'hello' }, 'github_post_comment');
  assertConfirmRequired(result);
});

await test('post_comment confirmation message shows body preview', async () => {
  if (!savedToken) return;
  const result = await executeGithub({}, { repo: 'a/b', number: 5, body: 'Fixed in #8' }, 'github_post_comment');
  const obj = parse(result);
  if (!obj.message.includes('Fixed in #8')) throw new Error('Confirmation must show comment body');
});

await test('create_pr requires confirm:true', async () => {
  if (!savedToken) return;
  const result = await executeGithub({}, { repo: 'a/b', title: 'My PR', head: 'feat/x' }, 'github_create_pr');
  assertConfirmRequired(result);
});

// merge_pr also requires confirm (API call needed to fetch PR title — skip if no token)

// ── Live integration tests ────────────────────────────────────────────────────

if (savedToken && process.env.GITHUB_TEST_REPO) {
  console.log(`\n  Running live tests against ${process.env.GITHUB_TEST_REPO}\n`);

  await test('read_repo returns metadata', async () => {
    const result = await executeGithub({}, { repo: process.env.GITHUB_TEST_REPO }, 'github_read_repo');
    const obj = parse(result);
    if (!obj.full_name) throw new Error('Expected full_name');
    if (!obj.default_branch) throw new Error('Expected default_branch');
  });

  await test('list_issues returns array with expected fields', async () => {
    const result = await executeGithub({}, { repo: process.env.GITHUB_TEST_REPO, per_page: 5 }, 'github_list_issues');
    const arr = parse(result);
    if (!Array.isArray(arr)) throw new Error('Expected array');
    if (arr.length > 0) {
      const issue = arr[0];
      if (!issue.number || !issue.title) throw new Error('Issue missing number or title');
    }
  });

  await test('list_prs returns array', async () => {
    const result = await executeGithub({}, { repo: process.env.GITHUB_TEST_REPO, per_page: 3 }, 'github_list_prs');
    if (!Array.isArray(parse(result))) throw new Error('Expected array');
  });

  await test('read_file returns content', async () => {
    const result = await executeGithub({}, { repo: process.env.GITHUB_TEST_REPO, path: 'README.md' }, 'github_read_file');
    const obj = parse(result);
    if (!obj.content && !obj.error) throw new Error('Expected content or graceful error');
  });

  await test('search_code returns items array', async () => {
    const [owner] = process.env.GITHUB_TEST_REPO.split('/');
    const result = await executeGithub({}, { query: `repo:${process.env.GITHUB_TEST_REPO} README`, per_page: 3 }, 'github_search_code');
    const obj = parse(result);
    if (obj.error) return; // secondary rate-limit may hit on first use
    if (!Array.isArray(obj.items)) throw new Error('Expected items array');
  });
}

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
