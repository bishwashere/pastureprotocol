import { isNonTaskMessage } from './evaluate-team-capability.js';
import { createMission, listMissions } from './missions.js';
import { resolveMissionForUserTurn } from './missions-context.js';
import { listVisibleAgentIds } from './agent-config.js';
import { chat as defaultLlmChat } from '../llm.js';
import { listProjects } from './projects-db.js';

const DURABILITY_SYSTEM =
  'You are a work durability classifier. Return ONLY valid JSON — no prose, no markdown fences, no extra keys.';
const MISSION_RESOLUTION_SYSTEM =
  'You are a mission and task matcher for follow-up chat messages. Return ONLY valid JSON — no prose, no markdown fences, no extra keys.';
const DECOMPOSITION_SYSTEM =
  'You decompose persistent user work into small useful subtasks. Write task titles as short plain-English action phrases a non-technical founder can understand at a glance — never internal labels or jargon (e.g. "Check if chess999.com is taken" not "Validate domain availability"). Return ONLY valid JSON — no prose, no markdown fences, no extra keys.';

const VALID_WORK_MODES = new Set([
  'direct_answer',
  'one_off_delegated_answer',
  'existing_mission_task_update',
  'new_mission_candidate',
]);
const VALID_SUBTASK_TYPES = new Set(['marketing', 'product', 'engineering', 'research', 'planning', 'operations', 'design', 'content']);

function clean(text, max = 180) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
}

function slugPart(text, fallback) {
  const s = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return s || fallback;
}

function extractProductName(userText) {
  const text = String(userText || '');
  const direct = text.match(/\b(?:called|named)\s+([A-Z][A-Za-z0-9_-]{1,40})\b/);
  if (direct) return direct[1];
  const launch = text.match(/\b(?:launching|launch)\s+([A-Z][A-Za-z0-9_-]{1,40})\b/);
  if (launch) return launch[1];
  return '';
}

function stripJsonFences(raw) {
  return String(raw || '')
    .trim()
    .replace(/^```[a-z]*\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim();
}

function flattenTasks(list, out = []) {
  for (const sg of list || []) {
    if (!sg) continue;
    out.push(sg);
    flattenTasks(sg.tasks, out);
  }
  return out;
}

function recentActiveMissionsForResolution(limit = 8) {
  try {
    const missions = listMissions().missions || [];
    return missions
      .filter((g) => String(g.status || 'active').toLowerCase() === 'active')
      .sort((a, b) => {
        const bTs = Number(b.updatedAt || b.lastRunAt || b.createdAt || 0);
        const aTs = Number(a.updatedAt || a.lastRunAt || a.createdAt || 0);
        return bTs - aTs;
      })
      .slice(0, limit);
  } catch (_) {
    return [];
  }
}

function formatMissionsForAiResolution(missions) {
  return (missions || []).map((mission) => {
    const subs = flattenTasks(mission.tasks || [])
      .slice(0, 12)
      .map((sg) => `    - ${sg.id || ''}: ${sg.title || ''} [${sg.status || 'todo'}]`)
      .join('\n');
    return [
      `- missionId: ${mission.id}`,
      `  title: ${mission.title || ''}`,
      `  objective: ${clean(mission.objective || '', 220)}`,
      `  owner: ${mission.ownerAgentId || ''}`,
      subs ? `  tasks:\n${subs}` : '',
      mission.lastActivity ? `  lastActivity: ${clean(mission.lastActivity, 180)}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
}

function findTaskMatch(mission, taskMatch) {
  const match = clean(taskMatch, 120).toLowerCase();
  if (!mission || !match) return null;
  return flattenTasks(mission.tasks || []).find((sg) => {
    const id = String(sg.id || '').toLowerCase();
    const title = String(sg.title || '').toLowerCase();
    return id === match || title.includes(match) || match.includes(title);
  }) || null;
}

function normalizeAiMissionResolution(parsed, missions) {
  const missionMatch = String(parsed?.missionMatch || parsed?.match || '').trim();
  const missionId = String(parsed?.missionId || '').trim();
  const confidenceRaw = Number(parsed?.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0;
  if (!missionId || confidence < 0.65) return null;
  if (!['recent_mission', 'existing_mission', 'active_mission'].includes(missionMatch)) return null;
  const mission = (missions || []).find((g) => String(g.id || '') === missionId);
  if (!mission) return null;
  const taskMatch = clean(parsed?.taskMatch || parsed?.taskId || parsed?.task || '', 120);
  const task = findTaskMatch(mission, taskMatch);
  return {
    kind: 'existing_mission_task_update',
    persistence: 'attach_existing_mission',
    missionId: mission.id,
    mission,
    taskMatch,
    taskId: task?.id || '',
    confidence,
    classifier: 'ai-mission-resolution',
    reason: clean(parsed?.reason || `AI matched this follow-up to "${mission.title || mission.id}".`, 240),
  };
}

async function resolveMissionForUserTurnWithAi(opts = {}) {
  const missions = recentActiveMissionsForResolution();
  if (!missions.length) return null;
  const llmChat = typeof opts.llmChat === 'function' ? opts.llmChat : defaultLlmChat;
  const history = (opts.historyMessages || [])
    .slice(-6)
    .map((m) => `${m.role || 'user'}: ${String(m.content || '').slice(0, 220)}`)
    .join('\n');
  const knownProjects = getKnownProjectNames();
  const prompt = [
    history ? `Recent conversation:\n${history}\n` : '',
    `Latest user message:\n${String(opts.userText || '').slice(0, 800)}`,
    '',
    knownProjects.length ? `Registered projects (any mention or confirmation about these should be matched to a mission if one exists): ${knownProjects.join(', ')}` : '',
    '',
    'Recent active missions and tasks:',
    formatMissionsForAiResolution(missions) || '(none)',
    '',
    'Decide whether the latest message is a follow-up/update to one of these missions or tasks.',
    'Only match when the reference is reasonably clear from wording or recent context.',
    'Return JSON only:',
    '{',
    '  "missionMatch": "recent_mission | existing_mission | none",',
    '  "missionId": "",',
    '  "taskMatch": "",',
    '  "confidence": 0.0,',
    '  "reason": "one sentence"',
    '}',
  ].filter(Boolean).join('\n');

  try {
    const raw = await llmChat(
      [
        { role: 'system', content: MISSION_RESOLUTION_SYSTEM },
        { role: 'user', content: prompt },
      ],
      { agentId: opts.agentId || 'main', purpose: 'work_durability_mission_resolution' },
    );
    return normalizeAiMissionResolution(JSON.parse(stripJsonFences(raw)), missions);
  } catch (err) {
    console.log('[work-durability] ai mission resolution failed, continuing:', err?.message || err);
    return null;
  }
}

function parseNumberedDeliverables(userText) {
  const out = [];
  const lines = String(userText || '').split(/\r?\n/);
  for (const line of lines) {
    const m = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.+?)\s*$/);
    if (!m) continue;
    const item = clean(m[1], 120);
    if (item && !out.includes(item)) out.push(item);
  }
  return out.slice(0, 8);
}

