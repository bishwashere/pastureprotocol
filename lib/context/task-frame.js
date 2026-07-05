import { existsSync, readFileSync } from 'fs';
import { getTaskFramesStorePath } from '../util/paths.js';
import { writeJsonAtomic } from '../util/atomic-write.js';
import { runMdPrompt } from '../agent/md-llm.js';

const VALID_ACTIONS = new Set(['continue_fast', 'continue_replan', 'new_candidate', 'exit', 'ignore']);
const VALID_KINDS = new Set(['repo_work', 'project_work', 'feature_work', 'debugging', 'general_task']);
const VALID_RESEMBLANCE = new Set(['strong', 'weak', 'none']);
const VALID_POST_TURN_STATUSES = new Set(['continue', 'completed', 'blocked', 'mismatch', 'waiting_user']);
const ACTIVE_STATUSES = new Set(['active', 'blocked', 'waiting_user']);
const VALID_STATUSES = new Set(['active', 'blocked', 'waiting_user', 'closed']);
const CONFIDENT_FRAME_THRESHOLD = 0.72;

function nowMs() {
  return Date.now();
}

function clean(text, max = 500) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function clampConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function frameKey(logKey) {
  return String(logKey || '').trim();
}

function emptyStore() {
  return { version: 1, frames: {} };
}

function readStore() {
  const path = getTaskFramesStorePath();
  if (!existsSync(path)) return emptyStore();
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8') || '{}');
    return {
      version: 1,
      frames: parsed && typeof parsed.frames === 'object' && parsed.frames ? parsed.frames : {},
    };
  } catch (_) {
    return emptyStore();
  }
}

function writeStore(store) {
  writeJsonAtomic(getTaskFramesStorePath(), {
    version: 1,
    frames: store?.frames && typeof store.frames === 'object' ? store.frames : {},
  });
}

function normalizeToolProfile(toolProfile, availableSkillIds = []) {
  const available = new Set(Array.isArray(availableSkillIds) ? availableSkillIds.map(String) : []);
  const ids = Array.isArray(toolProfile) ? toolProfile : [];
  return [...new Set(ids.map((id) => String(id || '').trim()).filter((id) => id && available.has(id)))].slice(0, 8);
}

function normalizeFrame(raw, logKey = '') {
  if (!raw || typeof raw !== 'object') return null;
  const key = frameKey(logKey || raw.logKey);
  if (!key) return null;
  const status = VALID_STATUSES.has(raw.status) ? raw.status : 'active';
  return {
    id: clean(raw.id || `frame-${nowMs().toString(36)}`, 80),
    logKey: key,
    status,
    kind: VALID_KINDS.has(raw.kind) ? raw.kind : 'general_task',
    title: clean(raw.title, 120),
    objective: clean(raw.objective, 500),
    projectName: clean(raw.projectName, 120),
    repoUrl: clean(raw.repoUrl, 300),
    localPath: clean(raw.localPath, 300),
    toolProfile: Array.isArray(raw.toolProfile) ? [...new Set(raw.toolProfile.map(String).filter(Boolean))].slice(0, 8) : [],
    plan: clean(raw.plan, 800),
    lastUserText: clean(raw.lastUserText, 500),
    lastAssistantText: clean(raw.lastAssistantText, 500),
    createdAtMs: Number.isFinite(Number(raw.createdAtMs)) ? Number(raw.createdAtMs) : nowMs(),
    updatedAtMs: Number.isFinite(Number(raw.updatedAtMs)) ? Number(raw.updatedAtMs) : nowMs(),
    lastSkillsCalled: Array.isArray(raw.lastSkillsCalled) ? raw.lastSkillsCalled.map(String).filter(Boolean).slice(0, 12) : [],
  };
}

