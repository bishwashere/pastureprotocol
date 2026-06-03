/**
 * Fixed test fixture state: scripts/test/fixtures/state/
 * Contains dummy data (workspace/MEMORY.md, memory/*.md, chat-log, cron, edit target)
 * so all skills have something to work on. Committed; not created at test time.
 *
 * Use prepareStateFromFixture() to get a state dir that has fixture data + your
 * config/.env from ~/.pasture (so LLM and skills work). Returns a temp dir path.
 */

import { mkdirSync, copyFileSync, existsSync, cpSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir, tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the fixed fixture state dir (workspace + cron dummy data). */
export const FIXTURE_STATE_DIR = join(__dirname, 'fixtures', 'state');

const DEFAULT_STATE_DIR = process.env.PASTURE_STATE_DIR || join(homedir(), '.pasture');

/**
 * Prepare a state dir for tests: copy default config and .env to a temp dir,
 * then copy fixture workspace and cron over it. Returns the temp state dir path.
 * Use this so tests have fixture data (me, memory, edit target, etc.) and your real config.
 * @returns {string} Absolute path to the prepared state dir
 */
export function prepareStateFromFixture() {
  const stateDir = join(tmpdir(), 'pasture-e2e-fixture-' + Date.now());
  mkdirSync(stateDir, { recursive: true });

  if (existsSync(join(DEFAULT_STATE_DIR, 'config.json'))) {
    copyFileSync(join(DEFAULT_STATE_DIR, 'config.json'), join(stateDir, 'config.json'));
  }
  if (existsSync(join(DEFAULT_STATE_DIR, '.env'))) {
    let env = readFileSync(join(DEFAULT_STATE_DIR, '.env'), 'utf8');
    env = env.split('\n').filter((l) => !/^\s*PASTURE_STATE_DIR\s*=/.test(l)).join('\n');
    writeFileSync(join(stateDir, '.env'), env.trimEnd() + '\nPASTURE_STATE_DIR=' + stateDir + '\n', 'utf8');
  } else {
    writeFileSync(join(stateDir, '.env'), 'PASTURE_STATE_DIR=' + stateDir + '\n', 'utf8');
  }

  const fixtureWorkspace = join(FIXTURE_STATE_DIR, 'workspace');
  const fixtureCron = join(FIXTURE_STATE_DIR, 'cron');
  if (existsSync(fixtureWorkspace)) {
    cpSync(fixtureWorkspace, join(stateDir, 'workspace'), { recursive: true });
  }
  if (existsSync(fixtureCron)) {
    mkdirSync(join(stateDir, 'cron'), { recursive: true });
    if (existsSync(join(fixtureCron, 'jobs.json'))) {
      copyFileSync(join(fixtureCron, 'jobs.json'), join(stateDir, 'cron', 'jobs.json'));
    }
  }

  return stateDir;
}