function inferDeliverables(userText) {
  const text = String(userText || '').toLowerCase();
  const items = parseNumberedDeliverables(userText);
  const push = (label) => {
    if (!items.some((item) => item.toLowerCase().includes(label.toLowerCase()))) items.push(label);
  };
  if (/\bpositioning|value prop|tagline\b/.test(text)) push('Positioning statement');
  if (/\bposts?|threads?|launch content|social\b/.test(text)) push('Launch posts');
  if (/\blanding page|checklist\b/.test(text)) push('Landing page checklist');
  if (/\banalytics|funnel|instrument|metrics\b/.test(text)) push('Analytics and measurement plan');
  return items.slice(0, 8);
}

function getKnownProjectNames() {
  try {
    return listProjects()
      .map((p) => String(p.name || '').trim())
      .filter((n) => n.length >= 2);
  } catch (_) {
    return [];
  }
}

function mentionsKnownProject(userText) {
  const text = String(userText || '').toLowerCase();
  if (!text.trim()) return false;
  const names = getKnownProjectNames();
  return names.some((name) => text.includes(name.toLowerCase()));
}

function findMentionedProjectName(userText) {
  const text = String(userText || '').toLowerCase();
  if (!text.trim()) return '';
  const names = getKnownProjectNames();
  return names.find((name) => text.includes(name.toLowerCase())) || '';
}

/**
 * Returns one of three confidence levels when a known project is mentioned:
 *   'high'    — project + explicit multi-deliverable list → auto-create mission
 *   'medium'  — project + action verb but no deliverables → ask confirmation in chat
 *   'none'    — no known project mentioned
 *
 * For messages without a known project name the classic durable-verb+deliverable
 * check is still used and returns 'high' directly.
 */