function normalizeDecision(raw, availableSkillIds = []) {
  if (!raw || typeof raw !== 'object') {
    return {
      action: 'ignore',
      confidence: 0,
      mustUseTool: false,
      resemblance: 'none',
      kind: 'general_task',
      title: '',
      objective: '',
      projectName: '',
      repoUrl: '',
      localPath: '',
      toolProfile: [],
      plan: '',
      reason: '',
    };
  }
  let action = VALID_ACTIONS.has(raw.action) ? raw.action : 'ignore';
  if (raw.action === 'continue') action = 'continue_replan';
  if (raw.action === 'new') action = 'new_candidate';
  return {
    action,
    confidence: clampConfidence(raw.confidence),
    mustUseTool: raw.mustUseTool === true,
    resemblance: VALID_RESEMBLANCE.has(raw.resemblance) ? raw.resemblance : (action === 'continue_fast' ? 'strong' : 'none'),
    kind: VALID_KINDS.has(raw.kind) ? raw.kind : 'general_task',
    title: clean(raw.title, 120),
    objective: clean(raw.objective, 500),
    projectName: clean(raw.projectName, 120),
    repoUrl: clean(raw.repoUrl, 300),
    localPath: clean(raw.localPath, 300),
    toolProfile: normalizeToolProfile(raw.toolProfile, availableSkillIds),
    plan: clean(raw.plan, 800),
    reason: clean(raw.reason, 300),
  };
}

export function getActiveTaskFrame(logKey) {
  const key = frameKey(logKey);
  if (!key) return null;
  const store = readStore();
  const frame = normalizeFrame(store.frames[key], key);
  if (!frame || !ACTIVE_STATUSES.has(frame.status)) return null;
  return frame;
}

export function clearTaskFrame(logKey, meta = {}) {
  const key = frameKey(logKey);
  if (!key) return null;
  const store = readStore();
  const existing = normalizeFrame(store.frames[key], key);
  if (!existing) return null;
  store.frames[key] = {
    ...existing,
    status: 'closed',
    updatedAtMs: nowMs(),
    closeReason: clean(meta.reason, 300),
  };
  writeStore(store);
  return store.frames[key];
}

export function upsertTaskFrame(logKey, decision, existingFrame = null, meta = {}) {
  const key = frameKey(logKey);
  if (!key || !decision || typeof decision !== 'object') return null;
  const store = readStore();
  const existing = meta.replace === true ? null : normalizeFrame(existingFrame || store.frames[key], key);
  const stamp = nowMs();
  const frame = normalizeFrame({
    ...(existing || {}),
    id: existing?.id || `frame-${stamp.toString(36)}`,
    logKey: key,
    status: 'active',
    kind: decision.kind || existing?.kind,
    title: decision.title || existing?.title || decision.objective,
    objective: decision.objective || existing?.objective || decision.title,
    projectName: decision.projectName || existing?.projectName,
    repoUrl: decision.repoUrl || existing?.repoUrl,
    localPath: decision.localPath || existing?.localPath,
    toolProfile: decision.toolProfile?.length ? decision.toolProfile : existing?.toolProfile,
    plan: decision.plan || existing?.plan,
    lastUserText: meta.userText || existing?.lastUserText,
    createdAtMs: existing?.createdAtMs || stamp,
    updatedAtMs: stamp,
  }, key);
  store.frames[key] = frame;
  writeStore(store);
  return frame;
}

export function updateTaskFrameAfterTurn(logKey, patch = {}) {
  const key = frameKey(logKey);
  if (!key) return null;
  const store = readStore();
  const existing = normalizeFrame(store.frames[key], key);
  if (!existing) return null;
  const frame = normalizeFrame({
    ...existing,
    status: ACTIVE_STATUSES.has(patch.status) ? patch.status : existing.status,
    lastUserText: patch.userText || existing.lastUserText,
    lastAssistantText: patch.assistantText || existing.lastAssistantText,
    lastSkillsCalled: Array.isArray(patch.skillsCalled) ? patch.skillsCalled : existing.lastSkillsCalled,
    updatedAtMs: nowMs(),
  }, key);
  store.frames[key] = frame;
  writeStore(store);
  return frame;
}

