import { runMdPrompt } from './md-llm.js';
import {
  redactTaskWorklogExcerpt,
  redactTaskWorklogText,
} from '../context/task-worklog.js';

const MAX_ITEMS = 20;
const MAX_TOOL_BATCH_CHARS = 64_000;
const MAX_TOOL_OUTPUT_CHARS = 8_000;

function list(value, maxItems = MAX_ITEMS, maxChars = 500) {
  const out = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const item = redactTaskWorklogText(raw, maxChars);
    if (!item || out.includes(item)) continue;
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function normalizeToolResultCheckpoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const normalized = {
    save: raw.save === true,
    summary: redactTaskWorklogText(raw.summary, 1600),
    completed: list(raw.completed, 16, 400),
    facts: list(raw.facts, 30, 600),
    evidence: list(raw.evidence, 20, 600),
    failures: list(raw.failures, 16, 600),
    nextSteps: list(raw.nextSteps, 16, 500),
    supersedes: list(raw.supersedes, 16, 500),
  };
  const hasContent = normalized.summary
    || normalized.completed.length
    || normalized.facts.length
    || normalized.evidence.length
    || normalized.failures.length
    || normalized.nextSteps.length;
  if (!normalized.save || !hasContent) return null;
  return normalized;
}

/**
 * Ask the MD-backed checkpoint prompt to distill one completed tool batch.
 * The caller persists the validated result; failures degrade to no checkpoint.
 */
export async function summarizeToolResultsForCheckpointOutcome({
  objective,
  plan = '',
  priorWorklog = '',
  toolResults = [],
  agentId,
  llmChat = null,
} = {}) {
  const candidates = (Array.isArray(toolResults) ? toolResults : []).slice(0, 16);
  const outputLimit = candidates.length > 0
    ? Math.min(MAX_TOOL_OUTPUT_CHARS, Math.floor(MAX_TOOL_BATCH_CHARS / candidates.length))
    : MAX_TOOL_OUTPUT_CHARS;
  const boundedResults = candidates
    .map((item) => ({
      skill: redactTaskWorklogText(item?.skill, 80),
      action: redactTaskWorklogText(item?.action, 120),
      target: redactTaskWorklogText(item?.target, 500),
      status: item?.status === 'error' ? 'error' : 'ok',
      output: redactTaskWorklogExcerpt(item?.output, outputLimit),
    }));
  if (!boundedResults.length) return { status: 'skipped', checkpoint: null };
  const result = await runMdPrompt({
    promptName: 'tool-result-checkpoint',
    user: {
      objective: redactTaskWorklogText(objective, 1600),
      plan: redactTaskWorklogText(plan, 1600),
      priorWorklog: redactTaskWorklogText(priorWorklog, 24_000),
      latestToolResults: boundedResults,
    },
    agentId,
    purpose: 'tool_result_checkpoint',
    maxTokens: 1400,
    llmChat,
  });
  if (!result || typeof result !== 'object') {
    return { status: 'failed', checkpoint: null };
  }
  const checkpoint = normalizeToolResultCheckpoint(result);
  if (checkpoint) return { status: 'saved', checkpoint };
  if (result.save === false) return { status: 'skipped', checkpoint: null };
  return { status: 'failed', checkpoint: null };
}

export async function summarizeToolResultsForCheckpoint(options = {}) {
  const outcome = await summarizeToolResultsForCheckpointOutcome(options);
  return outcome.checkpoint;
}
