/**
 * Retrospective subsystem tests (no LLM calls).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendExchange,
  patchExchangeRetrospective,
  getLastPrivateExchangeLocation,
} from '../../lib/chat-log.js';
import { buildOneOnOneSystemPrompt } from '../../lib/system-prompt.js';
import {
  migrateRetrospectiveConfig,
  getRetrospectiveConfig,
  isRetrospectiveEnabled,
  collectBadExchanges,
  appendToLessonsMd,
  readQualityMetrics,
  recordScoredExchange,
  recordImplicitFeedback,
  LESSONS_MD,
} from '../../lib/retrospective.js';
import { getConfigPath, getRetrospectiveMetricsPath } from '../../lib/paths.js';

function setupStateDir() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-retro-'));
  mkdirSync(join(stateDir, 'workspace'), { recursive: true });
  writeFileSync(
    join(stateDir, 'config.json'),
    JSON.stringify({ skills: { enabled: ['memory'] } }, null, 2),
    'utf8',
  );
  process.env.PASTURE_STATE_DIR = stateDir;
  return stateDir;
}

const checks = [];

function check(name, ok, detail) {
  checks.push({ name, ok, detail });
}

async function main() {
  const stateDir = setupStateDir();
  migrateRetrospectiveConfig();
  const cfg = readFileSync(getConfigPath(), 'utf8');
  check('migrateRetrospectiveConfig adds block', cfg.includes('"retrospective"'), '');
  check('retrospective enabled by default', isRetrospectiveEnabled(), '');
  check('default lowScoreThreshold', getRetrospectiveConfig().lowScoreThreshold === 6, '');

  const ws = join(stateDir, 'workspace');
  const ex = {
    user: 'What is 2+2?',
    assistant: 'Four.',
    timestampMs: Date.now(),
    jid: '12345',
    sessionId: 's1',
  };
  const { path, lineNumber } = appendExchange(ws, ex);
  check('appendExchange returns location', !!path && lineNumber === 1, path);

  const loc = getLastPrivateExchangeLocation(ws, '12345', 's1');
  check('getLastPrivateExchangeLocation finds row', loc?.lineNumber === 1, '');

  patchExchangeRetrospective(ws, path, lineNumber, { selfScore: 4, selfReason: 'too terse', scoredAt: Date.now() });
  const loc2 = getLastPrivateExchangeLocation(ws, '12345', 's1');
  check('patchExchangeRetrospective stores score', loc2?.row?.retrospective?.selfScore === 4, '');

  patchExchangeRetrospective(ws, path, lineNumber, { needsCorrection: true, feedbackType: 'correction', feedbackAt: Date.now() });
  const bad = collectBadExchanges(ws, 7, 6);
  check('collectBadExchanges finds low/corrected', bad.length === 1, String(bad.length));

  appendToLessonsMd(ws, '## test\n- Do not guess.');
  check('appendToLessonsMd creates file', existsSync(join(ws, LESSONS_MD)), '');
  const prompt = buildOneOnOneSystemPrompt(ws);
  check('lessons.md injected in system prompt', prompt.includes('Do not guess.'), '');

  recordScoredExchange('2026-05-29');
  recordImplicitFeedback('2026-05-29', true);
  recordImplicitFeedback('2026-05-29', false);
  const metrics = readQualityMetrics();
  check('quality metrics track scored', metrics.totalScored >= 1, String(metrics.totalScored));
  check('quality metrics track feedback', metrics.totalWithFeedback >= 2, String(metrics.totalWithFeedback));
  check('correction rate computed', metrics.correctionRate === 0.5, String(metrics.correctionRate));
  check('metrics file written', existsSync(getRetrospectiveMetricsPath()), '');

  let failed = 0;
  for (const c of checks) {
    const status = c.ok ? 'PASS' : 'FAIL';
    console.log(`[${status}] ${c.name}${c.detail ? ' — ' + c.detail : ''}`);
    if (!c.ok) failed++;
  }
  if (failed) {
    console.error(`\n${failed} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll retrospective checks passed.');
}

main().catch((e) => {
  console.error('Retrospective test failed:', e.message);
  process.exit(1);
});
