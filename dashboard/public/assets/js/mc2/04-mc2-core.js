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
      mc2RenderMovement();
      mc2RenderAttention();
    }

    function renderMissionControl() {
      if (typeof shouldPauseTeamDashboardRefresh === 'function' && shouldPauseTeamDashboardRefresh()) return;
      try {
        mc2RenderLiveChrome();
        if (mc2ActiveView === 'mission') mc2RenderHome();
        else if (mc2ActiveView === 'tasks') { mc2RenderTasks(); mc2RenderTaskDetail(); }
        else if (mc2ActiveView === 'missions') mc2RenderMissions();
      } catch (err) {
        console.error('[mission-control] render failed:', err);
      }
    }

    /* Wire MC sidebar nav */
    document.querySelectorAll('#page-team .mc-nav-item[data-mc-nav]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var nav = btn.getAttribute('data-mc-nav');
        mc2SetView(nav);
      });
    });
    document.querySelectorAll('#page-team .mc-panel-link[data-mc-nav]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var nav = btn.getAttribute('data-mc-nav');
        if (nav === 'tasks') {
          mc2OpenTasksView(btn.getAttribute('data-mc-tasks-filter') || 'all');
          return;
        }
        if (nav) mc2SetView(nav);
      });
    });
    document.querySelectorAll('#page-team .mc-stat-card-action[data-mc-nav]').forEach(function (btn) {
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

    var mc2PendingRoot = document.getElementById('page-team');
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
    document.querySelectorAll('#page-team .mc2-agent-filter-select').forEach(function (selectEl) {
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
    document.querySelectorAll('#page-team .mc2-range-controls .team-agent-panel-range').forEach(function (btn) {
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

    (function wireMc2MissionSelect() {
      var sel = mc2El('mc2-mission-select');
      if (!sel || sel._wired) return;
      sel._wired = true;
      sel.addEventListener('change', function () {
        var id = sel.value || '';
        selectedTeamMissionId = id;
        if (typeof renderMissionControl === 'function') renderMissionControl();
      });
    })();

    (function wireMc2MissionMenu() {
      var menuBtn = mc2El('mc2-mission-menu-btn');
      var dropdown = mc2El('mc2-mission-menu-dropdown');
      var deleteBtn = mc2El('mc2-mission-delete-btn');
      var assignBtn = mc2El('mc2-mission-assign-btn');
      var deleteModal = mc2El('mc2-mission-delete-modal');
      var cancelBtn = mc2El('mc2-mission-delete-cancel');
      var confirmBtn = mc2El('mc2-mission-delete-confirm');
      var descEl = mc2El('mc2-mission-delete-desc');
      var itemsEl = mc2El('mc2-mission-delete-items');
      if (!menuBtn || !dropdown) return;

      function getMc2SelectedMission() {
        var sel = mc2El('mc2-mission-select');
        var id = sel ? sel.value : '';
        if (!id) id = selectedTeamMissionId;
        if (!id) return null;
        var missions = Array.isArray(teamMissionsSnapshot && teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : [];
        return missions.find(function (g) { return String(g.id || '') === id; }) || null;
      }

      function closeMenu() {
        dropdown.style.display = 'none';
        menuBtn.setAttribute('aria-expanded', 'false');
      }

      function openMenu() {
        dropdown.style.display = 'block';
        menuBtn.setAttribute('aria-expanded', 'true');
      }

      menuBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var isOpen = dropdown.style.display !== 'none';
        isOpen ? closeMenu() : openMenu();
      });

      document.addEventListener('click', function (e) {
        if (dropdown.style.display === 'none') return;
        if (!dropdown.contains(e.target) && e.target !== menuBtn) closeMenu();
      });

      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closeMenu();
      });

      // ── Delete mission ────────────────────────────────────────────────────
      deleteBtn && deleteBtn.addEventListener('click', function () {
        closeMenu();
        var mission = getMc2SelectedMission();
        if (!mission) { alert('Select a mission first.'); return; }
        var taskCount = typeof countMissionTasks === 'function' ? countMissionTasks(mission.tasks || []) : 0;
        var suggestedCount = (Array.isArray(teamSuggestedTasksSnapshot && teamSuggestedTasksSnapshot.suggestedTasks)
          ? teamSuggestedTasksSnapshot.suggestedTasks : []).filter(function (t) {
            var ids = Array.isArray(t.relatedMissionIds) ? t.relatedMissionIds : [];
            return ids.indexOf(String(mission.id || '')) >= 0;
          }).length;
        descEl.textContent = 'You are about to permanently delete "' + (mission.title || 'Untitled mission') + '". This cannot be undone.';
        itemsEl.innerHTML = [
          '<li><strong>Mission record</strong> — all objectives, progress, plan steps, and history</li>',
          taskCount > 0 ? '<li><strong>' + taskCount + ' task' + (taskCount === 1 ? '' : 's') + '</strong> embedded in this mission (including delegated tasks)</li>' : '',
          '<li><strong>Mission memory</strong> — the persistent memory log for this mission</li>',
          suggestedCount > 0 ? '<li><strong>' + suggestedCount + ' AI suggested task' + (suggestedCount === 1 ? '' : 's') + '</strong> linked exclusively to this mission</li>' : '',
          '<li><strong>Activity log entries older than today</strong> — pruned if this mission pre-dates the per-ID storage migration</li>',
        ].filter(Boolean).join('');
        deleteModal.dataset.pendingMissionId = String(mission.id || '');
        deleteModal.style.display = 'flex';
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Delete permanently';
      });

      cancelBtn && cancelBtn.addEventListener('click', function () {
        deleteModal.style.display = 'none';
        delete deleteModal.dataset.pendingMissionId;
      });

      deleteModal && deleteModal.addEventListener('click', function (e) {
        if (e.target === deleteModal) {
          deleteModal.style.display = 'none';
          delete deleteModal.dataset.pendingMissionId;
        }
      });

      confirmBtn && confirmBtn.addEventListener('click', async function () {
        var id = deleteModal.dataset.pendingMissionId;
        if (!id) return;
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Deleting…';
        try {
          var resp = await fetch(API + '/api/missions/' + encodeURIComponent(id), { method: 'DELETE' });
          if (resp.ok) {
            deleteModal.style.display = 'none';
            delete deleteModal.dataset.pendingMissionId;
            selectedTeamMissionId = '';
            await fetchMissionsSnapshot();
            if (typeof fetchSuggestedTasksSnapshot === 'function') await fetchSuggestedTasksSnapshot();
            if (typeof renderMissionControl === 'function') renderMissionControl();
          } else {
            var body = await resp.json().catch(function () { return {}; });
            alert('Delete failed: ' + (body.error || resp.status));
          }
        } catch (err) {
          alert('Delete failed: ' + String(err && err.message || err));
        }
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Delete permanently';
      });

      // ── Assign mission to agent ───────────────────────────────────────────
      assignBtn && assignBtn.addEventListener('click', function () {
        closeMenu();
        var mission = getMc2SelectedMission();
        if (!mission) { alert('Select a mission first.'); return; }
        var assignModal = mc2El('mc2-mission-assign-modal');
        var assignDesc = mc2El('mc2-mission-assign-desc');
        var assignSel = mc2El('mc2-mission-assign-select');
        var assignErr = mc2El('mc2-mission-assign-error');
        if (!assignModal || !assignSel) return;
        var agents = Array.isArray(agentMapData) ? agentMapData : [];
        assignDesc.textContent = 'Reassign "' + (mission.title || 'Untitled mission') + '" to a different agent. The selected agent will own and run this mission.';
        assignSel.innerHTML = agents.length
          ? agents.map(function (a) {
              var id = String(a.id || '');
              var name = typeof agentNameById === 'function' ? agentNameById(id) : (String(a.name || a.role || id));
              var selected = id === String(mission.ownerAgentId || '') ? ' selected' : '';
              return '<option value="' + escapeHtml(id) + '"' + selected + '>' + escapeHtml(name || id) + '</option>';
            }).join('')
          : '<option value="main">main</option>';
        if (assignErr) { assignErr.style.display = 'none'; assignErr.textContent = ''; }
        assignModal.dataset.pendingMissionId = String(mission.id || '');
        assignModal.style.display = 'flex';
      });
    })();

    (function wireMc2MissionAssignModal() {
      var assignModal = mc2El('mc2-mission-assign-modal');
      var cancelBtn = mc2El('mc2-mission-assign-cancel');
      var confirmBtn = mc2El('mc2-mission-assign-confirm');
      var assignSel = mc2El('mc2-mission-assign-select');
      var assignErr = mc2El('mc2-mission-assign-error');
      if (!assignModal) return;

      function closeAssignModal() {
        assignModal.style.display = 'none';
        delete assignModal.dataset.pendingMissionId;
      }

      cancelBtn && cancelBtn.addEventListener('click', closeAssignModal);
      assignModal.addEventListener('click', function (e) {
        if (e.target === assignModal) closeAssignModal();
      });

      confirmBtn && confirmBtn.addEventListener('click', async function () {
        var id = assignModal.dataset.pendingMissionId;
        var agentId = assignSel ? assignSel.value.trim() : '';
        if (!id) return;
        if (!agentId) {
          if (assignErr) { assignErr.textContent = 'Please select an agent.'; assignErr.style.display = 'block'; }
          return;
        }
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Assigning…';
        if (assignErr) { assignErr.style.display = 'none'; assignErr.textContent = ''; }
        try {
          var resp = await fetch(API + '/api/missions/' + encodeURIComponent(id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ownerAgentId: agentId }),
          });
          if (resp.ok) {
            closeAssignModal();
            await fetchMissionsSnapshot();
            if (typeof renderMissionControl === 'function') renderMissionControl();
          } else {
            var body = await resp.json().catch(function () { return {}; });
            if (assignErr) { assignErr.textContent = 'Assign failed: ' + (body.error || resp.status); assignErr.style.display = 'block'; }
          }
        } catch (err) {
          if (assignErr) { assignErr.textContent = 'Assign failed: ' + String(err && err.message || err); assignErr.style.display = 'block'; }
        }
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Assign';
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