function knownProjectMentionConfidence(userText) {
  if (!String(userText || '').trim() || isNonTaskMessage(userText)) return 'none';
  const projectName = findMentionedProjectName(userText);
  if (projectName) {
    const deliverables = inferDeliverables(userText);
    if (deliverables.length >= 2) return 'high';
    const text = String(userText || '').toLowerCase();
    const hasWorkIntent = /\b(improve|increase|grow|fix|reduce|launch|build|ship|prepare|plan|add|create|redesign|optimize|boost|scale)\b/.test(text);
    if (hasWorkIntent) return 'medium';
    return 'none';
  }
  // No known project — fall back to explicit multi-deliverable heuristic.
  const text = String(userText || '').toLowerCase();
  const deliverables = inferDeliverables(userText);
  const hasDurableVerb = /\b(launch|launching|ship|build|prepare|plan|campaign|project|next week|this week|roadmap)\b/.test(text);
  if (hasDurableVerb && deliverables.length >= 2) return 'high';
  return 'none';
}

function looksLikeNewMissionCandidate(userText) {
  return knownProjectMentionConfidence(userText) === 'high';
}

function buildMissionTasks(userText, agentId, deliverables = []) {
  const titles = Array.isArray(deliverables) && deliverables.length
    ? deliverables.map((d) => clean(d, 120)).filter(Boolean)
    : inferDeliverables(userText);
  return titles.map((title, idx) => ({
    id: `sg-${slugPart(title, `item-${idx + 1}`)}`,
    title: clean(title, 120),
    status: 'todo',
    progress: 0,
    assignee: agentId,
    dependsOn: [],
    tasks: [],
  }));
}

function allowedSuggestedAgents(defaultAgentId = 'main') {
  const ids = new Set(['main', String(defaultAgentId || 'main').trim() || 'main']);
  try {
    listVisibleAgentIds().forEach((id) => ids.add(id));
  } catch (_) {
    ids.add('marketer');
    ids.add('alex');
  }
  // Keep common team fixtures useful even in isolated tests before agents exist.
  ids.add('marketer');
  ids.add('alex');
  return ids;
}

function inferSubtaskType(title) {
  const t = String(title || '').toLowerCase();
  if (/position|post|social|campaign|messaging|tagline|brand|content/.test(t)) return 'marketing';
  if (/page|checklist|product|launch item|missing/.test(t)) return 'product';
  if (/analytics|tracking|instrument|code|implement|technical/.test(t)) return 'engineering';
  if (/research|audit|competitor|identify/.test(t)) return 'research';
  return 'planning';
}

function normalizeSubtasks(rawSubtasks, opts = {}) {
  const defaultAgentId = String(opts.agentId || 'main').trim() || 'main';
  const allowedAgents = allowedSuggestedAgents(defaultAgentId);
  const raw = Array.isArray(rawSubtasks) ? rawSubtasks : [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const title = clean(typeof item === 'string' ? item : item?.title, 120);
    if (!title) continue;
    const key = title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const typeRaw = clean(typeof item === 'object' ? item?.type : '', 40).toLowerCase();
    const type = VALID_SUBTASK_TYPES.has(typeRaw) ? typeRaw : inferSubtaskType(title);
    const suggestedRaw = clean(typeof item === 'object' ? item?.suggestedAgent : '', 80).toLowerCase();
    const suggestedAgent = allowedAgents.has(suggestedRaw) ? suggestedRaw : defaultAgentId;
    const confidenceRaw = Number(typeof item === 'object' ? item?.confidence : 0);
    const routeConfidence = Number.isFinite(confidenceRaw) && confidenceRaw > 0
      ? Math.max(0, Math.min(1, confidenceRaw))
      : (type === 'marketing' ? 0.88 : type === 'product' ? 0.74 : 0.72);
    const routeReason = clean(
      typeof item === 'object' ? item?.reason : '',
      180,
    ) || `AI decomposition classified this as ${type} work for ${suggestedAgent}.`;
    const aiDescription = clean(typeof item === 'object' ? item?.description : '', 400);
    const aiExpectedOutput = clean(typeof item === 'object' ? item?.expectedOutput : '', 200);
    const description = aiDescription || routeReason;
    const task = {
      id: `sg-${slugPart(title, `item-${out.length + 1}`)}`,
      title,
      status: 'todo',
      progress: 0,
      assignee: suggestedAgent,
      suggestedAgent,
      type,
      routeConfidence,
      routeReason,
      dependsOn: [],
      tasks: [],
      description,
    };
    if (aiExpectedOutput) task.expectedOutput = aiExpectedOutput;
    out.push(task);
    if (out.length >= 8) break;
  }
  return out;
}