export async function classifyTaskFrameTurn({
  logKey,
  userText,
  historyMessages = [],
  availableSkillIds = [],
  availableSkillSummaries = [],
  agentId,
  llmChat = null,
} = {}) {
  const activeFrame = getActiveTaskFrame(logKey);
  const result = await runMdPrompt({
    promptName: 'task-frame-router',
    user: {
      latestUserMessage: clean(userText, 1000),
      recentConversation: (historyMessages || []).slice(-6).map((m) => `${m.role || 'user'}: ${clean(m.content, 400)}`).join('\n'),
      activeFrame,
      availableSkillIds,
      availableSkillSummaries: (availableSkillSummaries || []).slice(0, 30),
    },
    agentId,
    purpose: 'task_frame_router',
    llmChat,
  });
  const decision = normalizeDecision(result, availableSkillIds);
  return { activeFrame, decision };
}

export function shouldUseTaskFrameFastPath(decision) {
  return !!decision
    && decision.action === 'continue_fast'
    && decision.confidence >= CONFIDENT_FRAME_THRESHOLD
    && decision.resemblance === 'strong';
}

export function taskFrameDecisionToTurnRoute(decision, frame) {
  if (!decision || !frame) return null;
  return {
    mode: decision.kind === 'repo_work' || decision.kind === 'feature_work' || decision.kind === 'debugging' ? 'code' : 'tool',
    skills: Array.isArray(frame.toolProfile) ? frame.toolProfile : [],
    executionMode: 'tool_use',
    usesExistingWorkIntake: true,
    mustUseTool: decision.mustUseTool === true,
    plan: decision.plan || frame.plan || `Continue active task frame: ${frame.objective || frame.title || frame.kind}.`,
    answer_style: 'short',
    taskFrame: true,
  };
}

function normalizePostTurnStatus(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      status: 'continue',
      confidence: 0,
      reason: '',
    };
  }
  const status = VALID_POST_TURN_STATUSES.has(raw.status) ? raw.status : 'continue';
  return {
    status,
    confidence: clampConfidence(raw.confidence),
    reason: clean(raw.reason, 300),
  };
}

export async function classifyTaskFrameStatusAfterTurn({
  frame,
  userText,
  assistantText,
  skillsCalled = [],
  agentId,
  llmChat = null,
} = {}) {
  if (!frame) return null;
  const result = await runMdPrompt({
    promptName: 'task-frame-status',
    user: {
      frame,
      latestUserMessage: clean(userText, 1000),
      assistantReply: clean(assistantText, 1200),
      skillsCalled: Array.isArray(skillsCalled) ? skillsCalled.map(String).slice(0, 20) : [],
    },
    agentId,
    purpose: 'task_frame_status',
    llmChat,
  });
  return normalizePostTurnStatus(result);
}

export function taskFrameToSystemBlock(frame, decision = null) {
  if (!frame) return '';
  const lines = [
    '',
    '',
    '--- Active Task Frame ---',
    `Kind: ${frame.kind}`,
    frame.title ? `Title: ${frame.title}` : '',
    frame.objective ? `Objective: ${frame.objective}` : '',
    frame.projectName ? `Project: ${frame.projectName}` : '',
    frame.repoUrl ? `Repo URL: ${frame.repoUrl}` : '',
    frame.localPath ? `Local path: ${frame.localPath}` : '',
    frame.toolProfile?.length ? `Tool profile: ${frame.toolProfile.join(', ')}` : '',
    decision?.reason ? `Frame decision: ${decision.action} (${Math.round(decision.confidence * 100)}%) — ${decision.reason}` : '',
    'Use this frame as soft context for this turn. If tool evidence contradicts it, trust the tools and say what changed.',
    '---',
  ].filter(Boolean);
  return lines.join('\n');
}

export const TASK_FRAME_CONFIDENT_THRESHOLD = CONFIDENT_FRAME_THRESHOLD;
