#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { runSkillTests } from '../../support/skill-test-runner.js';

async function main() {
  const stateDir = mkdtempSync(join(tmpdir(), 'pasture-proj-wf-'));
  process.env.PASTURE_STATE_DIR = stateDir;
  try {
    const { createProject, getProjectGraph } = await import('../../../../lib/context/projects-db.js');
    const { createMission } = await import('../../../../lib/context/missions.js');
    const {
      resolveProjectRef,
      lookupProjectRef,
      healthCheckProject,
      healthCheckProjectRef,
      proposeProjectSetup,
      applyProjectSetup,
      updateProjectDetails,
      listConfiguredProjects,
      proposeProjectPlan,
      applyProjectPlan,
      hasExplicitUserApproval,
      formatTasksForDisplay,
      formatDecisionPrompt,
      updateProjectTaskStatus,
      logProjectProgress,
      projectWorkflowStatus,
      syncTurnToProjectWork,
      buildProjectWorkflowContextBlock,
      isProjectWorkflowTurn,
    } = await import('../../../../lib/context/project-workflow.js');
    const { executeProjectWorkflow } = await import('../../../../lib/agent/executors/project-workflow.js');
    const {
      listPendingProposals,
      approvePendingProposal,
      rejectPendingProposal,
      getPendingProposal,
    } = await import('../../../../lib/context/project-workflow-pending.js');
    const {
      BLOCKER_TEMPLATES,
      inferBlockerTemplateTasks,
    } = await import('../../../../lib/agent/templates/blocker-templates.js');

    const project = createProject({
      name: 'NextPostAI',
      description: 'AI marketing platform',
      url: 'https://nextpostai.com',
    });

    const tests = [
      {
        name: 'resolve project by name',
        input: 'NextPostAI',
        run: async () => {
          const p = resolveProjectRef('NextPostAI');
          if (!p || p.name !== 'NextPostAI') throw new Error('resolve failed');
          return 'resolved id=' + p.id;
        },
      },
      {
        name: 'health check flags missing mission',
        input: 'health_check NextPostAI',
        run: async () => {
          const health = healthCheckProject(project);
          if (health.ok) throw new Error('expected missing mission');
          const mission = health.missing.find((m) => m.field === 'mission');
          if (!mission) throw new Error('mission missing not listed');
          return `${health.missing.length} gaps`;
        },
      },
      {
        name: 'unknown project needs setup',
        input: 'health_check AcmeApp',
        run: async () => {
          const result = healthCheckProjectRef('AcmeApp', { userText: 'work on AcmeApp' });
          if (!result.needsSetup) throw new Error('expected needsSetup');
          if (result.lookup.status !== 'not_configured') throw new Error('wrong status');
          return result.lookup.suggestedName || 'AcmeApp';
        },
      },
      {
        name: 'propose setup requires name and description',
        input: 'propose_setup name only',
        run: async () => {
          const blocked = proposeProjectSetup({ name: 'NewApp' });
          if (blocked.ok) throw new Error('expected missing description');
          const preview = proposeProjectSetup({
            name: 'NewApp',
            description: 'Customer portal',
            setup_notes: 'mongodb://localhost:27017/newapp',
          });
          if (!preview.ok || !preview.preview) throw new Error('preview failed');
          return preview.project.name;
        },
      },
      {
        name: 'apply setup creates catalog project',
        input: 'apply_setup userApproved=true',
        run: async () => {
          const applied = applyProjectSetup({
            name: 'NewApp',
            description: 'Customer portal rebuild',
            url: 'https://newapp.example.com',
            setup_notes: 'MongoDB: mongodb://localhost:27017/newapp',
            userApproved: true,
          }, { userText: 'yes go ahead' });
          if (!applied.ok || !applied.project?.id) throw new Error('apply setup failed');
          const found = resolveProjectRef('NewApp');
          if (!found || found.name !== 'NewApp') throw new Error('not in catalog');
          return 'id=' + applied.project.id;
        },
      },
      {
        name: 'update project saves setup notes',
        input: 'update_project setup_notes',
        run: async () => {
          const updated = updateProjectDetails({
            project: 'NextPostAI',
            setup_notes: 'MongoDB Atlas cluster prod',
          });
          if (!updated.ok) throw new Error('update failed');
          if (!String(updated.project.setup_notes || '').includes('MongoDB')) throw new Error('setup not saved');
          return 'saved';
        },
      },
      {
        name: 'list configured projects',
        input: 'list_projects',
        run: async () => {
          const list = listConfiguredProjects();
          if (!list.length) throw new Error('empty catalog');
          return list.length + ' projects';
        },
      },
      {
        name: 'blocker template catalog has core product types',
        input: 'template catalog',
        run: async () => {
          const ids = BLOCKER_TEMPLATES.map((t) => t.id);
          for (const expected of ['digital-product-growth', 'ecommerce-growth', 'physical-local-business', 'b2b-sales-pipeline', 'content-audience-growth']) {
            if (!ids.includes(expected)) throw new Error(`missing template ${expected}`);
          }
          return `${ids.length} templates`;
        },
      },
      {
        name: 'digital growth request creates user-input blockers',
        input: 'How can I improve my customer base?',
        run: async () => {
          const inferred = inferBlockerTemplateTasks({
            userText: 'How can I improve my customer base?',
            project: { name: 'NextPostAI', description: 'AI marketing platform' },
          });
          if (inferred.template?.id !== 'digital-product-growth') throw new Error('wrong template');
          if (!inferred.tasks.length) throw new Error('expected blocker tasks');
          const task = inferred.tasks[0];
          if (task.status !== 'blocked') throw new Error('blocker task must be blocked');
          if (!task.labels.includes('blocker')) throw new Error('blocker label missing');
          if (task.assignee !== 'user') throw new Error('blocker should be assigned to user');
          return `${inferred.template.name}: ${inferred.tasks.length}`;
        },
      },
      {
        name: 'physical store request uses local-business blockers',
        input: 'How do we grow this physical store?',
        run: async () => {
          const inferred = inferBlockerTemplateTasks({
            userText: 'How do we grow this physical store and improve foot traffic?',
            project: { name: 'Corner Cafe', description: 'A local restaurant' },
          });
          if (inferred.template?.id !== 'physical-local-business') throw new Error('wrong template');
          const titles = inferred.tasks.map((t) => t.title).join(' | ');
          if (!/POS|location|local/i.test(titles)) throw new Error(`unexpected blockers: ${titles}`);
          if (/MongoDB/i.test(titles)) throw new Error('physical store should not ask for MongoDB by default');
          return inferred.template.name;
        },
      },
      {
        name: 'known context suppresses already-provided blockers',
        input: 'MongoDB and PostHog already configured',
        run: async () => {
          const inferred = inferBlockerTemplateTasks({
            userText: 'Improve customer base',
            project: {
              name: 'NextPostAI',
              description: 'AI app',
              setup_notes: 'MongoDB Atlas read-only URI and PostHog analytics are configured',
            },
          });
          const titles = inferred.tasks.map((t) => t.title).join(' | ');
          if (/product\/customer data/i.test(titles)) throw new Error('MongoDB blocker should be suppressed');
          if (/analytics\/funnel/i.test(titles)) throw new Error('analytics blocker should be suppressed');
          return `${inferred.tasks.length} remaining blockers`;
        },
      },
      {
        name: 'propose plan blocked for unconfigured project',
        input: 'propose_plan GhostApp',
        run: async () => {
          const blocked = proposeProjectPlan({ project: 'GhostApp', userText: 'work on GhostApp' });
          if (blocked.ok) throw new Error('should block unconfigured project');
          if (!blocked.needsSetup) throw new Error('expected needsSetup');
          return blocked.status;
        },
      },
      {
        name: 'propose plan preview only',
        input: 'propose_plan tasks=[Launch landing page]',
        run: async () => {
          const preview = proposeProjectPlan({
            project: 'NextPostAI',
            title: 'Grow NextPostAI',
            tasks: ['Launch landing page', 'Set up analytics'],
          });
          if (!preview.ok || !preview.preview) throw new Error('preview failed');
          if (preview.tasks.length !== 2) throw new Error('tasks not normalized');
          return preview.mission.title;
        },
      },
      {
        name: 'propose plan does not auto-add blocker template tasks',
        input: 'propose_plan improve customer base',
        run: async () => {
          const preview = proposeProjectPlan({
            project: 'NextPostAI',
            title: 'Improve customer base',
            userText: 'How can I improve my customer base?',
            tasks: [{ title: 'Review current positioning', status: 'todo' }],
          });
          if (!preview.ok) throw new Error('preview failed');
          if (preview.blockerTemplate) throw new Error('blocker template should be opt-in');
          if (preview.blockerTasksForDisplay.length) throw new Error('unexpected blocker display tasks');
          if (preview.tasksForDisplay.length !== 1) throw new Error('unexpected auto-added tasks');
          return `${preview.tasksForDisplay.length} implementation task`;
        },
      },
      {
        name: 'propose plan adds blocker template tasks when explicitly requested',
        input: 'propose_plan includeBlockerTemplates=true',
        run: async () => {
          const preview = proposeProjectPlan({
            project: 'NextPostAI',
            title: 'Improve customer base',
            userText: 'How can I improve my customer base?',
            includeBlockerTemplates: true,
            tasks: [{ title: 'Review current positioning', status: 'todo' }],
          });
          if (!preview.ok || preview.blockerTemplate?.id !== 'digital-product-growth') throw new Error('missing blocker template');
          if (!preview.blockerTasksForDisplay.length) throw new Error('missing blocker display tasks');
          const blocked = preview.tasksForDisplay.filter((t) => t.status === 'blocked');
          if (!blocked.length) throw new Error('no blocked tasks in preview');
          if (!blocked.every((t) => (t.labels || []).includes('blocker'))) throw new Error('blocked task missing blocker label');
          return `${blocked.length} blocker tasks`;
        },
      },
      {
        name: 'apply plan requires approval',
        input: 'apply_plan without userApproved',
        run: async () => {
          const blocked = applyProjectPlan({ project: 'NextPostAI', tasks: ['A'] });
          if (!blocked.needsApproval) throw new Error('expected needsApproval');
          return blocked.error;
        },
      },
      {
        name: 'apply plan rejects userApproved without explicit yes',
        input: 'apply_plan userApproved=true but user said increase sign ups',
        run: async () => {
          const blocked = applyProjectPlan(
            { project: 'NextPostAI', title: 'Grow', tasks: ['A'], userApproved: true },
            { userText: 'increase customer sign ups' },
          );
          if (!blocked.awaitingUserApproval) throw new Error('expected awaitingUserApproval');
          return 'blocked';
        },
      },
      {
        name: 'apply plan accepts explicit yes',
        input: 'yes go ahead and create it',
        run: async () => {
          if (!hasExplicitUserApproval('yes go ahead and create the mission')) throw new Error('approval not detected');
          const applied = applyProjectPlan(
            {
              project: 'NextPostAI',
              title: 'Grow NextPostAI',
              tasks: [{ title: 'Launch landing page', status: 'todo' }],
              userApproved: true,
              ownerAgentId: 'main',
            },
            { userText: 'yes go ahead and create the mission' },
          );
          if (!applied.ok) throw new Error(applied.error || 'apply failed');
          return applied.mission.title;
        },
      },
      {
        name: 'propose plan includes tasksForDisplay',
        input: 'propose_plan tasks',
        run: async () => {
          const preview = proposeProjectPlan({
            project: 'NextPostAI',
            tasks: ['One', 'Two'],
          });
          if (!preview.tasksForDisplay || preview.tasksForDisplay.length !== 2) throw new Error('tasksForDisplay missing');
          if (preview.tasksForDisplay[0].id !== 'sg-1') throw new Error('stable id expected');
          return preview.tasksForDisplay.map((t) => t.id).join(',');
        },
      },
      {
        name: 'apply plan creates linked mission',
        input: 'apply_plan userApproved=true with yes',
        run: async () => {
          const applied = applyProjectPlan({
            project: 'NextPostAI',
            title: 'Grow NextPostAI 2',
            tasks: [{ title: 'Launch landing page', status: 'todo' }],
            userApproved: true,
            ownerAgentId: 'main',
          }, { userText: 'yes create it' });
          if (!applied.ok || !applied.mission?.id) throw new Error('apply failed');
          if (Number(applied.mission.projectId) !== Number(project.id)) throw new Error('projectId not linked');
          return applied.mission.title;
        },
      },
      {
        name: 'apply plan persists blocker labels on mission tasks',
        input: 'apply_plan broad growth with blockers',
        run: async () => {
          const applied = applyProjectPlan({
            project: 'NextPostAI',
            title: 'Customer growth blockers',
            userText: 'Improve customer base',
            includeBlockerTemplates: true,
            tasks: [{ title: 'Draft growth hypothesis', status: 'todo' }],
            userApproved: true,
            ownerAgentId: 'main',
          }, { userText: 'yes create it' });
          if (!applied.ok) throw new Error(applied.error || 'apply failed');
          const blockers = (applied.mission.tasks || []).filter((task) => task.status === 'blocked');
          if (!blockers.length) throw new Error('no blocker tasks persisted');
          if (!blockers.every((task) => (task.labels || []).includes('blocker'))) throw new Error('blocker label not persisted');
          return `${blockers.length} persisted blockers`;
        },
      },
      {
        name: 'update task status',
        input: 'update_task doing → done',
        run: async () => {
          const { createMission } = await import('../../../../lib/context/missions.js');
          const mission = createMission({
            title: 'Temp task update',
            objective: 'x',
            ownerAgentId: 'main',
            tasks: [{ id: 't1', title: 'Ship feature', status: 'doing', progress: 10 }],
          });
          const updated = updateProjectTaskStatus({
            missionId: mission.id,
            taskId: 't1',
            status: 'done',
            note: 'Shipped',
          });
          if (!updated.ok) throw new Error('update failed');
          const sg = (updated.mission.tasks || []).find((s) => s.id === 't1');
          if (!sg || sg.status !== 'done') throw new Error('status not done');
          return 'done';
        },
      },
      {
        name: 'log progress writes project update',
        input: 'log_progress text',
        run: async () => {
          const before = getProjectGraph(project.id);
          const logged = logProjectProgress({
            project: 'NextPostAI',
            text: 'Completed health check and proposed tasks',
          });
          if (!logged.ok || !logged.update?.id) throw new Error('log failed');
          const after = getProjectGraph(project.id);
          const countBefore = (before.updates || []).filter((u) => u.branch_id == null).length;
          const countAfter = (after.updates || []).filter((u) => u.branch_id == null).length;
          if (countAfter <= countBefore) throw new Error('update not appended');
          return logged.update.text.slice(0, 40);
        },
      },
      {
        name: 'health/status exposes listable updates as work items',
        input: 'status updates are listable',
        run: async () => {
          const health = healthCheckProject(project);
          if (!Array.isArray(health.recentUpdates)) throw new Error('recentUpdates missing');
          if (!health.recentUpdates.some((u) => /Completed health check/.test(u.text))) {
            throw new Error('recent update text not exposed');
          }
          const status = projectWorkflowStatus({ project: 'NextPostAI', agentId: 'main' });
          if (!Array.isArray(status.updates) || !status.updates.length) throw new Error('status updates missing');
          if (!Array.isArray(status.workItems) || !status.workItems.some((w) => w.source === 'project_update' && w.status === 'done')) {
            throw new Error('project updates not represented as canonical done work items');
          }
          return `${status.updates.length} updates`;
        },
      },
      {
        name: 'sync turn after project chat',
        input: 'work on NextPostAI growth',
        run: async () => {
          const synced = syncTurnToProjectWork({
            agentId: 'main',
            userText: 'work on NextPostAI growth plan',
            historyMessages: [],
            summary: 'Proposed three tasks for review',
          });
          if (!synced?.projectId) throw new Error('sync returned null');
          return 'projectId=' + synced.projectId;
        },
      },
      {
        name: 'workflow context block for project turns',
        input: 'work on NextPostAI',
        run: async () => {
          if (!isProjectWorkflowTurn('work on NextPostAI')) throw new Error('intent not detected');
          const block = buildProjectWorkflowContextBlock({ userText: 'work on NextPostAI', agentId: 'main' });
          if (!block.includes('health_check')) throw new Error('missing workflow steps');
          return 'block len=' + block.length;
        },
      },
      {
        name: 'executor health_check action',
        input: 'executor health_check unconfigured',
        run: async () => {
          const raw = await executeProjectWorkflow({ agentId: 'main' }, { action: 'health_check', project: 'GhostApp2' });
          const parsed = JSON.parse(raw);
          if (!parsed.needsSetup) throw new Error('expected needsSetup from executor');
          return parsed.lookup.status;
        },
      },
      {
        name: 'executor health_check configured',
        input: 'executor health_check NextPostAI',
        run: async () => {
          const raw = await executeProjectWorkflow({ agentId: 'main' }, { action: 'health_check', project: 'NextPostAI' });
          const parsed = JSON.parse(raw);
          if (!parsed.project) throw new Error('no project in result');
          return parsed.linkedMissionCount + ' linked missions';
        },
      },
      {
        name: 'propose plan registers dashboard pending',
        input: 'propose_plan pending store',
        run: async () => {
          const preview = proposeProjectPlan({
            project: 'NextPostAI',
            title: 'Pending mission',
            tasks: ['Task A', 'Task B'],
            ownerAgentId: 'marketer',
          });
          if (!preview.ok) throw new Error('preview failed');
          const store = listPendingProposals();
          const match = (store.pending || []).find((p) => p.kind === 'mission_plan' && p.projectName === 'NextPostAI');
          if (!match) throw new Error('pending mission_plan not registered');
          if (match.tasks.length !== 2) throw new Error('pending tasks missing');
          return match.id;
        },
      },
      {
        name: 'dashboard approve pending mission plan',
        input: 'approve pending mission_plan',
        run: async () => {
          const store = listPendingProposals();
          const item = (store.pending || []).find((p) => p.kind === 'mission_plan' && p.projectName === 'NextPostAI');
          if (!item) throw new Error('no pending item');
          const result = await approvePendingProposal(item.id);
          if (!result.ok || !result.mission?.id) throw new Error(result.error || 'approve failed');
          if (getPendingProposal(item.id)) throw new Error('pending not cleared');
          return result.mission.title;
        },
      },
      {
        name: 'propose setup registers dashboard pending',
        input: 'propose_setup pending store',
        run: async () => {
          const preview = proposeProjectSetup({
            name: 'DashApp',
            description: 'Dashboard-only app',
            url: 'https://dash.app',
          });
          if (!preview.ok) throw new Error('preview failed');
          const store = listPendingProposals();
          const match = (store.pending || []).find((p) => p.kind === 'project_setup' && p.projectName === 'DashApp');
          if (!match) throw new Error('pending project_setup not registered');
          return match.id;
        },
      },
      {
        name: 'dashboard reject pending setup',
        input: 'reject pending project_setup',
        run: async () => {
          const store = listPendingProposals();
          const item = (store.pending || []).find((p) => p.kind === 'project_setup' && p.projectName === 'DashApp');
          if (!item) throw new Error('no pending setup');
          const result = rejectPendingProposal(item.id);
          if (!result.ok) throw new Error('reject failed');
          if (getPendingProposal(item.id)) throw new Error('pending not removed');
          return 'rejected';
        },
      },
      {
        name: 'apply plan accepts dashboard approval channel',
        input: 'approvedVia dashboard',
        run: async () => {
          const applied = applyProjectPlan(
            { project: 'NextPostAI', title: 'Dashboard channel', tasks: ['X'], userApproved: true },
            { approvedVia: 'dashboard' },
          );
          if (!applied.ok) throw new Error(applied.error || 'apply failed');
          return applied.mission.title;
        },
      },
    ];

    const { failed } = await runSkillTests('project-workflow', tests);
    process.exit(failed > 0 ? 1 : 0);
  } finally {
    try { rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