async function decomposePersistentWorkWithAi(opts = {}) {
  const llmChat = typeof opts.llmChat === 'function' ? opts.llmChat : defaultLlmChat;
  const userText = String(opts.userText || '');
  const projectName = clean(opts.projectName || '', 80);
  const fallback = buildMissionTasks(userText, opts.agentId || 'main', opts.deliverables || []);
  const agents = [...allowedSuggestedAgents(opts.agentId || 'main')].join(', ');
  const prompt = [
    `User message:\n${userText.slice(0, 1000)}`,
    projectName ? `Project/product name: ${projectName}` : '',
    '',
    'Decompose this persistent work into 2-6 concrete subtasks.',
    'Prefer useful work units over copying keywords. Include missing obvious launch/project work when implied.',
    `Allowed suggestedAgent values: ${agents}`,
    `Allowed type values: ${[...VALID_SUBTASK_TYPES].join(', ')}`,
    '',
    'Field rules:',
    '- title: short plain-English action phrase (e.g. "Check if Chess 999 has an active chess.com club" not "Quantify chess.com Chess 999 club size/activity")',
    '- description: one sentence explaining why this matters to the project',
    '- expectedOutput: what the agent will produce (e.g. "member count, activity level, and screenshot proof")',
    '',
    'Return JSON only:',
    '{',
    '  "subtasks": [',
    '    { "title": "", "description": "", "expectedOutput": "", "type": "marketing", "suggestedAgent": "main", "confidence": 0.0, "reason": "" }',
    '  ]',
    '}',
  ].filter(Boolean).join('\n');

  try {
    const raw = await llmChat(
      [
        { role: 'system', content: DECOMPOSITION_SYSTEM },
        { role: 'user', content: prompt },
      ],
      { agentId: opts.agentId || 'main', purpose: 'work_durability_decompose' },
    );
    const parsed = JSON.parse(stripJsonFences(raw));
    const normalized = normalizeSubtasks(parsed?.subtasks, opts);
    return normalized.length ? normalized : fallback;
  } catch (err) {
    console.log('[work-durability] ai decomposition failed, using deterministic fallback:', err?.message || err);
    return fallback;
  }
}

