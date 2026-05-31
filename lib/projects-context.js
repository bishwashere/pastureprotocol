/**
 * Dashboard Projects tracker — lightweight catalog for agents.
 * Ongoing work, objectives, and tool use live in Goals (see goals-context.js).
 */

import { listProjects } from './projects-db.js';

const MAX_PROJECTS = 30;

function summarize(text, max = 160) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function historyBlob(historyMessages) {
  return (historyMessages || [])
    .slice(-8)
    .map((m) => String(m?.content || ''))
    .join('\n')
    .toLowerCase();
}

export function isProjectDiscoveryRequest(userText) {
  const t = String(userText || '').toLowerCase();
  return (
    /\bfind\s+out\b/.test(t) ||
    /\bwhat\s+is\s+(this|it|that|the)\s*(project)?\b/.test(t) ||
    /\ball\s+about\b/.test(t) ||
    /\b(this|that|the)\s+project\b/.test(t)
  );
}

export function wantsProjectDetail(userText) {
  return isProjectDiscoveryRequest(userText) || /\b(this|that|the)\s+project\b/.test(String(userText || '').toLowerCase());
}

export function pickFocusedProject(projects, userText, historyMessages = []) {
  const list = Array.isArray(projects) ? projects : [];
  if (!list.length) return null;
  const ut = String(userText || '').toLowerCase();
  const hist = historyBlob(historyMessages);

  const byName = list.filter((p) => {
    const n = String(p.name || '').trim().toLowerCase();
    return n && (ut.includes(n) || hist.includes(n));
  });
  if (byName.length) return byName[0];

  if (wantsProjectDetail(userText)) {
    const inHist = list.filter((p) => {
      const n = String(p.name || '').trim().toLowerCase();
      return n && hist.includes(n);
    });
    if (inHist.length === 1) return inHist[0];
    if (list.length === 1) return list[0];
  }

  if (isProjectDiscoveryRequest(userText) && list.length === 1) return list[0];
  return null;
}

export function formatProjectsForPrompt(projects) {
  const list = Array.isArray(projects) ? projects : [];
  if (!list.length) {
    return 'No projects in the dashboard Projects tracker yet (user can add them on the Projects page).';
  }
  return list.slice(0, MAX_PROJECTS).map((p, i) => {
    const name = String(p.name || 'Untitled').trim();
    const desc = summarize(p.description, 160);
    const url = String(p.url || '').trim();
    let line = `${i + 1}. **${name}**`;
    if (desc) line += ` — ${desc}`;
    if (url) line += ` — ${url}`;
    return line;
  }).join('\n');
}

export function formatProjectsProfileLine() {
  try {
    const projects = listProjects();
    if (!projects.length) return '';
    const names = projects.slice(0, 12).map((p) => {
      const name = String(p.name || 'Untitled').trim();
      const desc = summarize(p.description, 60);
      return desc ? `${name} (${desc})` : name;
    });
    const more = projects.length > 12 ? ` and ${projects.length - 12} more` : '';
    return `You have ${projects.length} project${projects.length === 1 ? '' : 's'} in the dashboard Projects tracker: ${names.join(', ')}${more}.`;
  } catch (_) {
    return '';
  }
}

/**
 * Short pointer when delegating — full work context comes from Goals block.
 */
export function enrichMessageWithProjectContext(userText, historyMessages = []) {
  const text = String(userText || '').trim();
  if (!text || !wantsProjectDetail(text)) return text;
  try {
    const projects = listProjects();
    const focus = pickFocusedProject(projects, text, historyMessages);
    if (!focus) return text;
    const name = String(focus.name || '').trim();
    return `${text}\n\n[Projects tracker: "${name}". If a matching Goal is in context, work that goal.]`;
  } catch (_) {
    return text;
  }
}

export function buildProjectsContextBlock(opts = {}) {
  try {
    const projects = listProjects();
    const body = formatProjectsForPrompt(projects);
    return (
      '\n\n# Dashboard projects (catalog)\n' +
      'Lightweight list from the Projects page (`projects.db`). ' +
      'When the user asks what projects they have, answer from this list.\n' +
      'For **find out / what is it about / continue work**, prefer the **Active goal** section when present — goals hold objectives, plan, and subgoals.\n\n' +
      body
    );
  } catch (err) {
    console.log('[projects-context] failed:', err?.message || err);
    return '';
  }
}
