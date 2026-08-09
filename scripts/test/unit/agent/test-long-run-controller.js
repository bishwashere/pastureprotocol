#!/usr/bin/env node

import assert from 'assert';
import {
  canonicalizeToolValue,
  createLongRunController,
  fingerprintToolOutcome,
} from '../../../../lib/agent/long-run-controller.js';

const ordered = { project: 'alpha', query: { active: true, limit: 10 } };
const reordered = { query: { limit: 10, active: true }, project: 'alpha' };
assert.strictEqual(
  canonicalizeToolValue(ordered),
  canonicalizeToolValue(reordered),
  'canonical arguments ignore object key insertion order',
);

const baseOutcome = {
  skillId: 'mongodb',
  toolName: 'count_users',
  arguments: ordered,
  result: '{"count":42}',
  isError: false,
};
assert.strictEqual(
  fingerprintToolOutcome(baseOutcome),
  fingerprintToolOutcome({ ...baseOutcome, arguments: reordered }),
  'equivalent structured calls have the same fingerprint',
);
assert.notStrictEqual(
  fingerprintToolOutcome(baseOutcome),
  fingerprintToolOutcome({ ...baseOutcome, result: '{"count":43}' }),
  'the raw result participates in the fingerprint',
);
assert.notStrictEqual(
  fingerprintToolOutcome(baseOutcome),
  fingerprintToolOutcome({ ...baseOutcome, result: '{ "count":42 }' }),
  'raw result whitespace is preserved rather than parsed away',
);

let clock = 1_000;
const budget = createLongRunController({
  initialRounds: 2,
  grantRounds: 3,
  hardRounds: 7,
  maxRuntimeMs: 1_000,
  now: () => clock,
});
assert.deepStrictEqual(
  {
    roundsUsed: budget.snapshot().roundsUsed,
    roundLimit: budget.snapshot().roundLimit,
    needsGrant: budget.snapshot().needsGrant,
  },
  { roundsUsed: 0, roundLimit: 2, needsGrant: false },
  'controller starts with the initial grant',
);
budget.completeRound();
let state = budget.completeRound();
assert.strictEqual(state.stop, false, 'the initial grant boundary is reviewable, not a hard stop');
assert.strictEqual(state.needsGrant, true, 'the initial boundary requests a continuation grant');
state = budget.grant();
assert.strictEqual(state.extended, true, 'grant extends a reviewable run');
assert.strictEqual(state.grantedRounds, 3);
assert.strictEqual(state.roundLimit, 5);
budget.completeRound(3);
state = budget.grant();
assert.strictEqual(state.roundLimit, 7, 'the final grant is clamped to the hard round ceiling');
assert.strictEqual(state.grantedRounds, 2);
state = budget.completeRound(2);
assert.strictEqual(state.stop, true);
assert.strictEqual(state.reason, 'max_rounds', 'the hard ceiling cannot be granted through');

const runtime = createLongRunController({
  initialRounds: 10,
  hardRounds: 20,
  maxRuntimeMs: 500,
  now: () => clock,
});
clock += 499;
assert.strictEqual(runtime.check().stop, false, 'runtime remains live before the exact deadline');
clock += 1;
assert.strictEqual(runtime.check().reason, 'max_runtime', 'injected time enforces the runtime ceiling');

const aborted = createLongRunController({ abortSignal: { aborted: true }, now: () => 0 });
assert.strictEqual(aborted.check().reason, 'aborted', 'configured abort signal stops the run');
const lateAbort = createLongRunController({ now: () => 0 });
assert.strictEqual(
  lateAbort.check({ abortSignal: { aborted: true } }).reason,
  'aborted',
  'a per-check abort signal also stops the run',
);

let scopedClock = 0;
const scopedLimits = createLongRunController({
  initialRounds: 1,
  hardRounds: 2,
  maxRuntimeMs: 10,
  unchangedSuccessThreshold: 3,
  cycleRepeatThreshold: 10,
  now: () => scopedClock,
});
scopedClock = 10;
state = scopedLimits.completeRound(3, { enforceLimits: false });
assert.strictEqual(state.stop, false, 'disabled limits do not stop on runtime or hard rounds');
assert.strictEqual(state.roundsUsed, 3, 'disabled limits still count rounds beyond the hard ceiling');
assert.strictEqual(
  scopedLimits.check({ enforceLimits: true }).reason,
  'max_runtime',
  'a later enforcing check applies the elapsed runtime ceiling',
);

