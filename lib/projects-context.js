/**
 * Inject dashboard Projects tracker data into agent system prompts.
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

/**
 * User wants to learn about a tracked project (not just list names).
 * @param {string} userText
 */
export function isProjectDiscoveryRequest(userText) {
  const t = String(userText || '').toLowerCase();
  return (
    /\bfind\s+out\b/.test(t) ||
    /\blook\s+into\b/.test(t) ||
    /\blearn\s+(more\s+)?about\b/.test(t) ||
    /\btell\s+me\s+(more\s+)?about\b/.test(t) ||
    /\bwhat\s+is\s+(this|it|that|the)\s*(project)?\b/.test(t) ||
    /\bwhat(?:'s| is)\s+.+\s+about\b/.test(t) ||
    /\ball\s+about\b/.test(t) ||
    /\b(project|product)\s+overview\b/.test(t) ||
    /\bsummarize\b.*\bproject\b/.test(t) ||
    /\bresearch\b.*\bproject\b/.test(t)
  );
}

function wantsProjectDetail(userText) {
  const t = String(userText || '').toLowerCase();
  return (
    isProjectDiscoveryRequest(userText) ||
    /\b(this|that|the)\s+project\b/.test(t) ||
    /\babout\s+(this|it|that)\b/.test(t)
  );
}

/**
 * Pick which tracked project the user means.
 * @param {Array} projects
 * @param {string} userText
 * @param {Array} historyMessages
 */
export function pickFocusedProject(projects, userText, historyMessages = []) {
  const list = Array.isArray(projects) ? projects : [];
  if (!list.length) return null;
  const ut = String(userText || '').toLowerCase();
  const hist = historyBlob(historyMessages);

  const byName = list.filter((p) => {
    const n = String(p.name || '').trim().toLowerCase();
    return n && (ut.includes(n) || hist.includes(n));
  });
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) return byName[0];

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

/**
 * @param {Array<{ name?: string, description?: string, url?: string }>} projects
 * @returns {string}
 */
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

function buildProjectFocusBlock(project, userText) {
  if (!project) return '';
  const name = String(project.name || 'Untitled').trim();
  const desc = String(project.description || '').trim();
  const url = String(project.url || '').trim();
  const discovery = isProjectDiscoveryRequest(userText);
  const lines = [
    '## Active project focus (this turn)',
    `The user means tracked project **${name}** from the Projects tracker (not a random repo unless they override).`,
  ];
  if (desc) lines.push(`Description: ${desc}`);
  if (url) lines.push(`URL: ${url}`);
  if (discovery || wantsProjectDetail(userText)) {
    lines.push(
      '',
      '**Required behavior:**',
      '- Do **not** ask which project, or for a GitHub repo name, or a local path — unless the tracker entry has no URL and browse/search failed.',
      url
        ? '- Use **browse** on the project URL first (then **search** or **memory** if needed) to learn what it is about.'
        : '- Use **search** and **memory** for this project name; summarize from description and any notes.',
      '- Reply with: what it is, who it is for, core features, and tech stack if visible.',
    );
  } else {
    lines.push('Answer about this project using the description/URL above when relevant.');
  }
  return '\n' + lines.join('\n');
}

/**
 * Short line for me-skill profile prose.
 * @returns {string}
 */
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
 * Prepend context when delegating so sub-agents see the tracker project without chat history.
 * @param {string} userText
 * @param {Array} [historyMessages]
 * @returns {string}
 */
export function enrichMessageWithProjectContext(userText, historyMessages = []) {
  const text = String(userText || '').trim();
  if (!text) return text;
  try {
    const projects = listProjects();
    const focus = pickFocusedProject(projects, text, historyMessages);
    if (!focus || !wantsProjectDetail(text)) return text;
    const name = String(focus.name || '').trim();
    const desc = summarize(focus.description, 240);
    const url = String(focus.url || '').trim();
    let ctx = `[Projects tracker context: The user means project "${name}".`;
    if (desc) ctx += ` ${desc}.`;
    if (url) ctx += ` URL: ${url} — research with browse/read; do not ask for repo path.]`;
    else ctx += ' No URL on file — use search/memory from description.]';
    return `${text}\n\n${ctx}`;
  } catch (_) {
    return text;
  }
}

/**
 * Intent plan override for project research turns.
 * @param {string} userText
 * @param {Array} historyMessages
 * @param {string[]} availableSkillIds
 */
export function getProjectsDiscoveryIntentHint(userText, historyMessages = [], availableSkillIds = []) {
  if (!wantsProjectDetail(userText) && !isProjectDiscoveryRequest(userText)) return null;
  try {
    const projects = listProjects();
    const focus = pickFocusedProject(projects, userText, historyMessages);
    if (!focus) return null;
    const enabled = new Set((availableSkillIds || []).map((id) => String(id).toLowerCase()));
    const prefer = ['browse', 'search', 'read', 'memory', 'github'];
    const skills = prefer.filter((id) => enabled.has(id));
    const name = String(focus.name || 'project').trim();
    const url = String(focus.url || '').trim();
    return {
      mode: 'tool',
      skills: skills.length ? skills : prefer.slice(0, 2),
      plan: url
        ? `Research tracked project "${name}" via browse on ${url}; summarize what it is about. No clarifying questions.`
        : `Research tracked project "${name}" via search/memory; summarize what it is about. No clarifying questions.`,
      answer_style: 'detailed',
    };
  } catch (_) {
    return null;
  }
}

/**
 * System-prompt block listing tracked projects.
 * @param {{ userText?: string, historyMessages?: Array }} [opts]
 * @returns {string}
 */
export function buildProjectsContextBlock(opts = {}) {
  try {
    const userText = opts.userText || '';
    const historyMessages = opts.historyMessages || [];
    const projects = listProjects();
    const body = formatProjectsForPrompt(projects);
    const focus = pickFocusedProject(projects, userText, historyMessages);
    const focusBlock = focus ? buildProjectFocusBlock(focus, userText) : '';
    return (
      '\n\n# Dashboard projects (Projects tracker)\n' +
      'Authoritative list from the cowCode dashboard **Projects** page (`projects.db` in the state dir). ' +
      'When the user asks what projects they have, answer from this list. ' +
      'When they ask about **this project**, **find out**, or **what it is about**, use **Active project focus** below and research (browse URL / search) — **do not** ask them to pick repo vs folder vs tracker. ' +
      'Do **not** say you do not know their projects if entries appear below.\n\n' +
      body +
      focusBlock
    );
  } catch (err) {
    console.log('[projects-context] failed:', err?.message || err);
    return '';
  }
}
