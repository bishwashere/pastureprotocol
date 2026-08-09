import { createHash } from 'crypto';

const DEFAULT_INITIAL_ROUNDS = 30;
const DEFAULT_GRANT_ROUNDS = 30;
const DEFAULT_HARD_ROUNDS = 1_000;
const DEFAULT_MAX_RUNTIME_MS = 6 * 60 * 60 * 1_000;
const DEFAULT_UNCHANGED_SUCCESS_THRESHOLD = 6;
const DEFAULT_IDENTICAL_ERROR_THRESHOLD = 3;
const DEFAULT_CYCLE_REPEAT_THRESHOLD = 3;

function nonNegativeInt(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function repeatedThreshold(value, fallback) {
  return Math.max(2, nonNegativeInt(value, fallback));
}

/**
 * Deterministic serialization for structured tool arguments. Object key order
 * does not affect the result; array order does. Tool arguments normally come
 * from JSON, but the extra scalar cases keep this helper total for callers.
 */
export function canonicalizeToolValue(value, ancestors = new Set()) {
  if (value === null) return 'null';
  if (value === undefined) return '"[undefined]"';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  }
  if (typeof value === 'bigint') return JSON.stringify(`${value}n`);
  if (typeof value !== 'object') return JSON.stringify(String(value));

  if (ancestors.has(value)) return '"[circular]"';
  ancestors.add(value);
  let serialized;
  if (Array.isArray(value)) {
    serialized = `[${value.map((item) => canonicalizeToolValue(item, ancestors)).join(',')}]`;
  } else {
    const pairs = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeToolValue(value[key], ancestors)}`);
    serialized = `{${pairs.join(',')}}`;
  }
  ancestors.delete(value);
  return serialized;
}

function rawResultText(result) {
  return typeof result === 'string' ? result : canonicalizeToolValue(result);
}

/**
 * Fingerprint only structured execution data. No user-language interpretation
 * occurs here. The raw result string is deliberately preserved byte-for-byte,
 * so a changing poll result counts as new evidence.
 */
export function fingerprintToolOutcome({
  skillId = '',
  toolName = '',
  arguments: toolArguments = {},
  result = '',
  isError = false,
} = {}) {
  const payload = [
    canonicalizeToolValue(String(skillId || '')),
    canonicalizeToolValue(String(toolName || '')),
    canonicalizeToolValue(toolArguments),
    canonicalizeToolValue(rawResultText(result)),
    isError === true ? 'error' : 'ok',
  ].join('\n');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function repeatingCycleLength(history, repeatThreshold) {
  for (let cycleLength = 2; cycleLength <= 3; cycleLength++) {
    const required = cycleLength * repeatThreshold;
    if (history.length < required) continue;
    const tail = history.slice(-required);
    const pattern = tail.slice(0, cycleLength);
    // A run of one unchanged outcome belongs to the more precise unchanged
    // success/error breakers, not the repeating-cycle breaker.
    if (new Set(pattern).size < 2) continue;
    let matches = true;
    for (let index = cycleLength; index < tail.length; index++) {
      if (tail[index] !== pattern[index % cycleLength]) {
        matches = false;
        break;
      }
    }
    if (matches) return cycleLength;
  }
  return 0;
}

/**
 * Pure mechanical state for an adaptive long-running tool loop.
 *
 * `completeRound()` consumes a round. At the current grant boundary it reports
 * `needsGrant: true`; a semantic caller may then decide whether to call
 * `grant()`. Abort, wall-clock, loop, and hard-round stops are enforced here.
 */
export function createLongRunController({
  initialRounds = DEFAULT_INITIAL_ROUNDS,
  grantRounds = DEFAULT_GRANT_ROUNDS,
  hardRounds = DEFAULT_HARD_ROUNDS,
  maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
  unchangedSuccessThreshold = DEFAULT_UNCHANGED_SUCCESS_THRESHOLD,
  identicalErrorThreshold = DEFAULT_IDENTICAL_ERROR_THRESHOLD,
  cycleRepeatThreshold = DEFAULT_CYCLE_REPEAT_THRESHOLD,
  now = Date.now,
  abortSignal = null,
} = {}) {
  const initialBudget = nonNegativeInt(initialRounds, DEFAULT_INITIAL_ROUNDS);
  const grantBudget = nonNegativeInt(grantRounds, DEFAULT_GRANT_ROUNDS);
  const hardBudget = nonNegativeInt(hardRounds, DEFAULT_HARD_ROUNDS);
  const runtimeBudget = nonNegativeInt(maxRuntimeMs, DEFAULT_MAX_RUNTIME_MS);
  const successThreshold = repeatedThreshold(
    unchangedSuccessThreshold,
    DEFAULT_UNCHANGED_SUCCESS_THRESHOLD,
  );
  const errorThreshold = repeatedThreshold(
    identicalErrorThreshold,
    DEFAULT_IDENTICAL_ERROR_THRESHOLD,
  );
  const cycleThreshold = repeatedThreshold(
    cycleRepeatThreshold,
    DEFAULT_CYCLE_REPEAT_THRESHOLD,
  );
  const clock = typeof now === 'function' ? now : Date.now;
  const firstNow = Number(clock());
  const startedAt = Number.isFinite(firstNow) ? firstNow : 0;
  const maxHistory = Math.max(6, 3 * cycleThreshold);

  let roundsUsed = 0;
  let roundLimit = Math.min(initialBudget, hardBudget);
  let stopped = null;
  let previousFingerprint = '';
  let consecutiveCount = 0;
  const outcomeHistory = [];

  const elapsedMs = () => {
    const current = Number(clock());
    return Number.isFinite(current) ? Math.max(0, current - startedAt) : 0;
  };

  const setStop = (reason, details = {}) => {
    if (!stopped) stopped = { reason, ...details };
    return stopped;
  };

  const status = () => ({
    stop: Boolean(stopped),
    reason: stopped?.reason || null,
    ...(stopped?.repeatCount ? { repeatCount: stopped.repeatCount } : {}),
    ...(stopped?.cycleLength ? { cycleLength: stopped.cycleLength } : {}),
    roundsUsed,
    roundLimit,
    initialRounds: initialBudget,
    grantRounds: grantBudget,
    hardRounds: hardBudget,
    remainingInGrant: Math.max(0, roundLimit - roundsUsed),
    remainingHardRounds: Math.max(0, hardBudget - roundsUsed),
    needsGrant: !stopped && roundsUsed >= roundLimit && roundsUsed < hardBudget,
    elapsedMs: elapsedMs(),
    maxRuntimeMs: runtimeBudget,
  });

  const check = ({
    abortSignal: currentAbortSignal = null,
    enforceLimits = true,
  } = {}) => {
    if (stopped) return status();
    if (abortSignal?.aborted || currentAbortSignal?.aborted) {
      setStop('aborted');
    } else if (enforceLimits !== false && elapsedMs() >= runtimeBudget) {
      setStop('max_runtime');
    } else if (enforceLimits !== false && roundsUsed >= hardBudget) {
      setStop('max_rounds');
    }
    return status();
  };

  const completeRound = (count = 1, options = {}) => {
    const before = check(options);
    if (before.stop) return before;
    const amount = nonNegativeInt(count, 1);
    roundsUsed = options?.enforceLimits === false
      ? roundsUsed + amount
      : Math.min(hardBudget, roundsUsed + amount);
    return check(options);
  };

  const grant = (options = {}) => {
    const before = check(options);
    if (before.stop) return { ...before, extended: false, grantedRounds: 0 };
    if (!before.needsGrant || grantBudget === 0) {
      return { ...before, extended: false, grantedRounds: 0 };
    }
    const priorLimit = roundLimit;
    roundLimit = Math.min(hardBudget, roundLimit + grantBudget);
    return {
      ...status(),
      extended: roundLimit > priorLimit,
      grantedRounds: roundLimit - priorLimit,
    };
  };

  const recordOutcome = (outcome = {}) => {
    const before = check({
      abortSignal: outcome.abortSignal,
      enforceLimits: outcome.enforceLimits,
    });
    if (before.stop) return { ...before, fingerprint: null };

    const fingerprint = fingerprintToolOutcome(outcome);
    if (fingerprint === previousFingerprint) consecutiveCount += 1;
    else consecutiveCount = 1;
    previousFingerprint = fingerprint;

    outcomeHistory.push(fingerprint);
    if (outcomeHistory.length > maxHistory) outcomeHistory.shift();

    const isError = outcome.isError === true;
    const threshold = isError ? errorThreshold : successThreshold;
    if (consecutiveCount >= threshold) {
      setStop(
        isError ? 'repeated_identical_error' : 'repeated_unchanged_success',
        { repeatCount: consecutiveCount },
      );
    } else {
      const cycleLength = repeatingCycleLength(outcomeHistory, cycleThreshold);
      if (cycleLength > 0) {
        setStop('repeating_cycle', {
          cycleLength,
          repeatCount: cycleThreshold,
        });
      }
    }

    return {
      ...status(),
      fingerprint,
      consecutiveCount,
    };
  };

  return Object.freeze({
    check,
    completeRound,
    grant,
    recordOutcome,
    snapshot: status,
  });
}