function missionTitleFor(userText, projectName = '') {
  const product = clean(projectName, 60) || extractProductName(userText);
  if (product) return `Launch ${product}`;
  const firstLine = String(userText || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || 'New mission';
  return clean(firstLine.replace(/[.!?]+$/g, ''), 80);
}

/**
 * Looks at the tail of assistant history to see if the agent recently asked the
 * user to confirm creating a mission (mission_suggest path). If so, and the
 * current user message is an affirmative, extract the project name from history.
 */
function detectMissionConfirmation(userText, historyMessages) {
  const text = String(userText || '').toLowerCase().trim();
  if (!text) return '';
  const isAffirmative = /^(yes|yep|yeah|sure|do it|go ahead|create it|create the mission|open it|open the mission|sounds good|ok|okay|please|go for it|make it|yes please)[.!?]?$/.test(text);
  if (!isAffirmative) return '';
  // Scan recent assistant turns for the mission_suggest question pattern.
  const recentAssistant = (historyMessages || [])
    .slice(-6)
    .filter((m) => String(m.role || '') === 'assistant')
    .map((m) => String(m.content || '').toLowerCase());
  const knownProjects = getKnownProjectNames();
  for (const msg of recentAssistant) {
    if (!/mission/.test(msg)) continue;
    for (const name of knownProjects) {
      if (msg.includes(name.toLowerCase())) return name;
    }
  }
  return '';
}

function deterministicFastPath({ userText = '', historyMessages = [], agentId = 'main' } = {}) {
  // Check for affirmative confirmation of a pending mission_suggest before the
  // isNonTaskMessage guard, since short "yes" replies would otherwise be filtered.
  const confirmedProject = detectMissionConfirmation(userText, historyMessages);
  if (confirmedProject) {
    return {
      kind: 'new_mission_candidate',
      persistence: 'create_lightweight_mission',
      confidence: 0.9,
      classifier: 'deterministic',
      reason: `User confirmed creating a mission for "${confirmedProject}".`,
      projectName: confirmedProject,
      title: `${confirmedProject} work`,
      confirmedFromSuggest: true,
    };
  }

  if (isNonTaskMessage(userText)) {
    return {
      kind: 'direct_answer',
      persistence: 'none',
      confidence: 1,
      classifier: 'deterministic',
      reason: 'Simple chat does not need persistent work state.',
    };
  }

  const existingMission = resolveMissionForUserTurn({ userText, historyMessages, agentId });
  if (existingMission) {
    return {
      kind: 'existing_mission_task_update',
      persistence: 'attach_existing_mission',
      missionId: existingMission.id,
      mission: existingMission,
      confidence: 1,
      classifier: 'deterministic',
      reason: `Message matches existing mission "${existingMission.title || existingMission.id}".`,
    };
  }

  const text = String(userText || '').toLowerCase();
  if (/^\s*(remind me|reminder|set a reminder)\b/.test(text)) {
    return {
      kind: 'one_off_delegated_answer',
      persistence: 'none',
      confidence: 1,
      classifier: 'deterministic',
      reason: 'Reminder requests are handled by cron, not mission persistence.',
    };
  }

  if (/^\s*(what is|what's|what are|who is|who's|define|explain|tell me about)\b/.test(text) && !/\b(next week|this week|launch|build|ship|prepare|plan)\b/.test(text)) {
    return {
      kind: 'direct_answer',
      persistence: 'none',
      confidence: 0.9,
      classifier: 'deterministic',
      reason: 'Simple explanation question does not need persistent work state.',
    };
  }

  // Casual info-retrieval queries: news, weather, scores, time, etc.
  if (/\b(latest news|today's news|top stories|weather|what time|current time|score|headlines)\b/.test(text) && !/\b(next week|this week|launch|build|ship|prepare|plan|project|campaign)\b/.test(text)) {
    return {
      kind: 'one_off_delegated_answer',
      persistence: 'none',
      confidence: 0.9,
      classifier: 'deterministic',
      reason: 'Casual information lookup does not need persistent work state.',
    };
  }

  return null;
}

function fallbackRuleDecision({ userText = '', agentId = 'main' } = {}) {
  const projectConfidence = knownProjectMentionConfidence(userText);

  if (projectConfidence === 'high') {
    const projectName = findMentionedProjectName(userText);
    return {
      kind: 'new_mission_candidate',
      persistence: 'create_lightweight_mission',
      confidence: 0.75,
      classifier: 'deterministic',
      reason: 'Multi-part launch/project work should be tracked before delegation.',
      projectName,
      title: missionTitleFor(userText, projectName),
      tasks: buildMissionTasks(userText, agentId),
    };
  }

  if (projectConfidence === 'medium') {
    const projectName = findMentionedProjectName(userText);
    return {
      kind: 'mission_suggest',
      persistence: 'none',
      confidence: 0.65,
      classifier: 'deterministic',
      reason: 'User mentioned a tracked project with work intent, but no explicit deliverables — ask before creating a mission.',
      projectName,
      title: missionTitleFor(userText, projectName),
    };
  }

  return {
    kind: 'one_off_delegated_answer',
    persistence: 'none',
    confidence: 0.7,
    classifier: 'deterministic',
    reason: 'Task can be answered in the current turn without durable state.',
  };
}

export function classifyWorkDurability({ userText = '', historyMessages = [], agentId = 'main' } = {}) {
  return deterministicFastPath({ userText, historyMessages, agentId })
    || fallbackRuleDecision({ userText, agentId });
}

function normalizeAiDecision(parsed, opts = {}) {
  const userText = opts.userText || '';
  const agentId = opts.agentId || 'main';
  const workMode = String(parsed?.workMode || parsed?.kind || '').trim();
  const confidenceRaw = Number(parsed?.confidence);
  const confidence = Number.isFinite(confidenceRaw)
    ? Math.max(0, Math.min(1, confidenceRaw))
    : 0;
  if (!VALID_WORK_MODES.has(workMode)) return null;

  const requiresPersistence = parsed?.requiresPersistence === true;
  const reason = clean(parsed?.reason || '', 240);
  const projectName = clean(parsed?.projectName || parsed?.project || '', 80);
  const deliverables = Array.isArray(parsed?.deliverables)
    ? parsed.deliverables.map((d) => clean(d, 120)).filter(Boolean).slice(0, 8)
    : [];

  if (requiresPersistence && workMode === 'new_mission_candidate' && confidence >= 0.6) {
    const textLower = String(userText || '').toLowerCase();
    const tooShortForMission = textLower.length < 40 && !projectName;
    const looksLikeCasualQuery = /^\s*(what's|what is|show me|give me|tell me|get me|go to)\b/.test(textLower) &&
      !/\b(build|create|launch|ship|plan|project|campaign|implement|deploy|develop|redesign|refactor|grow|increase|improve|add|integrate)\b/.test(textLower);
    if (tooShortForMission || looksLikeCasualQuery) {
      return {
        kind: 'one_off_delegated_answer',
        persistence: 'none',
        confidence: Math.max(0.7, confidence),
        classifier: 'ai_overridden',
        reason: 'AI suggested mission but message looks like a casual one-off query.',
      };
    }
    return {
      kind: 'new_mission_candidate',
      persistence: 'create_lightweight_mission',
      confidence,
      classifier: 'ai',
      reason: reason || 'AI classified this as durable multi-step work.',
      projectName,
      title: missionTitleFor(userText, projectName),
      deliverables,
      tasks: buildMissionTasks(userText, agentId, deliverables),
    };
  }

  return {
    kind: workMode,
    persistence: 'none',
    confidence,
    classifier: 'ai',
    reason: reason || 'AI classified this as non-persistent current-turn work.',
    projectName,
  };
}

export async function classifyWorkDurabilityWithAi(opts = {}) {
  const fast = deterministicFastPath(opts);
  // For confirmed mission-suggest replies and other deterministic fast-path hits,
  // return immediately — except confirmed missions also need AI subtask decomposition.
  if (fast) {
    if (fast.confirmedFromSuggest) {
      return {
        ...fast,
        tasks: await decomposePersistentWorkWithAi({
          ...opts,
          projectName: fast.projectName || '',
          deliverables: [],
        }),
        decomposition: 'ai-constrained',
      };
    }
    return fast;
  }

  const fallback = fallbackRuleDecision(opts);
  // For known-project decisions, trust the deterministic signal and skip the AI
  // classifier — the LLM cannot see the local project catalog and will often
  // downgrade these to direct_answer.
  if (fallback.kind === 'new_mission_candidate') {
    // High confidence: explicit deliverables → decompose and auto-create.
    return {
      ...fallback,
      tasks: await decomposePersistentWorkWithAi({
        ...opts,
        projectName: fallback.projectName || '',
        deliverables: fallback.deliverables || [],
      }),
      decomposition: 'ai-constrained',
    };
  }
  if (fallback.kind === 'mission_suggest') {
    // Medium confidence: action verb but no deliverables → return as-is so the
    // agent can ask the user whether to open a mission before doing anything.
    return fallback;
  }

  const llmChat = typeof opts.llmChat === 'function' ? opts.llmChat : defaultLlmChat;
  const missionResolution = await resolveMissionForUserTurnWithAi({ ...opts, llmChat });
  if (missionResolution) return missionResolution;

  const knownProjects = getKnownProjectNames();
  const history = (opts.historyMessages || [])
    .slice(-4)
    .map((m) => `${m.role || 'user'}: ${String(m.content || '').slice(0, 180)}`)
    .join('\n');
  const prompt = [
    history ? `Recent conversation:\n${history}\n` : '',
    `Latest user message:\n${String(opts.userText || '').slice(0, 1000)}`,
    '',
    knownProjects.length ? `Registered projects (treat any mention as durable work): ${knownProjects.join(', ')}` : '',
    '',
    'Classify whether this chat turn needs durable work state before any delegation.',
    'Use deterministic common sense:',
    '- direct answers and simple questions do not need persistence',
    '- reminders are scheduler/cron work, not missions',
    '- task/project status, counts, history, duplicate cleanup, and tracker-admin questions are one_off_delegated_answer with requiresPersistence=false',
    '- any message that mentions a registered project by name should be a new_mission_candidate with requiresPersistence=true',
    '- future project/launch/build/campaign work with multiple deliverables should be a new_mission_candidate',
    '- updates to existing ongoing work should be existing_mission_task_update only if the message clearly refers to that work',
    '',
    'Return JSON only:',
    '{',
    '  "workMode": "direct_answer | one_off_delegated_answer | existing_mission_task_update | new_mission_candidate",',
    '  "requiresPersistence": true,',
    '  "confidence": 0.0,',
    '  "reason": "one sentence",',
    '  "projectName": "",',
    '  "deliverables": []',
    '}',
  ].filter(Boolean).join('\n');

  try {
    const raw = await llmChat(
      [
        { role: 'system', content: DURABILITY_SYSTEM },
        { role: 'user', content: prompt },
      ],
      { agentId: opts.agentId || 'main', purpose: 'work_durability_classify' },
    );
    const parsed = JSON.parse(stripJsonFences(raw));
    let normalized = normalizeAiDecision(parsed, opts);
    if (normalized?.persistence === 'create_lightweight_mission') {
      normalized = {
        ...normalized,
        tasks: await decomposePersistentWorkWithAi({
          ...opts,
          projectName: normalized.projectName,
          deliverables: normalized.deliverables,
          llmChat,
        }),
        decomposition: 'ai-constrained',
      };
    }
    return normalized || fallback;
  } catch (err) {
    console.log('[work-durability] ai classifier failed, using deterministic fallback:', err?.message || err);
    return fallback;
  }
}

export function prepareWorkDurability(opts = {}) {
  const decision = classifyWorkDurability(opts);
  return persistDurabilityDecision(decision, opts);
}

function persistDurabilityDecision(decision, opts = {}) {
  if (decision.persistence !== 'create_lightweight_mission') return decision;

  const agentId = String(opts.agentId || 'main').trim() || 'main';
  const mission = createMission({
    title: decision.title,
    objective: clean(opts.userText, 360),
    ownerAgentId: agentId,
    status: 'active',
    intervalMs: 60_000,
    tasks: decision.tasks,
  });

  return {
    ...decision,
    missionId: mission.id,
    mission,
    createdMission: true,
  };
}

export async function prepareWorkDurabilityWithAi(opts = {}) {
  const decision = await classifyWorkDurabilityWithAi(opts);
  return persistDurabilityDecision(decision, opts);
}

export function buildDurabilitySystemBlock(decision) {
  if (!decision) return '';

  // mission_suggest: agent must answer the question AND ask whether to open a mission.
  if (decision.kind === 'mission_suggest') {
    const project = decision.projectName ? `"${decision.projectName}"` : 'this project';
    return [
      '',
      '',
      '# Work durability',
      `Durability classification: ${decision.kind}`,
      `Project: ${decision.projectName || '(unknown)'}`,
      `Reason: ${decision.reason || ''}`,
      '',
      `INSTRUCTION: Answer the user's question helpfully, then — at the end of your reply — ask in one short sentence whether they would like you to open a tracked mission for ${project} so the work can be delegated and followed up automatically. Do NOT create a mission yet; wait for their confirmation.`,
    ].join('\n');
  }

  if (decision.persistence === 'none') return '';

  const lines = [
    '',
    '',
    '# Work durability',
    `Durability classification: ${decision.kind}`,
    `Persistence action: ${decision.persistence}`,
  ];
  if (decision.classifier) lines.push(`Classifier: ${decision.classifier}`);
  if (Number.isFinite(Number(decision.confidence))) lines.push(`Confidence: ${Number(decision.confidence).toFixed(2)}`);
  if (decision.missionId) lines.push(`Mission ID: ${decision.missionId}`);
  if (decision.taskMatch) lines.push(`Task match: ${decision.taskMatch}`);
  if (decision.taskId) lines.push(`Task ID: ${decision.taskId}`);
  if (decision.reason) lines.push(`Reason: ${decision.reason}`);
  if (Array.isArray(decision.tasks) && decision.tasks.length) {
    lines.push('Initial tasks:');
    decision.tasks.forEach((sg) => lines.push(`- [${sg.status || 'todo'}] ${sg.title}`));
  }
  return lines.join('\n');
}

export function delegationArgsFromDurability(decision, userText) {
  if (!decision || !decision.missionId) return {};
  const title = decision.mission?.title || decision.title || clean(userText, 120);
  const expected = Array.isArray(decision.tasks) && decision.tasks.length
    ? decision.tasks.map((sg) => sg.title).join('; ')
    : clean(userText, 240);
  return {
    missionId: decision.missionId,
    taskTitle: title,
    expectedOutput: expected,
  };
}

export function delegationRoutingTextFromDurability(decision, userText) {
  if (!decision || decision.persistence === 'none') return userText;
  const taskText = Array.isArray(decision.tasks)
    ? decision.tasks.map((sg) => sg.title).join(' ')
    : '';
  const blob = `${userText} ${decision.title || ''} ${taskText}`.toLowerCase();
  const hints = [];
  if (/\b(positioning|posts?|landing page|launch content|campaign|tagline|brand)\b/.test(blob)) {
    hints.push('marketing campaign positioning launch posts landing page');
  }
  if (/\b(analytics|funnel|instrument|tracking|metrics|implementation|ci|github|code)\b/.test(blob)) {
    hints.push('technical implementation analytics engineering');
  }
  return [userText, taskText, ...hints].filter(Boolean).join('\n');
}

function routeReasonForTask(sg) {
  if (sg?.routeReason) return clean(sg.routeReason, 180);
  const title = String(sg?.title || '');
  const type = String(sg?.type || inferSubtaskType(title));
  if (type === 'marketing') return 'Positioning, launch messaging, and social content are marketing tasks.';
  if (type === 'product') return 'Product/page checklist work benefits from product or implementation review.';
  if (type === 'engineering') return 'Technical implementation work should route to an engineering specialist.';
  return `AI decomposition classified this as ${type || 'planning'} work.`;
}

export function buildDurableDelegationContext(decision, {
  agentId = 'main',
  availableSkillIds = [],
} = {}) {
  if (!decision || decision.persistence === 'none') return null;
  if (!Array.isArray(availableSkillIds) || !availableSkillIds.includes('agent-send')) return null;

  const callerAgentId = String(agentId || 'main').trim() || 'main';
  const allowedAgents = allowedSuggestedAgents(callerAgentId);
  const tasks = Array.isArray(decision.tasks) && decision.tasks.length
    ? decision.tasks
    : (Array.isArray(decision.mission?.tasks) ? decision.mission.tasks : []);
  const routes = tasks
    .map((sg) => {
      const target = clean(sg.suggestedAgent || sg.assignee || callerAgentId, 80).toLowerCase();
      if (!allowedAgents.has(target)) return null;
      const confidence = Number.isFinite(Number(sg.routeConfidence))
        ? Math.max(0, Math.min(1, Number(sg.routeConfidence)))
        : 0.75;
      return {
        task: clean(sg.title, 140),
        agent: target,
        confidence,
        reason: routeReasonForTask(sg),
        type: clean(sg.type || inferSubtaskType(sg.title), 40),
        taskId: clean(sg.id || '', 80),
      };
    })
    .filter((r) => r && r.task && r.agent);

  if (!routes.length) return null;

  const byAgent = new Map();
  for (const route of routes) {
    const row = byAgent.get(route.agent) || {
      agentId: route.agent,
      title: route.agent,
      score: 0,
      confidence: 0,
      matchedSkills: [],
      matchedConcepts: [],
      reasoning: '',
      routes: [],
    };
    row.routes.push(route);
    row.score += Math.round(route.confidence * 100);
    row.confidence = Math.max(row.confidence, route.confidence);
    row.matchedConcepts = [...new Set(row.routes.map((r) => r.type).filter(Boolean))];
    row.reasoning = row.routes.map((r) => `${r.task}: ${r.reason}`).join('; ');
    byAgent.set(route.agent, row);
  }

  const candidates = [...byAgent.values()].sort((a, b) => {
    const aIsCaller = a.agentId === callerAgentId ? 1 : 0;
    const bIsCaller = b.agentId === callerAgentId ? 1 : 0;
    if (aIsCaller !== bIsCaller) return aIsCaller - bIsCaller;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.score - a.score;
  });
  const selected = candidates.find((c) => c.agentId !== callerAgentId) || candidates[0];
  const action = selected && selected.agentId !== callerAgentId ? 'delegate' : 'handle-in-main';

  return {
    candidates,
    teamCapability: {
      request: decision.mission?.objective || decision.title || '',
      callerAgentId,
      agents: [
        {
          agentId: callerAgentId,
          title: callerAgentId,
          role: 'coordinator',
          linked: true,
          score: callerAgentId === selected?.agentId ? selected.score : 0,
          confidence: callerAgentId === selected?.agentId ? selected.confidence : 0,
          confidencePct: `${Math.round((callerAgentId === selected?.agentId ? selected.confidence : 0) * 100)}%`,
          matchedSkills: [],
          matchedConcepts: [],
          reasoning: action === 'handle-in-main' ? 'Durable routing kept this with coordinator.' : 'Coordinator owns mission state.',
        },
        ...candidates
          .filter((c) => c.agentId !== callerAgentId)
          .map((c) => ({
            agentId: c.agentId,
            title: c.title,
            role: 'specialist',
            linked: true,
            score: c.score,
            confidence: c.confidence,
            confidencePct: `${Math.round(c.confidence * 100)}%`,
            matchedSkills: [],
            matchedConcepts: c.matchedConcepts,
            reasoning: c.reasoning,
          })),
      ],
      recommendation: {
        action,
        targetAgentId: action === 'delegate' ? selected.agentId : '',
        reason: action === 'delegate'
          ? selected.routes[0]?.reason || `Durable routing selected ${selected.agentId}.`
          : 'Durable routing selected coordinator-owned planning.',
        coordinatorConfidence: action === 'handle-in-main' ? selected?.confidence || 0 : 0,
        topSpecialistId: action === 'delegate' ? selected.agentId : '',
        topSpecialistConfidence: selected?.confidence || 0,
      },
    },
    recommendation: {
      mode: action === 'delegate' ? 'delegate' : 'coordinator',
      action,
      targetAgentId: action === 'delegate' ? selected.agentId : '',
      score: selected?.score || 0,
      confidence: selected?.confidence || 0,
      matchedSkills: [],
      matchedConcepts: selected?.matchedConcepts || [],
      blocked: false,
      reason: action === 'delegate'
        ? selected.routes[0]?.reason || `Durable routing selected ${selected.agentId}.`
        : 'Durable routing selected coordinator-owned planning.',
      offerUpgrade: false,
      routingMethod: 'durable-ai',
      routes,
    },
  };
}
