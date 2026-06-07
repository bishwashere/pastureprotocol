/* MC2 shell chrome — live badge, pending approvals, action banner hooks */
    function mc2UpdateLiveBadge() {
      var badge = mc2El('mc2-live-badge');
      if (!badge) return;
      var events = teamActivityEvents || [];
      var recentTs = events.length ? Number(events[events.length - 1].ts) || 0 : 0;
      var live = recentTs > 0 && (Date.now() - recentTs) < 8000;
      badge.style.opacity = live ? '1' : '0.5';
      var rateEl = mc2El('mc2-actions-rate');
      if (rateEl) {
        var hourAgo = Date.now() - 3600000;
        var cnt = events.filter(function (e) { return Number(e.ts) > hourAgo && String(e.type) === 'turn_done'; }).length;
        rateEl.textContent = cnt;
      }
    }

    function mc2PendingItems() {
      var snap = mc2PendingSnapshot || { pending: [], updatedAt: 0 };
      return Array.isArray(snap.pending) ? snap.pending : [];
    }

    function mc2PendingKindLabel(kind) {
      if (kind === 'project_setup') return 'New project';
      if (kind === 'mission_plan') return 'Mission plan';
      return String(kind || 'Proposal');
    }

    function mc2PendingTitle(item) {
      if (item.kind === 'project_setup') {
        return String((item.setup && item.setup.name) || item.projectName || 'New project');
      }
      return String((item.mission && item.mission.title) || item.objective || 'Mission plan');
    }

    function mc2PendingObjective(item) {
      if (item.kind === 'project_setup') {
        var setup = item.setup || {};
        var parts = [];
        if (setup.description) parts.push(String(setup.description));
        if (setup.url) parts.push(String(setup.url));
        return parts.join(' · ');
      }
      return String((item.mission && item.mission.objective) || item.objective || '');
    }

    function mc2PendingTaskLines(item) {
      var rows = Array.isArray(item.tasksForDisplay) && item.tasksForDisplay.length
        ? item.tasksForDisplay
        : (Array.isArray(item.tasks) ? item.tasks : []);
      return rows.slice(0, 12).map(function (t, i) {
        var title = typeof t === 'string' ? t : String(t.title || t.name || '');
        return '<li>' + escapeHtml(String(t.index || i + 1) + '. ' + title) + '</li>';
      }).join('');
    }

    function mc2PendingCardHtml(item, compact) {
      var id = escapeHtml(String(item.id || ''));
      var kind = escapeHtml(mc2PendingKindLabel(item.kind));
      var title = escapeHtml(mc2PendingTitle(item));
      var objective = escapeHtml(mc2PendingObjective(item).slice(0, compact ? 140 : 280));
      var project = escapeHtml(String(item.projectName || ''));
      var agent = escapeHtml(String(item.proposedBy || item.ownerAgentId || 'main'));
      var tasksHtml = item.kind === 'mission_plan' && mc2PendingTaskLines(item)
        ? '<ul class="mc-pending-task-list">' + mc2PendingTaskLines(item) + '</ul>'
        : '';
      var ask = escapeHtml(String(item.askUser || 'Approve to create on the dashboard?').slice(0, 160));
      return '<div class="mc-pending-card" data-pending-id="' + id + '">' +
        '<div class="mc-pending-card-head">' +
          '<h4>' + title + '</h4>' +
          '<span class="mc-pending-kind">' + kind + '</span>' +
        '</div>' +
        (objective ? '<p class="mc-pending-objective">' + objective + '</p>' : '') +
        '<div class="mc-pending-meta">' +
          (project ? 'Project: ' + project + ' · ' : '') +
          'From ' + agent + ' · ' + mc2RelTime(item.createdAt) +
        '</div>' +
        tasksHtml +
        (!compact ? '<div class="mc-pending-meta">' + ask + '</div>' : '') +
        '<div class="mc-pending-actions">' +
          '<button type="button" class="mc-pending-btn approve" data-pending-action="approve" data-pending-id="' + id + '">Approve</button>' +
          '<button type="button" class="mc-pending-btn reject" data-pending-action="reject" data-pending-id="' + id + '">Reject</button>' +
        '</div>' +
      '</div>';
    }

    function mc2UpdateApprovalsBadge() {
      var badge = mc2El('mc2-approvals-badge');
      if (!badge) return;
      var count = mc2PendingItems().length;
      badge.textContent = String(count);
      badge.hidden = count <= 0;
    }

    function mc2RenderPendingInline(containerId, kindFilter) {
      var el = mc2El(containerId);
      if (!el) return;
      var items = mc2PendingItems().filter(function (p) {
        return !kindFilter || String(p.kind) === kindFilter;
      });
      if (!items.length) { el.innerHTML = ''; return; }
      el.innerHTML = items.map(function (p) { return mc2PendingCardHtml(p, true); }).join('');
    }

    function mc2RenderPendingApprovalsBanner() {
      var el = mc2El('mc2-pending-approvals');
      if (!el) return;
      var items = mc2PendingItems();
      if (!items.length) { el.innerHTML = ''; el.hidden = true; return; }
      el.hidden = false;
      el.innerHTML = items.map(function (p) { return mc2PendingCardHtml(p, false); }).join('');
    }

    async function fetchMc2PendingApprovals() {
      try {
        var r = await fetch(API + '/api/project-workflow/pending');
        if (!r.ok) return;
        var d = await r.json().catch(function () { return {}; });
        mc2PendingSnapshot = {
          pending: Array.isArray(d.pending) ? d.pending : [],
          updatedAt: Number(d.updatedAt) || 0,
        };
      } catch (_) {}
      mc2UpdateApprovalsBadge();
      mc2RenderPendingApprovalsBanner();
      mc2RenderPendingInline('mc2-missions-pending', 'mission_plan');
      mc2RenderPendingInline('mc2-tasks-pending', 'mission_plan');
      if (mc2ActiveView === 'mission' && !(typeof shouldPauseTeamDashboardRefresh === 'function' && shouldPauseTeamDashboardRefresh())) {
        mc2RenderAttention();
      }
    }

    async function mc2HandlePendingAction(pendingId, action) {
      if (mc2PendingActionBusy || !pendingId) return;
      mc2PendingActionBusy = true;
      document.querySelectorAll('.mc-pending-btn').forEach(function (btn) { btn.disabled = true; });
      try {
        var path = action === 'approve' ? 'approve' : 'reject';
        var r = await fetch(API + '/api/project-workflow/pending/' + encodeURIComponent(pendingId) + '/' + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok) {
          alert(d.error || ('Could not ' + path + ' proposal'));
          return;
        }
        await fetchMc2PendingApprovals();
        await fetchMissionsSnapshot();
        await fetchSuggestedTasksSnapshot();
        if (window.pastureProjectsApi && typeof window.pastureProjectsApi.listProjects === 'function') {
          try {
            mc2ProjectsSnapshot = await window.pastureProjectsApi.listProjects();
          } catch (_) {}
        }
        if (mc2ActiveView === 'projects') mc2RenderProjects();
        if (mc2ActiveView === 'missions') mc2RenderMissions();
        if (mc2ActiveView === 'tasks') {
          mc2RenderTasks();
          mc2RenderTaskDetail();
        }
        mc2RenderLiveChrome();
        if (mc2ActiveView === 'mission') mc2RenderHome();
        if (mc2ActiveView === 'projects') mc2RenderProjects();
        if (mc2ActiveView === 'missions') mc2RenderMissions();
        if (mc2ActiveView === 'tasks') {
          mc2RenderTasks();
          mc2RenderTaskDetail();
        }
      } catch (err) {
        alert(err && err.message ? err.message : String(err));
      } finally {
        mc2PendingActionBusy = false;
        document.querySelectorAll('.mc-pending-btn').forEach(function (btn) { btn.disabled = false; });
      }
    }
