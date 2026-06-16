/**
 * Dashboard-visible pending project-workflow proposals (mission plans, project setup).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getStateDir } from '../util/paths.js';

function pendingStorePath() {
  return join(getStateDir(), 'project-workflow-pending.json');
}

function readStore() {
  const path = pendingStorePath();
  if (!existsSync(path)) return { pending: [], updatedAt: 0 };
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return {
      pending: Array.isArray(raw.pending) ? raw.pending : [],
      updatedAt: Number(raw.updatedAt) || 0,
    };
  } catch (_) {
    return { pending: [], updatedAt: 0 };
  }
}

function writeStore(pending) {
  const dir = getStateDir();
  mkdirSync(dir, { recursive: true });
  const payload = { pending, updatedAt: Date.now() };
  writeFileSync(pendingStorePath(), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function newId() {
  return `pw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function listPendingProposals() {
  const store = readStore();
  store.pending.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
  return store;
}

export function getPendingProposal(id) {
  const pid = String(id || '').trim();
  if (!pid) return null;
  return (readStore().pending || []).find((p) => String(p.id) === pid) || null;
}

export function registerPendingProposal(entry) {
  const store = readStore();
  const projectKey = String(entry.projectName || entry.project || '').trim().toLowerCase();
  const kind = String(entry.kind || 'mission_plan');
  const filtered = (store.pending || []).filter((p) => {
    const sameProject = String(p.projectName || '').trim().toLowerCase() === projectKey && projectKey;
    return !(sameProject && String(p.kind) === kind);
  });
  const item = {
    id: newId(),
    kind,
    status: 'awaiting_approval',
    createdAt: Date.now(),
    proposedBy: String(entry.proposedBy || 'main'),
    ownerAgentId: String(entry.ownerAgentId || entry.proposedBy || 'main'),
    projectId: entry.projectId != null ? Number(entry.projectId) : null,
    projectName: String(entry.projectName || ''),
    mission: entry.mission || null,
    tasks: Array.isArray(entry.tasks) ? entry.tasks : [],
    tasksForDisplay: Array.isArray(entry.tasksForDisplay) ? entry.tasksForDisplay : [],
    planSteps: Array.isArray(entry.planSteps) ? entry.planSteps : [],
    setup: entry.setup || null,
    objective: String(entry.objective || entry.mission?.objective || ''),
    askUser: String(entry.askUser || 'Approve to create this on the dashboard.'),
  };
  filtered.unshift(item);
  writeStore(filtered.slice(0, 20));
  return item;
}

export function removePendingProposal(id) {
  const pid = String(id || '').trim();
  const store = readStore();
  const next = (store.pending || []).filter((p) => String(p.id) !== pid);
  writeStore(next);
  return { removed: store.pending.length - next.length };
}

export function clearPendingForProject(projectName, kind = 'mission_plan') {
  const key = String(projectName || '').trim().toLowerCase();
  if (!key) return;
  const store = readStore();
  const next = (store.pending || []).filter((p) => {
    if (String(p.kind) !== String(kind)) return true;
    return String(p.projectName || '').trim().toLowerCase() !== key;
  });
  writeStore(next);
}

export function registerPendingFromPlanPreview(preview, meta = {}) {
  if (!preview?.ok || !preview.preview) return null;
  return registerPendingProposal({
    kind: 'mission_plan',
    proposedBy: meta.agentId || preview.mission?.ownerAgentId || 'main',
    ownerAgentId: preview.mission?.ownerAgentId || meta.agentId || 'main',
    projectId: preview.project?.id,
    projectName: preview.project?.name,
    mission: preview.mission,
    objective: preview.mission?.objective,
    tasks: preview.tasks,
    tasksForDisplay: preview.tasksForDisplay,
    planSteps: preview.planSteps,
    askUser: preview.askUser,
  });
}

export function registerPendingFromSetupPreview(preview, meta = {}) {
  if (!preview?.ok || !preview.preview) return null;
  return registerPendingProposal({
    kind: 'project_setup',
    proposedBy: meta.agentId || 'main',
    projectName: preview.project?.name,
    setup: preview.project,
    askUser: preview.askUser || 'Approve to add this project to the dashboard.',
  });
}

export async function approvePendingProposal(id) {
  const item = getPendingProposal(id);
  if (!item) return { ok: false, error: 'Pending proposal not found' };
  const approvalOpts = { userText: 'yes approved via dashboard', approvedVia: 'dashboard' };

  if (item.kind === 'project_setup') {
    const { applyProjectSetup } = await import('./project-workflow.js');
    const setup = item.setup || {};
    const result = applyProjectSetup({
      name: setup.name || item.projectName,
      description: setup.description,
      url: setup.url,
      setup_notes: setup.setup_notes,
      userApproved: true,
    }, approvalOpts);
    if (!result.ok) return result;
    removePendingProposal(id);
    return { ok: true, kind: item.kind, project: result.project, pendingId: id };
  }

  const { applyProjectPlan } = await import('./project-workflow.js');
  const result = applyProjectPlan({
    project: item.projectName || item.projectId,
    title: item.mission?.title,
    objective: item.mission?.objective || item.objective,
    tasks: item.tasks,
    planSteps: item.planSteps,
    ownerAgentId: item.ownerAgentId,
    userApproved: true,
  }, approvalOpts);
  if (!result.ok) return result;
  removePendingProposal(id);
  return { ok: true, kind: item.kind, mission: result.mission, project: result.project, pendingId: id };
}

export function rejectPendingProposal(id) {
  const item = getPendingProposal(id);
  if (!item) return { ok: false, error: 'Pending proposal not found' };
  removePendingProposal(id);
  return { ok: true, rejected: item };
}
