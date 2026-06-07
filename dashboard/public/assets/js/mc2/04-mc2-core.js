/* MC2 core — render dispatch, event wiring, task drawer bind */
    /** Lightweight header/sidebar updates on every poll — no view DOM churn. */
    function mc2RenderLiveChrome() {
      mc2UpdateLiveBadge();
      mc2UpdateApprovalsBadge();
      mc2RenderPendingApprovalsBanner();
      mc2RenderPendingInline('mc2-missions-pending', 'mission_plan');
      mc2RenderPendingInline('mc2-tasks-pending', 'mission_plan');
      mc2ScheduleSidebarProjects();
    }

    /** Full Home (mission) dashboard — only view that live-refreshes on activity poll. */
    function mc2RenderHome() {
      mc2RenderMissionProgress();
      mc2RenderKanban();
      mc2RenderAgentsOverview();
      mc2RenderMovement();
      mc2RenderAttention();
    }

    function renderMissionControl() {
      if (typeof shouldPauseTeamDashboardRefresh === 'function' && shouldPauseTeamDashboardRefresh()) return;
      try {
        mc2RenderLiveChrome();
        if (mc2ActiveView === 'mission') mc2RenderHome();
      } catch (err) {
        console.error('[mission-control] render failed:', err);
      }
    }

    /* Wire MC sidebar nav */
    document.querySelectorAll('#page-team2 .mc-nav-item[data-mc-nav]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var nav = btn.getAttribute('data-mc-nav');
        if (nav === 'back') { location.hash = '#team2'; return; }
        mc2SetView(nav);
      });
    });
    document.querySelectorAll('#page-team2 .mc-panel-link[data-mc-nav]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var nav = btn.getAttribute('data-mc-nav');
        if (nav === 'tasks') {
          mc2OpenTasksView(btn.getAttribute('data-mc-tasks-filter') || 'all');
          return;
        }
        if (nav) mc2SetView(nav);
      });
    });
    document.querySelectorAll('#page-team2 .mc-stat-card-action[data-mc-nav]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var nav = btn.getAttribute('data-mc-nav');
        if (nav === 'tasks') {
          var taskFilter = btn.getAttribute('data-mc-tasks-filter') || 'all';
          mc2OpenTasksView(taskFilter);
          return;
        }
        if (nav) mc2SetView(nav);
      });
    });
    var mc2AddAgentBtn = document.getElementById('mc2-add-agent-btn');
    if (mc2AddAgentBtn) {
      mc2AddAgentBtn.addEventListener('click', function () {
        openAgentCreateModal({ fromAgentId: selectedChatAgentId });
      });
    }
    function mc2HandleMovementClick(row) {
      if (!row) return;
      var missionId = row.getAttribute('data-mission-id') || '';
      var taskId = row.getAttribute('data-task-id') || '';
      var suggestedTaskId = row.getAttribute('data-suggestedTask-id') || '';
      var agentId = row.getAttribute('data-agent-id') || '';
      var item = typeof findMissionTaskItem === 'function'
        ? findMissionTaskItem({ missionId: missionId, taskId: taskId, agentId: agentId })
        : null;
      if (!item && suggestedTaskId) {
        item = typeof findMissionTaskItem === 'function'
          ? findMissionTaskItem({ taskId: 'init-' + suggestedTaskId, missionId: missionId })
          : null;
      }
      if (item) {
        mc2OpenTaskDetail(item, { filter: 'all' });
        return;
      }
      if (suggestedTaskId) {
        mc2OpenTaskForSuggestedTask(suggestedTaskId);
        return;
      }
      if (missionId) {
        mc2OpenTaskDetail(null, { missionId: missionId, taskId: taskId, filter: 'all' });
        return;
      }
      if (agentId) {
        mc2OpenTaskDetailForAgent(agentId);
        return;
      }
      mc2OpenTasksView('all');
    }

    var mc2PendingRoot = document.getElementById('page-team2');
    if (mc2PendingRoot) {
      mc2PendingRoot.addEventListener('click', function (e) {
        var contextLink = e.target && e.target.closest ? e.target.closest('[data-mc-open-context]') : null;
        if (contextLink) {
          e.preventDefault();
          e.stopPropagation();
          mc2SetAgentFilter(contextLink.getAttribute('data-mc-agent') || '', 'context');
          return;
        }
        var agentWorkspaceBtn = e.target && e.target.closest ? e.target.closest('[data-mc-agent-workspace]') : null;
        if (agentWorkspaceBtn) {
          e.preventDefault();
          e.stopPropagation();
          mc2SetAgentFilter(
            agentWorkspaceBtn.getAttribute('data-mc-agent') || '',
            agentWorkspaceBtn.getAttribute('data-mc-agent-workspace') || 'context'
          );
          return;
        }
        var movementRow = e.target && e.target.closest ? e.target.closest('.mc-movement-clickable') : null;
        if (movementRow) {
          e.preventDefault();
          mc2HandleMovementClick(movementRow);
          return;
        }
        var blockedBtn = e.target && e.target.closest ? e.target.closest('[data-mc-action="blocked"]') : null;
        if (blockedBtn) {
          e.preventDefault();
          mc2OpenTasksView('blocked');
          return;
        }
        var tasksFilterBtn = e.target && e.target.closest ? e.target.closest('.mc2-tasks-filter[data-mc-tasks-filter]') : null;
        if (tasksFilterBtn) {
          e.preventDefault();
          mc2OpenTasksView(tasksFilterBtn.getAttribute('data-mc-tasks-filter') || 'all');
          return;
        }
        var agentsTabBtn = e.target && e.target.closest ? e.target.closest('.mc-agents-subtab[data-mc2-agents-tab]') : null;
        if (agentsTabBtn) {
          e.preventDefault();
          mc2SetAgentsSubView(agentsTabBtn.getAttribute('data-mc2-agents-tab') || 'overview');
          return;
        }
        var attentionBtn = e.target && e.target.closest ? e.target.closest('[data-attention-action]') : null;
        if (attentionBtn) {
          e.preventDefault();
          mc2HandleAttentionClick(attentionBtn);
          return;
        }
        var btn = e.target && e.target.closest ? e.target.closest('[data-pending-action]') : null;
        if (!btn) return;
        e.preventDefault();
        var action = btn.getAttribute('data-pending-action');
        var pendingId = btn.getAttribute('data-pending-id');
        if (action && pendingId) mc2HandlePendingAction(pendingId, action);
      });
    }
    document.querySelectorAll('#page-team2 .mc2-agent-filter-select').forEach(function (selectEl) {
      selectEl.addEventListener('change', function () {
        if (selectEl.id === 'mc2-tasks-agent-filter') {
          mc2TasksAgentFilter = selectEl.value || '';
          if (mc2ActiveView === 'tasks') {
          mc2RenderTasks();
          mc2RenderTaskDetail();
        }
          return;
        }
        mc2SetAgentFilter(selectEl.value || '');
      });
    });
    document.querySelectorAll('#page-team2 .mc2-range-controls .team-agent-panel-range').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var range = btn.getAttribute('data-range') || 'today';
        if (mc2ActiveView === 'activity' || mc2ActiveView === 'agents' || mc2ActiveView === 'inbox' || mc2ActiveView === 'outbox' || mc2ActiveView === 'context') {
          mc2ScrollToRange(range);
          return;
        }
        if (mc2ActiveView === 'tasks') {
          teamAgentPanelRange = range;
          mc2SetTimelineHighlight(range);
          mc2RenderTasks();
          return;
        }
        setTeamAgentPanelRange(range);
        mc2SetTimelineHighlight(range);
      });
    });
    (function wireMc2Projects() {
      var addBtn = mc2El('mc2-proj-add-btn');
      if (addBtn && !addBtn._wired) {
        addBtn._wired = true;
        addBtn.addEventListener('click', function () {
          var api = window.pastureProjectsApi;
          if (!api) return;
          api.addProjectFromForm('mc2-proj-new-name', 'mc2-proj-new-url', 'mc2-proj-new-desc', 'mc2-proj-canvas');
        });
      }
      function mc2ProjEnterSubmit(e) {
        if (e.key === 'Enter' && addBtn) addBtn.click();
      }
      ['mc2-proj-new-name', 'mc2-proj-new-url', 'mc2-proj-new-desc'].forEach(function (id) {
        var el = mc2El(id);
        if (el && !el._wired) {
          el._wired = true;
          el.addEventListener('keydown', mc2ProjEnterSubmit);
        }
      });
    })();

    (function wireMc2TaskDrawer() {
      var drawer = mc2El('mc2-task-drawer');
      if (!drawer || drawer._wired) return;
      drawer._wired = true;
      drawer.querySelectorAll('[data-mc-task-drawer-close]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          mc2CloseTaskDrawer();
        });
      });
      drawer.addEventListener('click', function (e) {
        var card = e.target && e.target.closest ? e.target.closest('.mc-task-popup-card') : null;
        if (!card && drawer.classList.contains('open')) mc2CloseTaskDrawer();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && drawer.classList.contains('open')) mc2CloseTaskDrawer();
      });
    })();
