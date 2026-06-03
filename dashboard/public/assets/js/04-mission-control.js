/* ── Mission Control (#team2) ─────────────────────────────────────────── */

    var mc2ActiveView = 'mission';
    var mc2InboxAgentFilter = '';
    var mc2TasksAgentFilter = '';
    var mc2SelectedProjectId = '';
    var mc2ProjectsSnapshot = [];
    var mc2SidebarProjectsTimer = 0;
    var mc2TimelineScrollRaf = 0;
    var mc2TimelineHighlightKey = '';
    var mc2TimelineSpyEnabled = false;
    var mc2PendingActionBusy = false;

    function mc2El(id) { return document.getElementById(id); }

    function mc2AgentInitials(a) {
      var name = agentCardShortName(a);
      return name.slice(0, 2).toUpperCase();
    }

    function mc2RelTime(ts) {
      var ms = Date.now() - Number(ts || 0);
      if (ms < 0) ms = 0;
      var s = Math.floor(ms / 1000);
      if (s < 60) return s + 's ago';
      var m = Math.floor(s / 60);
      if (m < 60) return m + 'm ago';
      var h = Math.floor(m / 60);
      return h + 'h ago';
    }

    function mc2AvatarHtml(a) {
      var initials = mc2AgentInitials(a);
      return '<div class="mc-agent-avatar">' + escapeHtml(initials) + '</div>';
    }

    function mc2NormalizeTaskPrompt(raw) {
      var prompt = String(raw || '').trim();
      prompt = prompt.replace(/^\[Retry with tools\]\s*/i, '').trim();
      prompt = prompt.replace(/^The user asked:\s*["“]?/i, '').replace(/["”]\.\s*Use available tools.*$/i, '').trim();
      prompt = prompt.replace(/^Completed turn — /i, '').trim();
      return prompt;
    }

    function mc2GenericTaskNoise(text) {
      var t = String(text || '').trim();
      if (!t) return true;
      if (/^Handled in \d+/i.test(t)) return true;
      if (/^Completed turn/i.test(t)) return true;
      if (isEphemeralGoalLabel(t)) return true;
      if (/\b(standing by|idle|standby|next task|no active task|processing request|received user message|starting turn|waiting for|in progress)\b/i.test(t)) return true;
      return false;
    }

    function mc2LatestOpenTaskPrompt(agentId) {
      var id = String(agentId || '').trim();
      if (!id) return '';
      var list = teamActivityEvents || [];
      var openStart = null;
      for (var i = list.length - 1; i >= 0; i--) {
        var e = list[i];
        if (String(e.agentId || '') !== id) continue;
        var type = String(e.type || '');
        if (type === 'turn_done') return '';
        if (type === 'turn_start') {
          openStart = e;
          break;
        }
      }
      if (!openStart) return '';
      var inbox = openStart.details && openStart.details.inbox;
      var raw = (inbox && inbox.task) || openStart.message || '';
      var prompt = mc2NormalizeTaskPrompt(raw);
      if (mc2GenericTaskNoise(prompt)) return '';
      return prompt.slice(0, 160);
    }

    function mc2KanbanTaskTitle(agentId, ctx) {
      ctx = ctx || {};
      var state = String(ctx.state || 'idle').toLowerCase();

      var fromActivity = mc2LatestOpenTaskPrompt(agentId);
      if (fromActivity) return fromActivity;

      var contexts = Array.isArray(ctx.context) ? ctx.context : [];
      for (var i = contexts.length - 1; i >= 0; i--) {
        var c = String(contexts[i] || '').trim();
        var userMatch = c.match(/^User asking:\s*(.+)$/i);
        if (userMatch && !mc2GenericTaskNoise(userMatch[1])) return userMatch[1].slice(0, 160);
        var delMatch = c.match(/^Delegated:\s*(.+)$/i);
        if (delMatch && !mc2GenericTaskNoise(delMatch[1])) return delMatch[1].slice(0, 160);
      }

      var thought = String(ctx.currentThought || '').trim();
      var quoted = thought.match(/["“]([^"”]{4,160})["”]/);
      if (quoted && !mc2GenericTaskNoise(quoted[1])) return quoted[1];

      var lastAction = String(ctx.lastAction || '').trim();
      var delegated = lastAction.match(/^Delegated\s+(.+?)\s+to\s+/i);
      if (delegated && !mc2GenericTaskNoise(delegated[1])) return delegated[1].slice(0, 160);
      if (lastAction && !mc2GenericTaskNoise(lastAction) && lastAction.length > 8) {
        return mc2NormalizeTaskPrompt(lastAction).slice(0, 160);
      }

      var goal = missionLabelForAgent(agentId, ctx);
      if (goal && !mc2GenericTaskNoise(goal)) return goal;

      if (state === 'idle') {
        var queued = String(ctx.currentGoal || ctx.currentStep || '').trim();
        if (queued && !mc2GenericTaskNoise(queued)) return queued;
      }

      var step = String(ctx.currentStep || '').trim();
      if (step && !mc2GenericTaskNoise(step) && !/^Running /i.test(step)) return step;

      if (state === 'waiting') {
        var waitFor = String(ctx.waitingFor || '').trim();
        if (waitFor) return 'Awaiting ' + agentNameById(waitFor);
        return 'Waiting';
      }
      if (state === 'error') {
        return (thought && !mc2GenericTaskNoise(thought) ? thought : 'Blocked').slice(0, 160);
      }
      if (state === 'working') return 'In progress';
      return 'Ready';
    }

    function mc2KanbanCard(a, ctx) {
      var id = String(a.id || '');
      var name = escapeHtml(agentCardShortName(a));
      var state = String(ctx.state || 'idle').toLowerCase();
      var taskTitle = mc2KanbanTaskTitle(id, ctx);
      var lastTs = Number(ctx.updatedAt) || 0;
      var isBlocked = state === 'error';
      var pct = 0;
      var tagHtml = isBlocked
        ? '<span class="mc-kanban-card-tag blocked">⊘ Blocked ' + mc2RelTime(lastTs) + '</span>'
        : '';
      var progressHtml = (state === 'working' && pct > 0)
        ? '<div class="mc-kanban-card-progress"><span style="width:' + pct + '%"></span></div>'
        : '';
      var waitingFor = String(ctx.waitingFor || '').trim();
      return '<div class="mc-kanban-card" data-mc-agent="' + escapeHtml(id) + '">' +
        '<div class="mc-kanban-card-title">' + escapeHtml(taskTitle) + '</div>' +
        '<div class="mc-kanban-card-meta mc-kanban-card-agent">' +
          mc2AvatarHtml(a) +
          '<span>' + name + '</span>' +
        '</div>' +
        progressHtml +
        (state === 'waiting' && waitingFor
          ? '<div class="mc-kanban-card-meta">Next: ' + escapeHtml(agentNameById(waitingFor)) + ' approval</div>'
          : '') +
        (lastTs ? '<div class="mc-kanban-card-meta">Last action: ' + mc2RelTime(lastTs) + '</div>' : '') +
        tagHtml +
      '</div>';
    }

    function mc2SetView(view) {
      mc2ActiveView = view;
      var visibleView = (view === 'inbox' || view === 'outbox') ? 'activity' : view;
      ['mission', 'agents', 'tasks', 'context', 'goals', 'initiatives', 'projects', 'activity', 'stats'].forEach(function (v) {
        var el = mc2El('mc2-view-' + v);
        if (el) el.hidden = v !== visibleView;
      });
      document.querySelectorAll('#page-team2 .mc-nav-item[data-mc-nav]').forEach(function (btn) {
        var nav = btn.getAttribute('data-mc-nav');
        btn.classList.toggle('active', nav === view);
      });
      if (visibleView === 'activity') mc2RenderActivity();
      if (view === 'goals') mc2RenderGoals();
      if (view === 'initiatives') mc2RenderInitiatives();
      if (view === 'projects') mc2RenderProjects();
      if (view === 'context') mc2RenderContext();
      if (view === 'stats') mc2RenderStats();
      if (view === 'agents') mc2RenderAgentsDetail();
      if (view === 'tasks') mc2RenderTasks();
      mc2SyncTimelineHighlightForScroll();
    }

    function mc2ScrollToProject(pid) {
      var id = String(pid || '').trim();
      if (!id) return;
      mc2SelectedProjectId = id;
      setTimeout(function () {
        var row = document.getElementById('proj-row-' + id);
        if (row) {
          try { row.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {}
        }
        mc2RenderSidebarProjects();
      }, 120);
    }

    async function mc2RenderProjects() {
      var api = window.cowCodeProjectsApi;
      var workspaceEl = mc2El('mc2-proj-workspace');
      if (!api || !workspaceEl) return;
      workspaceEl.style.display = 'flex';
      var canvas = mc2El('mc2-proj-canvas');
      if (canvas) await api.loadProjects(canvas);
      var projects = await api.listProjects();
      if (projects) mc2ProjectsSnapshot = projects;
      if (!mc2SelectedProjectId && mc2ProjectsSnapshot.length) {
        mc2SelectedProjectId = String(mc2ProjectsSnapshot[0].id || '');
      }
      if (api.renderConnectors) await api.renderConnectors(mc2SelectedProjectId);
      if (mc2SelectedProjectId) mc2ScrollToProject(mc2SelectedProjectId);
      mc2RenderSidebarProjects();
    }

    async function mc2RenderSidebarProjects() {
      var el = mc2El('mc2-sidebar-projects');
      if (!el) return;
      var api = window.cowCodeProjectsApi;
      if (!api) {
        el.innerHTML = '<span class="mc-sidebar-projects-empty">Unavailable</span>';
        return;
      }
      var projects = await api.listProjects();
      if (!projects) {
        el.innerHTML = '<span class="mc-sidebar-projects-empty">Unavailable</span>';
        return;
      }
      mc2ProjectsSnapshot = projects;
      if (!projects.length) {
        el.innerHTML = '<span class="mc-sidebar-projects-empty">No projects</span>';
        return;
      }
      el.innerHTML = projects.map(function (p) {
        var id = String(p.id || '');
        var name = String(p.name || 'Untitled');
        var active = id === mc2SelectedProjectId ? ' active' : '';
        return '<button type="button" class="mc-sidebar-project' + active + '" data-project-id="' + escapeHtml(id) + '" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</button>';
      }).join('');
      el.querySelectorAll('.mc-sidebar-project[data-project-id]').forEach(function (btn) {
        if (btn._wired) return;
        btn._wired = true;
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          mc2SelectedProjectId = btn.getAttribute('data-project-id') || '';
          mc2SetView('projects');
          mc2ScrollToProject(mc2SelectedProjectId);
          if (api.renderConnectors) api.renderConnectors(mc2SelectedProjectId);
        });
      });
    }

    function mc2ScheduleSidebarProjects() {
      clearTimeout(mc2SidebarProjectsTimer);
      mc2SidebarProjectsTimer = setTimeout(function () {
        mc2RenderSidebarProjects();
      }, 250);
    }

    function mc2InferRangeFromTs(ts) {
      var n = Number(ts) || 0;
      if (!n) return 'today';
      if (eventTsInTeamAgentRange(n, 'today')) return 'today';
      if (eventTsInTeamAgentRange(n, 'yesterday')) return 'yesterday';
      if (eventTsInTeamAgentRange(n, 'last7')) return 'last7';
      return 'last30';
    }

    function mc2SetTimelineHighlight(rangeKey) {
      var key = TEAM_AGENT_RANGE_LABELS[String(rangeKey || '').trim()] ? String(rangeKey) : 'today';
      var changed = key !== mc2TimelineHighlightKey;
      mc2TimelineHighlightKey = key;
      document.querySelectorAll('#page-team2 .mc2-range-controls').forEach(function (group) {
        var activeBtn = null;
        group.querySelectorAll('.team-agent-panel-range').forEach(function (btn) {
          var active = btn.getAttribute('data-range') === key;
          btn.classList.toggle('active', active);
          btn.setAttribute('aria-pressed', active ? 'true' : 'false');
          if (active) activeBtn = btn;
        });
        if (changed && activeBtn) {
          try {
            activeBtn.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
          } catch (_) {
            var left = activeBtn.offsetLeft - Math.max(0, Math.round((group.clientWidth - activeBtn.clientWidth) / 2));
            group.scrollLeft = Math.max(0, left);
          }
        }
      });
    }

    function mc2ScrollViewAndFeed() {
      if (mc2ActiveView === 'context') {
        return { view: mc2El('mc2-view-context'), feed: mc2El('mc2-context-list') };
      }
      if (mc2ActiveView === 'tasks') {
        return { view: mc2El('mc2-view-tasks'), feed: mc2El('mc2-tasks-list') };
      }
      return { view: mc2El('mc2-view-activity'), feed: mc2El('mc2-activity-feed') };
    }

    function mc2FirstVisibleTsInScrollView() {
      var pair = mc2ScrollViewAndFeed();
      var view = pair.view;
      var feed = pair.feed;
      if (!view || view.hidden || !feed) return 0;
      var markers = feed.querySelectorAll('[data-ts]');
      if (!markers.length) return 0;
      var viewRect = view.getBoundingClientRect();
      var threshold = viewRect.top + 84;
      for (var i = 0; i < markers.length; i++) {
        var markerRect = markers[i].getBoundingClientRect();
        if (markerRect.bottom > threshold) {
          return Number(markers[i].getAttribute('data-ts')) || 0;
        }
      }
      return Number(markers[markers.length - 1].getAttribute('data-ts')) || 0;
    }

    function mc2SyncTimelineHighlightForScroll() {
      if (!(mc2ActiveView === 'activity' || mc2ActiveView === 'inbox' || mc2ActiveView === 'outbox' || mc2ActiveView === 'context' || mc2ActiveView === 'tasks')) {
        mc2SetTimelineHighlight(teamAgentPanelRange);
        return;
      }
      if (!mc2TimelineSpyEnabled) {
        mc2SetTimelineHighlight(teamAgentPanelRange);
        return;
      }
      var ts = mc2FirstVisibleTsInScrollView();
      mc2SetTimelineHighlight(mc2InferRangeFromTs(ts));
    }

    function mc2RenderMissionProgress() {
      var summary = computeTeamTaskSummary();
      var goals = Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : [];
      var activeGoal = getCurrentMissionGoal();
      var pct = 0;
      var progressLabel = '— / — tasks completed';
      var etaLabel = '';
      if (activeGoal) {
        pct = Math.max(0, Math.min(100, Math.round(Number((activeGoal.progress && activeGoal.progress.pct) || 0))));
        var label = String(activeGoal.title || activeGoal.objective || '').trim();
        progressLabel = (label ? label : 'Active mission') + ' — ' + pct + '%';
        var totalSubs = 0, doneSubs = 0;
        (activeGoal.subgoals || []).forEach(function sg(s) {
          totalSubs++;
          if (String(s.status || '').toLowerCase() === 'done') doneSubs++;
          (s.subgoals || []).forEach(sg);
        });
        if (totalSubs > 0) progressLabel = doneSubs + ' / ' + totalSubs + ' tasks completed';
      }
      var fill = mc2El('mc2-progress-bar-fill');
      if (fill) fill.style.width = pct + '%';
      var pl = mc2El('mc2-progress-label');
      if (pl) pl.textContent = progressLabel;
      var pp = mc2El('mc2-progress-percent');
      if (pp) pp.textContent = pct + '%';
      var eta = mc2El('mc2-eta-label');
      if (eta) eta.textContent = etaLabel || (activeGoal ? 'ETA: tracking live work' : 'ETA: no active mission');
      var statActive = mc2El('mc2-stat-active'); if (statActive) statActive.textContent = summary.active;
      var statWaiting = mc2El('mc2-stat-waiting'); if (statWaiting) statWaiting.textContent = summary.waiting;
      var statBlocked = mc2El('mc2-stat-blocked'); if (statBlocked) statBlocked.textContent = summary.blocked;
      var statDone = mc2El('mc2-stat-done'); if (statDone) statDone.textContent = summary.completedToday;
      var statPace = mc2El('mc2-stat-pace');
      if (statPace) {
        var events = teamActivityEvents || [];
        var hourAgo = Date.now() - 3600000;
        var recent = events.filter(function (e) { return Number(e.ts) > hourAgo && String(e.type) === 'turn_done'; }).length;
        statPace.textContent = recent + '/hr';
      }
      var missionSel = mc2El('mc2-mission-select');
      if (missionSel) {
        var goalList = Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : [];
        var activeGoals = goalList.filter(function (g) { return String(g.status || 'active').toLowerCase() === 'active'; });
        var currentMission = getCurrentMissionGoal();
        missionSel.innerHTML = (activeGoals.length === 0 ? '<option value="">No active mission</option>' : '') +
          activeGoals.map(function (g) {
            var gid = String(g.id || '');
            var sel = currentMission && String(currentMission.id || '') === gid ? ' selected' : '';
            return '<option value="' + escapeHtml(gid) + '"' + sel + '>' + escapeHtml(String(g.title || g.objective || 'Untitled mission')) + '</option>';
          }).join('');
      }
    }

    function mc2RenderKanban() {
      var agents = agentMapData || [];
      var ctxMap = teamAgentContextSnapshot.agents || {};
      var working = [], waiting = [], blocked = [], nextQueue = [];
      var NEXT_QUEUE_MAX_IDLE_MS = 6 * 60 * 60 * 1000;
      var NEXT_QUEUE_STANDBY_RE = /\b(standing by|idle|standby|next task|no active task)\b/i;
      agents.forEach(function (a) {
        var id = String(a.id || '');
        var ctx = ctxMap[id] || { state: 'idle' };
        var s = String(ctx.state || 'idle').toLowerCase();
        var queuedText = String(ctx.currentGoal || ctx.currentStep || '').trim();
        var lastTs = Number(ctx.updatedAt) || 0;
        var isRecent = !!lastTs && (Date.now() - lastTs) <= NEXT_QUEUE_MAX_IDLE_MS;
        var isStandby = NEXT_QUEUE_STANDBY_RE.test(queuedText);
        if (s === 'working') working.push({ a: a, ctx: ctx });
        else if (s === 'waiting') waiting.push({ a: a, ctx: ctx });
        else if (s === 'error') blocked.push({ a: a, ctx: ctx });
        else if (queuedText && isRecent && !isStandby) nextQueue.push({ a: a, ctx: ctx });
      });
      function renderCol(colId, countId, items, emptyMsg) {
        var col = mc2El(colId);
        var count = mc2El(countId);
        if (!col) return;
        if (count) count.textContent = items.length;
        if (!items.length) { col.innerHTML = '<p class="mc-kanban-empty">' + emptyMsg + '</p>'; return; }
        col.innerHTML = items.map(function (item) { return mc2KanbanCard(item.a, item.ctx); }).join('');
        col.querySelectorAll('.mc-kanban-card[data-mc-agent]').forEach(function (card) {
          card.addEventListener('click', function () {
            var aid = card.getAttribute('data-mc-agent');
            if (aid) mc2SetAgentFilter(aid, 'context');
          });
        });
      }
      renderCol('mc2-col-working', 'mc2-col-count-working', working, 'No active work');
      renderCol('mc2-col-next', 'mc2-col-count-next', nextQueue, 'Nothing queued');
      renderCol('mc2-col-waiting', 'mc2-col-count-waiting', waiting, 'No agents waiting');
      renderCol('mc2-col-blocked', 'mc2-col-count-blocked', blocked, 'All clear');
    }

    function mc2RenderAgentsOverview() {
      function render(elId) {
        var el = mc2El(elId);
        if (!el) return;
        var agents = agentMapData || [];
        if (!agents.length) { el.innerHTML = '<p style="color:var(--muted);font-size:0.66rem;">No agents yet.</p>'; return; }
        el.innerHTML = agents.map(function (a) {
          var id = String(a.id || '');
          var ctx = (teamAgentContextSnapshot.agents || {})[id] || { state: 'idle' };
          var metrics = (teamAgentMetricsSnapshot.agents || {})[id] || {};
          var name = escapeHtml(agentCardShortName(a));
          var s = String(ctx.state || 'idle').toLowerCase();
          var focus = String(ctx.currentGoal || ctx.currentStep || ctx.currentThought || '').trim();
          if (!focus && s === 'idle') focus = 'Idle';
          else if (!focus) focus = s.charAt(0).toUpperCase() + s.slice(1);
          var active = agentCardActiveCount(ctx, metrics);
          var done = Number(metrics.totalHandled || 0);
          var waitingCount = s === 'waiting' ? 1 : 0;
          var lastTs = Number(ctx.updatedAt) || 0;
          return '<div class="mc-agent-overview-card" data-mc-agent="' + escapeHtml(id) + '">' +
            '<div class="mc-kanban-card-head">' +
              mc2AvatarHtml(a) +
              '<span class="mc-agent-role">' + name + '</span>' +
              '<span class="mc-agent-state-dot ' + escapeHtml(s) + '" aria-label="' + escapeHtml(s) + '"></span>' +
            '</div>' +
            '<div class="mc-agent-overview-focus">Focus: ' + escapeHtml(focus.slice(0, 40)) + '</div>' +
            '<div class="mc-agent-overview-stats">' +
              '<span class="active">' + active + ' Active</span>' +
              '<span>' + done + ' Done</span>' +
              (waitingCount ? '<span class="waiting">' + waitingCount + ' Waiting</span>' : '') +
            '</div>' +
            (lastTs ? '<div style="font-size:0.55rem;color:var(--muted);margin-top:0.25rem;">Last active: ' + mc2RelTime(lastTs) + '</div>' : '') +
          '</div>';
        }).join('');
        el.querySelectorAll('.mc-agent-overview-card[data-mc-agent]').forEach(function (card) {
          card.addEventListener('click', function () {
            var aid = card.getAttribute('data-mc-agent');
            if (aid) mc2SetAgentFilter(aid, 'context');
          });
        });
      }
      render('mc2-agents-overview');
      render('mc2-agents-detail');
    }

    function mc2TaskDisplayTitle(task) {
      var prompt = String(task && task.prompt || '').trim();
      if (prompt && !/^Handled in \d+/i.test(prompt) && !/^Completed turn/i.test(prompt)) {
        return prompt.slice(0, 160);
      }
      var summary = String(task && task.summary || '').trim();
      if (summary && !/^Handled in \d+/i.test(summary)) return summary.slice(0, 160);
      return 'Completed task';
    }

    function mc2TaskCard(task) {
      var agentId = String(task.agentId || '');
      var a = (agentMapData || []).find(function (x) { return String(x.id) === agentId; }) || { id: agentId };
      var name = escapeHtml(agentCardShortName(a));
      var title = escapeHtml(mc2TaskDisplayTitle(task));
      var when = mc2RelTime(Number(task.ts) || Date.now());
      var skills = Number(task.skillCount) || 0;
      var skillsLabel = skills ? (skills + ' skill' + (skills === 1 ? '' : 's')) : 'No tools';
      return '<div class="mc-task-card" data-mc-task-agent="' + escapeHtml(agentId) + '" data-ts="' + escapeHtml(String(task.ts || '')) + '">' +
        '<div class="mc-task-card-title">' + title + '</div>' +
        '<div class="mc-task-card-meta">' +
          '<span class="mc-task-card-agent">' + mc2AvatarHtml(a) + '<span>' + name + '</span></span>' +
          '<span class="done-tag">Done</span>' +
          '<span>' + escapeHtml(when) + '</span>' +
          '<span>' + escapeHtml(skillsLabel) + '</span>' +
        '</div>' +
      '</div>';
    }

    function mc2RenderTasks() {
      var el = mc2El('mc2-tasks-list');
      if (!el) return;
      mc2SyncAgentFilterControls();
      var range = teamAgentPanelRange || 'today';
      var tasks = listCompletedTasks({ range: range, agentId: mc2TasksAgentFilter });
      var titleEl = mc2El('mc2-tasks-title');
      var rangeLabel = teamAgentRangeLabel(range);
      if (titleEl) {
        titleEl.textContent = 'COMPLETED TASKS — ' + rangeLabel.toUpperCase() + ' (' + tasks.length + ')';
      }
      var label = mc2TasksAgentFilter ? agentNameById(mc2TasksAgentFilter) : 'all agents';
      if (!tasks.length) {
        mc2TimelineSpyEnabled = false;
        el.innerHTML = '<p class="mc-kanban-empty">No completed tasks for ' + escapeHtml(label) + ' in ' + escapeHtml(rangeLabel.toLowerCase()) + '.</p>';
        return;
      }
      mc2TimelineSpyEnabled = true;
      el.innerHTML = tasks.map(mc2TaskCard).join('');
      el.querySelectorAll('.mc-task-card[data-mc-task-agent]').forEach(function (card) {
        card.addEventListener('click', function () {
          var aid = card.getAttribute('data-mc-task-agent');
          if (aid) mc2SetAgentFilter(aid, 'context');
        });
      });
      mc2SyncTimelineHighlightForScroll();
    }

    function mc2RenderMovement() {
      var el = mc2El('mc2-recent-movement');
      if (!el) return;
      var groups = groupTeamActivityEvents((teamActivityEvents || []).slice(-80)).slice(0, 8);
      if (!groups.length) { el.innerHTML = '<p class="mc-kanban-empty">No activity yet.</p>'; return; }
      el.innerHTML = groups.map(function (group) {
        return renderTeamActivityGroupRow(group, { timeHtml: mc2RelTime(group.ts) });
      }).join('');
      mc2SyncTimelineHighlightForScroll();
    }

    function mc2RenderAttention() {
      var el = mc2El('mc2-attention');
      if (!el) return;
      var agents = agentMapData || [];
      var ctxMap = teamAgentContextSnapshot.agents || {};
      var items = [];
      agents.forEach(function (a) {
        var id = String(a.id || '');
        var ctx = ctxMap[id] || { state: 'idle' };
        var s = String(ctx.state || 'idle').toLowerCase();
        var lastTs = Number(ctx.updatedAt) || 0;
        if (s === 'error') {
          var reason = String(ctx.currentThought || ctx.lastAction || '').trim() || 'blocked';
          items.push({ kind: 'error', text: escapeHtml(agentCardShortName(a)) + ' blocked — ' + escapeHtml(reason.slice(0, 60)), ts: lastTs });
        } else if (s === 'waiting') {
          var waitFor = String(ctx.waitingFor || '').trim();
          var desc = waitFor ? 'waiting for ' + escapeHtml(agentNameById(waitFor)) : 'waiting for response';
          items.push({ kind: 'warning', text: escapeHtml(agentCardShortName(a)) + ' ' + desc, ts: lastTs });
        }
      });
      var goals = Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : [];
      goals.forEach(function (g) {
        if (String(g.status || '').toLowerCase() === 'blocked') {
          items.push({ kind: 'error', text: 'Mission blocked: ' + escapeHtml(String(g.title || g.objective || '').slice(0, 60)), ts: Number(g.updatedAt) || 0 });
        }
      });
      mc2PendingItems().forEach(function (p) {
        var label = mc2PendingKindLabel(p.kind) + ': ' + mc2PendingTitle(p);
        items.push({ kind: 'warning', text: 'Awaiting approval — ' + escapeHtml(label.slice(0, 72)), ts: Number(p.createdAt) || 0 });
      });
      items.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      if (!items.length) { el.innerHTML = '<p class="mc-kanban-empty">All clear.</p>'; return; }
      el.innerHTML = items.slice(0, 6).map(function (item) {
        var icon = item.kind === 'error' ? '🔴' : '⚠️';
        return '<div class="mc-attention-item ' + item.kind + '">' +
          '<span class="mc-attention-icon">' + icon + '</span>' +
          '<span class="mc-attention-text">' + item.text + '</span>' +
          (item.ts ? '<span style="margin-left:auto;flex-shrink:0;font-size:0.58rem;color:var(--muted);">' + mc2RelTime(item.ts) + '</span>' : '') +
        '</div>';
      }).join('');
    }

    function mc2RenderActivity() {
      var el = mc2El('mc2-activity-feed');
      if (!el) return;
      if (mc2ActiveView === 'inbox' || mc2ActiveView === 'outbox') {
        mc2RenderMailbox(mc2ActiveView);
        return;
      }
      mc2TimelineSpyEnabled = false;
      var titleEl = mc2El('mc2-activity-title');
      if (titleEl) titleEl.textContent = 'LIVE ACTIVITY';
      mc2SyncInboxAgentFilter();
      var filtered = (teamActivityEvents || []).filter(function (ev) {
        return mc2EventMatchesAgent(ev, mc2InboxAgentFilter);
      });
      var groups = groupTeamActivityEvents(filtered.slice(-200)).slice(0, 60);
      if (!groups.length) {
        mc2TimelineSpyEnabled = false;
        var emptyLabel = mc2InboxAgentFilter ? (' for ' + agentNameById(mc2InboxAgentFilter)) : '';
        el.innerHTML = '<p class="mc-kanban-empty">No activity' + escapeHtml(emptyLabel) + ' yet.</p>';
        return;
      }
      mc2TimelineSpyEnabled = true;
      el.innerHTML = groups.map(function (group) {
        return renderTeamActivityGroupRow(group, { timeHtml: mc2RelTime(group.ts) });
      }).join('');
      mc2SyncTimelineHighlightForScroll();
    }

    function mc2MailboxAgentIds() {
      if (mc2InboxAgentFilter) return [mc2InboxAgentFilter];
      var ids = {};
      (agentMapData || []).forEach(function (a) {
        var id = String(a && a.id || '').trim();
        if (id) ids[id] = true;
      });
      (teamActivityEvents || []).forEach(function (event) {
        var agentId = String(event && event.agentId || '').trim();
        var targetAgentId = String(event && event.targetAgentId || '').trim();
        if (agentId) ids[agentId] = true;
        if (targetAgentId) ids[targetAgentId] = true;
        var details = event && typeof event.details === 'object' ? event.details : null;
        var selectedId = String(details && details.selected || '').trim();
        if (selectedId) ids[selectedId] = true;
      });
      var agentIds = Object.keys(ids);
      if (!agentIds.length) agentIds.push('main');
      return agentIds;
    }

    function mc2MailboxFlows(direction, range) {
      var flows = [];
      var activeRange = String(range || teamAgentPanelRange || 'today').trim();
      mc2MailboxAgentIds().forEach(function (agentId) {
        filterFlowsForMailbox(buildAgentInboxFlows(agentId, activeRange), direction).forEach(function (flow) {
          flows.push({ ts: flow.ts, agentId: agentId, entries: flow.entries || [] });
        });
      });
      flows = filterFlowsByTeamAgentRange(flows, activeRange);
      flows.sort(function (a, b) { return (Number(b.ts) || 0) - (Number(a.ts) || 0); });
      return flows;
    }

    function mc2RenderMailbox(direction) {
      var el = mc2El('mc2-activity-feed');
      if (!el) return;
      var titleEl = mc2El('mc2-activity-title');
      if (titleEl) titleEl.textContent = direction === 'outbox' ? 'OUTBOX' : 'INBOX';
      mc2SyncInboxAgentFilter();
      var flows = mc2MailboxFlows(direction, 'all').slice(0, 200);
      var label = mc2InboxAgentFilter ? agentNameById(mc2InboxAgentFilter) : 'all agents';
      if (!flows.length) {
        mc2TimelineSpyEnabled = false;
        el.innerHTML = '<p class="mc-kanban-empty">No ' + escapeHtml(direction) + ' activity for ' + escapeHtml(label) + ' yet.</p>';
        return;
      }
      mc2TimelineSpyEnabled = true;
      var showAgent = !mc2InboxAgentFilter;
      var rows = flows.map(function (flow) {
        var flowTs = Number(flow && flow.ts) || 0;
        return '<div class="team-agent-inbox-flow" data-ts="' + escapeHtml(String(flowTs)) + '">' +
          (showAgent ? '<div class="team-agent-inbox-label">' + escapeHtml(agentNameById(flow.agentId)) + '</div>' : '') +
          flow.entries.map(renderInboxEntry).join('') +
        '</div>';
      }).join('');
      el.innerHTML = rows;
      mc2SyncTimelineHighlightForScroll();
    }

    function mc2ScrollToRange(rangeKey) {
      var key = TEAM_AGENT_RANGE_LABELS[String(rangeKey || '').trim()] ? String(rangeKey) : 'today';
      var pair = mc2ScrollViewAndFeed();
      var view = pair.view;
      var feed = pair.feed;
      if (!view || view.hidden || !feed) return;
      var markers = feed.querySelectorAll('[data-ts]');
      if (!markers.length) {
        mc2SetTimelineHighlight(key);
        return;
      }
      var target = null;
      for (var i = 0; i < markers.length; i++) {
        var ts = Number(markers[i].getAttribute('data-ts')) || 0;
        if (mc2InferRangeFromTs(ts) === key) {
          target = markers[i];
          break;
        }
      }
      if (!target && key === 'last30') target = markers[markers.length - 1];
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start', inline: 'nearest' });
      } else {
        view.scrollTo({ top: 0, behavior: 'smooth' });
      }
      mc2SetTimelineHighlight(key);
    }

    function mc2SetAgentFilter(agentId, nextView) {
      mc2InboxAgentFilter = String(agentId || '').trim();
      mc2SyncAgentFilterControls();
      if (nextView) {
        mc2SetView(nextView);
        return;
      }
      if (mc2ActiveView === 'activity' || mc2ActiveView === 'inbox' || mc2ActiveView === 'outbox') mc2RenderActivity();
      if (mc2ActiveView === 'context') mc2RenderContext();
      if (mc2ActiveView === 'stats') mc2RenderStats();
    }

    function mc2AgentIdsForFilter() {
      var agents = agentMapData && agentMapData.length ? agentMapData : [{ id: 'main' }];
      if (mc2InboxAgentFilter) return [mc2InboxAgentFilter];
      return agents.map(function (a) { return String(a && a.id || ''); }).filter(Boolean);
    }

    function mc2ContextSections() {
      var ids = mc2AgentIdsForFilter();
      var sections = [];
      var showAgent = !mc2InboxAgentFilter;
      ids.forEach(function (agentId) {
        var ctx = (teamAgentContextSnapshot.agents || {})[agentId] || { state: 'idle' };
        var display = resolveAgentContextDisplay(agentId, ctx);
        var liveTs = Number(ctx.updatedAt) || 0;
        var hasLive = liveTs > 0 || ctx.state !== 'idle' || display.goal ||
          (display.thought && display.thought !== 'Standing by for the next task.');
        if (hasLive) {
          sections.push({
            ts: liveTs || Date.now(),
            html: (showAgent ? '<div class="team-agent-inbox-label">' + escapeHtml(agentNameById(agentId)) + '</div>' : '') +
              renderAgentContextCard(agentId, ctx),
          });
        }
        (teamActivityEvents || []).forEach(function (event) {
          if (!mc2EventMatchesAgent(event, agentId)) return;
          var ts = Number(event.ts) || 0;
          if (!ts) return;
          var text = formatTeamActivityText ? formatTeamActivityText(event) : escapeHtml(String(event.type || ''));
          var a = (agentMapData || []).find(function (x) { return String(x.id) === agentId; }) || { id: agentId };
          sections.push({
            ts: ts,
            html: (showAgent ? '<div class="team-agent-inbox-label">' + escapeHtml(agentNameById(agentId)) + '</div>' : '') +
              '<div class="mc-movement-item" style="padding-left:0;">' +
                '<span class="mc-movement-time">' + mc2RelTime(ts) + '</span>' +
                mc2AvatarHtml(a) +
                '<span>' + text + '</span>' +
              '</div>',
          });
        });
      });
      sections.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      return sections.slice(0, 200);
    }

    function mc2RenderContext() {
      var el = mc2El('mc2-context-list');
      if (!el) return;
      mc2SyncAgentFilterControls();
      var ids = mc2AgentIdsForFilter();
      if (!ids.length) {
        mc2TimelineSpyEnabled = false;
        el.innerHTML = '<p class="team-agent-inbox-empty">No agents available.</p>';
        return;
      }
      var sections = mc2ContextSections();
      var label = mc2InboxAgentFilter ? agentNameById(mc2InboxAgentFilter) : 'all agents';
      if (!sections.length) {
        mc2TimelineSpyEnabled = false;
        el.innerHTML = '<p class="mc-kanban-empty">No context activity for ' + escapeHtml(label) + ' yet.</p>';
        return;
      }
      mc2TimelineSpyEnabled = true;
      el.innerHTML = sections.map(function (section) {
        return '<div class="team-agent-inbox-flow" data-ts="' + escapeHtml(String(section.ts)) + '">' +
          section.html +
        '</div>';
      }).join('');
      mc2SyncTimelineHighlightForScroll();
    }

    function mc2RenderStats() {
      var el = mc2El('mc2-stats-list');
      if (!el) return;
      mc2SyncAgentFilterControls();
      var ids = mc2AgentIdsForFilter();
      if (!ids.length) {
        el.innerHTML = '<p class="team-agent-inbox-empty">No agents available.</p>';
        return;
      }
      el.innerHTML = ids.map(function (agentId) {
        var metrics = (teamAgentMetricsSnapshot.agents || {})[agentId] || {
          tasksHandled: 0,
          delegatedOut: 0,
          received: 0,
          avgDurationMs: 0,
          skills: {},
        };
        return renderAgentMetricsCard(agentId, metrics);
      }).join('');
    }

    function mc2EventMatchesAgent(event, agentId) {
      var id = String(agentId || '').trim();
      if (!id) return true;
      if (String(event && event.agentId || '') === id) return true;
      if (String(event && event.targetAgentId || '') === id) return true;
      var details = event && typeof event.details === 'object' ? event.details : null;
      if (!details) return false;
      if (String(details.selected || '') === id) return true;
      var candidates = Array.isArray(details.candidates) ? details.candidates : [];
      return candidates.some(function (c) { return String(c && c.agentId || '') === id; });
    }

    function mc2SyncInboxAgentFilter() {
      mc2SyncAgentFilterControls();
    }

    function mc2SyncAgentFilterControls() {
      var agents = agentMapData && agentMapData.length ? agentMapData : [{ id: 'main' }];
      var hasInbox = !mc2InboxAgentFilter || agents.some(function (a) {
        return String(a && a.id || '') === mc2InboxAgentFilter;
      });
      if (!hasInbox) mc2InboxAgentFilter = '';
      var hasTasks = !mc2TasksAgentFilter || agents.some(function (a) {
        return String(a && a.id || '') === mc2TasksAgentFilter;
      });
      if (!hasTasks) mc2TasksAgentFilter = '';
      function optionsHtml(selectedId) {
        return '<option value="">All agents</option>' + agents.map(function (a) {
          var id = String(a && a.id || '');
          if (!id) return '';
          var selected = id === selectedId ? ' selected' : '';
          return '<option value="' + escapeHtml(id) + '"' + selected + '>' + escapeHtml(agentDisplayLabel(a)) + '</option>';
        }).join('');
      }
      document.querySelectorAll('#page-team2 .mc2-agent-filter-select').forEach(function (selectEl) {
        var isTasks = selectEl.id === 'mc2-tasks-agent-filter';
        var selected = isTasks ? mc2TasksAgentFilter : mc2InboxAgentFilter;
        var html = optionsHtml(selected);
        if (selectEl.innerHTML !== html) selectEl.innerHTML = html;
        if (selectEl.value !== selected) selectEl.value = selected;
      });
    }

    function mc2ProjectNameById(projectId) {
      var pid = String(projectId || '').trim();
      if (!pid) return '';
      var match = (mc2ProjectsSnapshot || []).find(function (p) { return String(p.id || '') === pid; });
      return match ? String(match.name || '') : '';
    }

    async function mc2RenderGoals() {
      var el = mc2El('mc2-goals-list');
      if (!el) return;
      var api = window.cowCodeProjectsApi;
      if (api && typeof api.listProjects === 'function') {
        try {
          var projList = await api.listProjects();
          if (Array.isArray(projList)) mc2ProjectsSnapshot = projList;
        } catch (_) {}
      }
      var goals = Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : [];
      if (!goals.length) { el.innerHTML = '<p style="color:var(--muted);font-size:0.66rem;">No missions yet. Create one from the Team mission controls.</p>'; return; }
      el.innerHTML = goals.map(function (g) {
        var status = String(g.status || 'active').toLowerCase();
        var pct = Math.max(0, Math.min(100, Math.round(Number((g.progress && g.progress.pct) || 0))));
        var subs = Array.isArray(g.subgoals) ? g.subgoals : [];
        var doneSubs = subs.filter(function (s) { return String(s.status || '').toLowerCase() === 'done'; }).length;
        var projectName = mc2ProjectNameById(g.projectId);
        var projectLine = projectName
          ? '<div class="mc-progress-meta">Project: <button type="button" class="mc-panel-link" data-mc-nav="projects" data-project-id="' + escapeHtml(String(g.projectId || '')) + '">' + escapeHtml(projectName) + '</button></div>'
          : '';
        return '<div class="mc-progress-card" style="cursor:default;">' +
          '<div class="mc-progress-head">' +
            '<h3>' + escapeHtml(String(g.title || g.objective || 'Untitled mission')) + '</h3>' +
            '<span class="team-goal-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' +
          '</div>' +
          '<div class="mc-progress-bar"><span style="width:' + pct + '%"></span></div>' +
          '<div class="mc-progress-meta">' + pct + '% · Owner: ' + escapeHtml(goalOwnerLabel(g)) +
            (subs.length ? ' · ' + doneSubs + '/' + subs.length + ' tasks' : '') + '</div>' +
          projectLine +
        '</div>';
      }).join('');
      el.querySelectorAll('.mc-panel-link[data-project-id]').forEach(function (btn) {
        if (btn._wired) return;
        btn._wired = true;
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          mc2SelectedProjectId = btn.getAttribute('data-project-id') || '';
          mc2SetView('projects');
          if (mc2SelectedProjectId) mc2ScrollToProject(mc2SelectedProjectId);
        });
      });
    }

    function mc2RenderInitiatives() {
      var el = mc2El('mc2-initiatives-list');
      if (!el) return;
      var initiatives = Array.isArray(teamInitiativesSnapshot.initiatives) ? teamInitiativesSnapshot.initiatives.slice() : [];
      initiatives.sort(function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); });
      if (!initiatives.length) {
        el.innerHTML = '<p style="color:var(--muted);font-size:0.66rem;">No initiatives yet. They appear here when reflection or team activity suggests follow-up work.</p>';
        return;
      }
      el.innerHTML = initiatives.map(function (it) {
        var status = String(it.status || 'open').toLowerCase();
        var confidence = Math.round((Number(it.confidence) || 0) * 100);
        var relatedGoals = Array.isArray(it.relatedGoalIds) ? it.relatedGoalIds : [];
        var relatedLabel = relatedGoals.length ? relatedGoals.map(function (gid) {
          var goal = (teamGoalsSnapshot.goals || []).find(function (g) { return String(g.id || '') === String(gid); });
          return goal ? String(goal.title || goal.objective || gid) : String(gid);
        }).join(', ') : 'None';
        return '<div class="mc-progress-card" style="cursor:default;">' +
          '<div class="mc-progress-head">' +
            '<h3>' + escapeHtml(String(it.title || 'Untitled initiative')) + '</h3>' +
            '<span class="team-initiative-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' +
          '</div>' +
          '<div class="team-goal-meta"><span class="team-initiative-type">' + escapeHtml(String(it.type || 'observation')) + '</span></div>' +
          '<div class="team-goal-meta"><strong>Confidence:</strong> ' + escapeHtml(String(confidence)) + '%</div>' +
          '<div class="team-goal-meta"><strong>Source:</strong> ' + escapeHtml(String(it.source || '')) + '</div>' +
          '<div class="team-goal-meta"><strong>Related goals:</strong> ' + escapeHtml(relatedLabel) + '</div>' +
          '<div class="team-goal-meta">' + escapeHtml(String(it.description || '').slice(0, 220)) + '</div>' +
        '</div>';
      }).join('');
    }

    function mc2RenderAgentsDetail() {
      mc2RenderAgentsOverview();
    }

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
      mc2RenderPendingInline('mc2-goals-pending', 'mission_plan');
      mc2RenderPendingInline('mc2-tasks-pending', 'mission_plan');
      if (mc2ActiveView === 'mission') mc2RenderAttention();
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
        await fetchGoalsSnapshot();
        await fetchInitiativesSnapshot();
        if (window.cowCodeProjectsApi && typeof window.cowCodeProjectsApi.listProjects === 'function') {
          try {
            mc2ProjectsSnapshot = await window.cowCodeProjectsApi.listProjects();
          } catch (_) {}
        }
        if (mc2ActiveView === 'projects') mc2RenderProjects();
        if (mc2ActiveView === 'goals') mc2RenderGoals();
        if (mc2ActiveView === 'tasks') mc2RenderTasks();
        renderMissionControl();
      } catch (err) {
        alert(err && err.message ? err.message : String(err));
      } finally {
        mc2PendingActionBusy = false;
        document.querySelectorAll('.mc-pending-btn').forEach(function (btn) { btn.disabled = false; });
      }
    }

    function renderMissionControl() {
      try {
        mc2RenderMissionProgress();
        mc2RenderKanban();
        mc2RenderAgentsOverview();
        mc2RenderMovement();
        mc2RenderAttention();
        mc2UpdateLiveBadge();
        mc2UpdateApprovalsBadge();
        mc2RenderPendingApprovalsBanner();
        mc2RenderPendingInline('mc2-goals-pending', 'mission_plan');
        mc2RenderPendingInline('mc2-tasks-pending', 'mission_plan');
        mc2ScheduleSidebarProjects();
        if (mc2ActiveView === 'activity' || mc2ActiveView === 'inbox' || mc2ActiveView === 'outbox') mc2RenderActivity();
        if (mc2ActiveView === 'goals') mc2RenderGoals();
        if (mc2ActiveView === 'initiatives') mc2RenderInitiatives();
        if (mc2ActiveView === 'projects') mc2RenderProjects();
        if (mc2ActiveView === 'context') mc2RenderContext();
        if (mc2ActiveView === 'stats') mc2RenderStats();
        if (mc2ActiveView === 'tasks') mc2RenderTasks();
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
        if (nav) mc2SetView(nav);
      });
    });
    document.querySelectorAll('#page-team2 .mc-stat-card-action[data-mc-nav]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var nav = btn.getAttribute('data-mc-nav');
        if (nav) mc2SetView(nav);
      });
    });
    var mc2AddAgentBtn = document.getElementById('mc2-add-agent-btn');
    if (mc2AddAgentBtn) {
      mc2AddAgentBtn.addEventListener('click', function () {
        openAgentCreateModal({ fromAgentId: selectedChatAgentId });
      });
    }
    var mc2PendingRoot = document.getElementById('page-team2');
    if (mc2PendingRoot) {
      mc2PendingRoot.addEventListener('click', function (e) {
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
          if (mc2ActiveView === 'tasks') mc2RenderTasks();
          return;
        }
        mc2SetAgentFilter(selectEl.value || '');
      });
    });
    document.querySelectorAll('#page-team2 .mc2-range-controls .team-agent-panel-range').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var range = btn.getAttribute('data-range') || 'today';
        if (mc2ActiveView === 'activity' || mc2ActiveView === 'inbox' || mc2ActiveView === 'outbox' || mc2ActiveView === 'context') {
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
          var api = window.cowCodeProjectsApi;
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