const scopedHardRounds = createLongRunController({
  initialRounds: 1,
  hardRounds: 2,
  maxRuntimeMs: 100,
  now: () => 0,
});
state = scopedHardRounds.completeRound(3, { enforceLimits: false });
assert.strictEqual(state.stop, false, 'disabled limits allow round accounting past the hard ceiling');
assert.strictEqual(
  scopedHardRounds.check({ enforceLimits: true }).reason,
  'max_rounds',
  'a later enforcing check applies the hard-round ceiling',
);

const scopedAbort = createLongRunController({ now: () => 0 });
assert.strictEqual(
  scopedAbort.check({ enforceLimits: false, abortSignal: { aborted: true } }).reason,
  'aborted',
  'abort remains enforced when runtime and hard-round limits are disabled',
);

const scopedLoop = createLongRunController({
  hardRounds: 1,
  maxRuntimeMs: 0,
  unchangedSuccessThreshold: 2,
  cycleRepeatThreshold: 10,
  now: () => 0,
});
assert.strictEqual(
  scopedLoop.recordOutcome({ ...baseOutcome, enforceLimits: false }).stop,
  false,
  'disabled runtime limits still allow outcome tracking',
);
state = scopedLoop.recordOutcome({ ...baseOutcome, enforceLimits: false });
assert.strictEqual(
  state.reason,
  'repeated_unchanged_success',
  'repeat-loop detection remains enforced when runtime and hard-round limits are disabled',
);

const repeatedSuccess = createLongRunController({
  unchangedSuccessThreshold: 3,
  identicalErrorThreshold: 2,
  cycleRepeatThreshold: 10,
  now: () => 0,
});
assert.strictEqual(repeatedSuccess.recordOutcome(baseOutcome).stop, false);
assert.strictEqual(repeatedSuccess.recordOutcome(baseOutcome).stop, false);
state = repeatedSuccess.recordOutcome(baseOutcome);
assert.strictEqual(state.reason, 'repeated_unchanged_success');
assert.strictEqual(state.repeatCount, 3);

const repeatedError = createLongRunController({
  unchangedSuccessThreshold: 10,
  identicalErrorThreshold: 2,
  cycleRepeatThreshold: 10,
  now: () => 0,
});
const errorOutcome = { ...baseOutcome, result: 'connection refused', isError: true };
assert.strictEqual(repeatedError.recordOutcome(errorOutcome).stop, false);
state = repeatedError.recordOutcome(errorOutcome);
assert.strictEqual(state.reason, 'repeated_identical_error', 'identical errors stop at the lower threshold');

const changing = createLongRunController({
  unchangedSuccessThreshold: 2,
  cycleRepeatThreshold: 3,
  now: () => 0,
});
for (let index = 0; index < 20; index++) {
  state = changing.recordOutcome({ ...baseOutcome, result: `poll-${index}` });
  assert.strictEqual(state.stop, false, 'a genuinely changing result is progress, not a loop');
}

const twoCycle = createLongRunController({
  unchangedSuccessThreshold: 20,
  identicalErrorThreshold: 20,
  cycleRepeatThreshold: 3,
  now: () => 0,
});
for (const project of ['a', 'b', 'a', 'b', 'a', 'b']) {
  state = twoCycle.recordOutcome({
    ...baseOutcome,
    arguments: { project },
    result: `status-${project}`,
  });
}
assert.strictEqual(state.reason, 'repeating_cycle');
assert.strictEqual(state.cycleLength, 2, 'an exact two-outcome cycle is detected');

const threeCycle = createLongRunController({
  unchangedSuccessThreshold: 20,
  identicalErrorThreshold: 20,
  cycleRepeatThreshold: 3,
  now: () => 0,
});
for (const project of ['a', 'b', 'c', 'a', 'b', 'c', 'a', 'b', 'c']) {
  state = threeCycle.recordOutcome({
    ...baseOutcome,
    arguments: { project },
    result: `status-${project}`,
  });
}
assert.strictEqual(state.reason, 'repeating_cycle');
assert.strictEqual(state.cycleLength, 3, 'an exact three-outcome cycle is detected');

const almostCycle = createLongRunController({
  unchangedSuccessThreshold: 20,
  identicalErrorThreshold: 20,
  cycleRepeatThreshold: 3,
  now: () => 0,
});
for (const result of ['a', 'b', 'a', 'b', 'a', 'changed']) {
  state = almostCycle.recordOutcome({ ...baseOutcome, result });
}
assert.strictEqual(state.stop, false, 'a changed cycle member prevents a false loop stop');

console.log('test-long-run-controller passed');
