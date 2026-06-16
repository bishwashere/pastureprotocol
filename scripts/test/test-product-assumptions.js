#!/usr/bin/env node
import {
  applyAssumptionUpdates,
  ASSUMPTION_STATUS,
  canAssumeFromLiveProduct,
  formatAssumptionPhasePromptBlock,
  formatMissionBlockersForPrompt,
  hasAppliedAssumption,
  isActiveBlockerTask,
  listAssumptionPendingBlockers,
  normalizeAssumptionRecord,
} from '../../lib/context/product-assumptions.js';
import { buildMissionTickPrompt } from '../../lib/context/missions.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const liveCtx = { projectUrl: 'https://chess999.example.com', hasLiveProduct: true, projectName: 'Chess999' };

const specTask = {
  id: 'sg-spec',
  title: 'Need direction: Define the product spec and MVP feature set',
  status: 'in_progress',
  blockerType: 'need_direction',
};

const accessTask = {
  id: 'sg-access',
  title: 'Need access: Stripe read-only key',
  status: 'blocked',
  blockerType: 'need_access',
};

assert(isActiveBlockerTask(specTask), 'spec task is active blocker before conversion');
assert(isActiveBlockerTask(accessTask), 'access task is active blocker');
assert(canAssumeFromLiveProduct(specTask, liveCtx), 'spec + live url is assumable');
assert(!canAssumeFromLiveProduct(accessTask, liveCtx), 'access task is not assumable');

const record = normalizeAssumptionRecord({
  summary: 'Chess999 is a live chess platform with matchmaking visible on homepage',
  collectedEvidence: ['Homepage shows play button', 'Signup modal present'],
  assumptions: [{ item: 'MVP includes online play', confidence: 0.85, rationale: 'Play CTA on homepage' }],
  sourceUrl: liveCtx.projectUrl,
});
assert(record.status === ASSUMPTION_STATUS.APPLIED, 'normalized assumption record');

const mission = {
  id: 'mission-test',
  title: 'Launch chess999',
  objective: 'Launch chess999',
  status: 'active',
  progress: { pct: 40 },
  projectId: 1,
  tasks: [specTask, accessTask],
  currentPlan: { steps: [] },
};

const pending = listAssumptionPendingBlockers(mission.tasks, liveCtx);
assert(pending.length === 1 && pending[0].id === 'sg-spec', `pending assumptions: ${pending.length}`);

const updatedTasks = applyAssumptionUpdates(mission.tasks, [{
  taskId: 'sg-spec',
  assumptionRecord: record,
  progress: 60,
}], liveCtx);
assert(hasAppliedAssumption(updatedTasks[0]), 'assumption applied to spec task');
assert(!isActiveBlockerTask(updatedTasks[0]), 'converted task is no longer an active blocker');
assert(String(updatedTasks[0].status) === 'todo', 'converted task defaults to open/todo');
assert(!hasAppliedAssumption(updatedTasks[1]), 'access task unchanged');

const blockersPrompt = formatMissionBlockersForPrompt({ ...mission, tasks: updatedTasks }, liveCtx);
assert(blockersPrompt.includes('Active blockers'), 'blockers prompt lists active blockers');
assert(blockersPrompt.includes('converted via assumption'), 'blockers prompt lists converted blockers');

const prompt = buildMissionTickPrompt(mission, {
  missionMemory: '',
  memoryPath: '/tmp/x.md',
  projectContext: liveCtx,
});
assert(prompt.includes('10) Assumption phase (LAST'), 'tick prompt includes last assumption phase');
assert(prompt.includes('assumptionUpdates'), 'tick prompt documents assumptionUpdates schema');
assert(prompt.indexOf('10) Assumption') < prompt.indexOf('Take one useful step'), 'assumption phase appears before final action line');

const phaseBlock = formatAssumptionPhasePromptBlock(mission, liveCtx, pending);
assert(phaseBlock.includes('chess999.example.com'), 'phase block includes live url');

console.log('product-assumptions tests passed');
