/* ── Mission Control (#team2) ─────────────────────────────────────────── */

    var mc2ActiveView = 'tasks';
    var mc2InboxAgentFilter = '';
    var mc2TasksAgentFilter = '';
    var mc2SelectedProjectId = '';
    var mc2ProjectsSnapshot = [];
    var mc2SidebarProjectsTimer = 0;
    var mc2TimelineScrollRaf = 0;
    var mc2TimelineHighlightKey = '';
    var mc2TimelineSpyEnabled = false;
    var mc2PendingActionBusy = false;
    var mc2TasksFilter = 'all';
    var mc2SelectedTask = null;

    function mc2El(id) { return document.getElementById(id); }

    function mc2SetTasksFilter(filter) {
      var next = String(filter || 'all').trim();
      if (['all', 'blocked', 'open', 'done'].indexOf(next) < 0) next = 'all';
      mc2TasksFilter = next;
      document.querySelectorAll('#mc2-tasks-filters .mc2-tasks-filter').forEach(function (btn) {
        var active = btn.getAttribute('data-mc-tasks-filter') === mc2TasksFilter;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      var rangeWrap = mc2El('mc2-tasks-range-wrap');
      if (rangeWrap) rangeWrap.hidden = mc2TasksFilter !== 'done' && mc2TasksFilter !== 'all';
    }

    function mc2OpenTasksView(filter) {
      mc2SetTasksFilter(filter || 'all');
      mc2SetView('tasks');
      mc2RenderTasks();
      mc2RenderTaskDetail();
    }

    function mc2ScrollToMissionTaskCard(item) {
      if (!item) return;
      var subgoalId = String(item.subgoalId || '');
      if (!subgoalId) return;
      var safeId = String(subgoalId).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      var card = document.querySelector(
        '#page-team2 .mc-mission-task-card[data-subgoal-id="' + safeId + '"]'
      );
      if (card) {
        document.querySelectorAll('#page-team2 .mc-mission-task-card').forEach(function (c) {
          c.classList.remove('mc-task-card-selected');
        });
        card.classList.add('mc-task-card-selected');
        try { card.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
        if (typeof highlightBlockedTarget === 'function') highlightBlockedTarget(card);
      }
    }

    function mc2OpenTaskDrawer() {
      var drawer = mc2El('mc2-task-drawer');
      if (!drawer) return;
      drawer.classList.add('open');
      drawer.setAttribute('aria-hidden', 'false');
    }

    function mc2CloseTaskDrawer() {
      var drawer = mc2El('mc2-task-drawer');
      if (!drawer) return;
      drawer.classList.remove('open');
      drawer.setAttribute('aria-hidden', 'true');
    }

    function mc2FormatTaskTimestamp(ts) {
      var n = Number(ts) || 0;
      if (!n) return '—';
      if (typeof mc2RelTime === 'function') return mc2RelTime(n);
      return new Date(n).toLocaleString();
    }

    function mc2BuildTaskDetailHtml(item) {
      if (!item) {
        return '<p class="team-agent-inbox-empty" style="margin:0;">Select a task to see its timeline and actions.</p>';
      }
      var title = String(item.title || 'Untitled task');
      var status = String(item.status || 'todo').toLowerCase();
      var statusLabel = mc2MissionTaskStatusLabel(status);
      if (status === 'done') statusLabel = 'Completed';
      var mission = String(item.missionTitle || '').trim();
      var assignee = String(item.assignee || item.agentId || '').trim();
      var createdBy = String(item.createdByLabel || 'User').trim();
      var reason = String(item.reason || '').trim();
      var skills = Array.isArray(item.skillsUsed) ? item.skillsUsed : [];
      var skillsLabel = skills.length ? skills.join(', ') : '—';
      var actionsHtml = typeof missionTaskActionButtonsHtml === 'function'
        ? missionTaskActionButtonsHtml(item.goalId, item.subgoalId, status, {
          fromInitiative: !!item.fromInitiative,
          inDetailPanel: true,
        })
        : '';
      var events = typeof buildStructuredMissionTaskTimeline === 'function'
        ? buildStructuredMissionTaskTimeline(item, 20)
        : [];
      var timelineHtml = events.length
        ? '<ul class="mc-task-timeline">' + events.map(function (ev) {
          return typeof formatStructuredMissionTaskTimelineLine === 'function'
            ? formatStructuredMissionTaskTimelineLine(ev)
            : '';
        }).join('') + '</ul>'
        : '<p class="mc-kanban-empty" style="margin:0.35rem 0 0;">No timeline entries yet for this task.</p>';
      var agentLink = assignee
        ? '<button type="button" class="mc-panel-link" data-mc-task-agent-context="' + escapeHtml(assignee) + '">Assignee tasks (' + escapeHtml(agentNameById(assignee)) + ') →</button>'
        : '';
      var fields = [
        { label: 'Status', value: statusLabel },
        mission ? { label: 'Mission', value: mission } : null,
        assignee ? { label: 'Assigned To', value: agentNameById(assignee) } : null,
        { label: 'Created By', value: createdBy },
        item.createdAt ? { label: 'Created', value: mc2FormatTaskTimestamp(item.createdAt) } : null,
        item.completedAt && status === 'done' ? { label: 'Completed', value: mc2FormatTaskTimestamp(item.completedAt) } : null,
        { label: 'Skills Used', value: skillsLabel },
      ].filter(Boolean);
      var fieldsHtml = '<dl class="mc-task-detail-fields">' + fields.map(function (row) {
        return '<dt>' + escapeHtml(row.label) + '</dt><dd>' + escapeHtml(row.value) + '</dd>';
      }).join('') + '</dl>';
      return '' +
        '<div class="mc-task-detail-head">' +
          '<h3 class="mc-task-detail-title" id="mc2-task-drawer-title">' + escapeHtml(title) + '</h3>' +
          '<span class="team-goal-subgoal-status ' + escapeHtml(status) + '">' + escapeHtml(statusLabel) + '</span>' +
        '</div>' +
        fieldsHtml +
        (reason
          ? '<div class="mc-task-detail-reason"><strong>Reason:</strong> ' + escapeHtml(reason) + '</div>'
          : '') +
        actionsHtml +
        '<p class="mc-section-title" style="margin:0.65rem 0 0.35rem;">Timeline</p>' +
        timelineHtml +
        '<div class="mc-task-detail-links">' + agentLink + '</div>';
    }

    function mc2RenderTaskDetail() {
      var panel = mc2El('mc2-task-detail');
      var drawerBody = mc2El('mc2-task-drawer-body');
      var item = mc2SelectedTask;
      if (typeof enrichMissionTaskItem === 'function' && item) {
        item = enrichMissionTaskItem(item);
        mc2SelectedTask = item;
      }
      var html = mc2BuildTaskDetailHtml(item);
      if (drawerBody) {
        drawerBody.innerHTML = html;
        if (typeof wireMissionTaskActions === 'function') wireMissionTaskActions(drawerBody);
        drawerBody.querySelectorAll('[data-mc-task-agent-context]').forEach(function (btn) {
          if (btn._wiredCtx) return;
          btn._wiredCtx = true;
          btn.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            mc2OpenTaskDetailForAgent(btn.getAttribute('data-mc-task-agent-context') || '');
          });
        });
      }
      if (panel) {
        if (!item || !String(item.goalId || item.subgoalId || item.title || '').trim()) {
          panel.hidden = true;
          panel.innerHTML = '<p class="team-agent-inbox-empty" style="margin:0;">Select a task from the board, list, or recent movement.</p>';
        } else {
          panel.hidden = false;
          panel.innerHTML = html;
          if (typeof wireMissionTaskActions === 'function') wireMissionTaskActions(panel);
          panel.querySelectorAll('[data-mc-task-agent-context]').forEach(function (btn) {
            if (btn._wiredCtx) return;
            btn._wiredCtx = true;
            btn.addEventListener('click', function (e) {
              e.preventDefault();
              e.stopPropagation();
              mc2OpenTaskDetailForAgent(btn.getAttribute('data-mc-task-agent-context') || '');
            });
          });
        }
      }
    }

    function mc2ResolveTaskFromCard(card) {
      if (!card) return null;
      var goalId = String(card.getAttribute('data-goal-id') || '').trim();
      var subgoalId = String(card.getAttribute('data-subgoal-id') || '').trim();
      var title = String(card.getAttribute('data-title') || '').trim();
      var agentId = String(card.getAttribute('data-agent-id') || card.getAttribute('data-mc-agent') || '').trim();
      var turnTs = Number(card.getAttribute('data-turn-ts') || 0);
      var item = null;
      if (typeof findMissionTaskItem === 'function') {
        item = findMissionTaskItem({ goalId: goalId, subgoalId: subgoalId, title: title, agentId: agentId });
      }
      if (!item && title && typeof findMissionTaskItemByTitle === 'function') {
        item = findMissionTaskItemByTitle(title);
      }
      if (!item && turnTs && agentId && typeof buildMissionTaskFromTurn === 'function') {
        item = buildMissionTaskFromTurn({ agentId: agentId, ts: turnTs });
      }
      return item;
    }

    function mc2OpenTaskDetail(item, opts) {
      opts = opts || {};
      if (!item && opts.turnTs && opts.agentId && typeof buildMissionTaskFromTurn === 'function') {
        item = buildMissionTaskFromTurn({ agentId: opts.agentId, ts: Number(opts.turnTs) });
      }
      if (!item && opts.agentId && typeof findMissionTaskForAgent === 'function') {
        var ctx = (teamAgentContextSnapshot.agents || {})[opts.agentId] || {};
        item = findMissionTaskForAgent(opts.agentId, ctx);
      }
      if (!item && opts.goalId && typeof findMissionTaskItem === 'function') {
        item = findMissionTaskItem({
          goalId: opts.goalId,
          subgoalId: opts.subgoalId,
          title: opts.title,
          agentId: opts.agentId,
        });
      }
      if (!item && opts.title && typeof findMissionTaskItemByTitle === 'function') {
        item = findMissionTaskItemByTitle(opts.title);
      }
      mc2SelectedTask = item || null;
      if (opts.filter) mc2SetTasksFilter(opts.filter);
      else if (item && item.status === 'blocked') mc2SetTasksFilter('blocked');
      else if (opts.switchView) mc2SetTasksFilter('all');
      if (opts.agentId) mc2TasksAgentFilter = String(opts.agentId);
      if (opts.switchView === true) {
        mc2SetView('tasks');
        mc2RenderTasks();
        setTimeout(function () { mc2ScrollToMissionTaskCard(item); }, 80);
      } else if (mc2ActiveView === 'tasks') {
        mc2RenderTasks();
      }
      mc2RenderTaskDetail();
      if (item) mc2OpenTaskDrawer();
      else mc2CloseTaskDrawer();
    }

    function mc2OpenTaskDetailForAgent(agentId) {
      var aid = String(agentId || '').trim();
      if (!aid) return;
      var ctx = (teamAgentContextSnapshot.agents || {})[aid] || {};
      var item = typeof findMissionTaskForAgent === 'function' ? findMissionTaskForAgent(aid, ctx) : null;
      mc2OpenTaskDetail(item, { agentId: aid, filter: item && item.status === 'blocked' ? 'blocked' : 'all' });
    }

    function mc2OpenTaskForInitiative(initiativeId) {
      var id = String(initiativeId || '').trim();
      if (!id) return;
      var subgoalId = 'init-' + id;
      var item = typeof findMissionTaskItem === 'function'
        ? findMissionTaskItem({ subgoalId: subgoalId })
        : null;
      if (item) {
        mc2OpenTaskDetail(item, { filter: 'all' });
        return;
      }
      selectedTeamInitiativeId = id;
      mc2SetView('initiatives');
      if (typeof renderInitiativesPanels === 'function') renderInitiativesPanels();
    }

    window.mc2OpenTasksView = mc2OpenTasksView;
    window.mc2SetTasksFilter = mc2SetTasksFilter;
    window.mc2OpenTaskDetail = mc2OpenTaskDetail;
    window.mc2OpenTaskDetailForAgent = mc2OpenTaskDetailForAgent;
    window.mc2OpenTaskForInitiative = mc2OpenTaskForInitiative;
    window.mc2CloseTaskDrawer = mc2CloseTaskDrawer;

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

    function mc2ShortWaitTime(ts) {
      var ms = Date.now() - Number(ts || 0);
      if (ms < 0) ms = 0;
      var s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      var m = Math.floor(s / 60);
      if (m < 60) return m + 'm';
      var h = Math.floor(m / 60);
      if (h < 48) return h + 'h';
      var d = Math.floor(h / 24);
      return d + 'd';
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
        '<button type="button" class="mc-panel-link mc-kanban-context-link" data-mc-open-context="1" data-mc-agent="' + escapeHtml(id) + '">Agent context →</button>' +
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
      if (typeof renderTeamUserInputModal === 'function') renderTeamUserInputModal();
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

    function mc2InitiativeWasAutoPromoted(initiative) {
      var raw = initiative && initiative.activity;
      var lines = Array.isArray(raw) ? raw : (raw ? [String(raw)] : []);
      return lines.some(function (line) {
        return String(line || '').indexOf('Auto-promoted to subgoal in ') >= 0;
      });
    }

    function mc2InitiativeDiscoveryIcon(initiative) {
      var type = String(initiative && initiative.type || 'observation').toLowerCase();
      if (type === 'risk' || type === 'gap' || type === 'warning') return '⚠';
      return '💡';
    }

    function mc2KanbanCompletedCard(item) {
      var title = escapeHtml(String(item.title || 'Completed task'));
      var rawTitle = String(item.title || 'Completed task');
      var meta = [];
      if (item.delegatedFrom) {
        meta.push('Assigned by ' + escapeHtml(agentNameById(item.delegatedFrom) || item.delegatedFrom));
      }
      if (item.assignee) {
        meta.push('Completed by ' + escapeHtml(agentNameById(item.assignee) || item.assignee));
      } else if (item.agentId) {
        meta.push('Completed by ' + escapeHtml(agentNameById(item.agentId) || item.agentId));
      }
      if (!meta.length) meta.push('Completed');
      var when = item.ts ? mc2RelTime(Number(item.ts)) : '';
      var attrs = ' class="mc-kanban-card mc-kanban-card-completed" role="button" tabindex="0"';
      attrs += ' data-title="' + escapeHtml(rawTitle) + '"';
      if (item.goalId) attrs += ' data-goal-id="' + escapeHtml(String(item.goalId)) + '"';
      if (item.subgoalId) attrs += ' data-subgoal-id="' + escapeHtml(String(item.subgoalId)) + '"';
      if (item.agentId) attrs += ' data-mc-agent="' + escapeHtml(String(item.agentId)) + '" data-agent-id="' + escapeHtml(String(item.agentId)) + '"';
      if (item.kind === 'turn' && item.ts) attrs += ' data-turn-ts="' + escapeHtml(String(item.ts)) + '" data-mc-kanban-kind="turn"';
      if (item.kind) attrs += ' data-mc-kanban-kind="' + escapeHtml(String(item.kind)) + '"';
      return '<div' + attrs + '>' +
        '<div class="mc-kanban-card-title">✓ ' + title + '</div>' +
        meta.map(function (line) { return '<div class="mc-kanban-card-meta">' + line + '</div>'; }).join('') +
        (when ? '<div class="mc-kanban-card-meta mc-kanban-card-when">' + escapeHtml(when) + '</div>' : '') +
      '</div>';
    }

    function mc2KanbanAttentionCard(item) {
      var icon = item.kind === 'error' ? '🔴' : '⚠';
      var attrs = ' class="mc-kanban-card mc-kanban-card-attention ' + escapeHtml(item.kind || 'warning') + '"';
      attrs += ' data-mc-kanban-kind="attention" data-attention-action="' + escapeHtml(item.action || '') + '"';
      if (item.goalId) attrs += ' data-goal-id="' + escapeHtml(item.goalId) + '"';
      if (item.subgoalId) attrs += ' data-subgoal-id="' + escapeHtml(item.subgoalId) + '"';
      if (item.agentId) attrs += ' data-agent-id="' + escapeHtml(item.agentId) + '"';
      if (item.pendingId) attrs += ' data-pending-id="' + escapeHtml(item.pendingId) + '"';
      if (item.initiativeId) attrs += ' data-initiative-id="' + escapeHtml(item.initiativeId) + '"';
      return '<div' + attrs + ' role="button" tabindex="0">' +
        '<div class="mc-kanban-card-title">' + icon + ' ' + escapeHtml(item.title) + '</div>' +
        (item.subtitle || item.text
          ? '<div class="mc-kanban-card-meta">' + escapeHtml(item.subtitle || String(item.text || '').replace(/^[^—]+—\s*/, '')) + '</div>'
          : '') +
        (item.ts ? '<div class="mc-kanban-card-meta mc-kanban-card-when">' + mc2RelTime(item.ts) + '</div>' : '') +
      '</div>';
    }

    function mc2KanbanDiscoveryCard(initiative) {
      var id = String(initiative.id || '');
      var icon = mc2InitiativeDiscoveryIcon(initiative);
      var title = escapeHtml(String(initiative.title || 'Untitled discovery'));
      var confidence = Math.round((Number(initiative.confidence) || 0) * 100);
      return '<div class="mc-kanban-card mc-kanban-card-discovery" data-mc-kanban-kind="discovery" data-initiative-id="' + escapeHtml(id) + '" role="button" tabindex="0">' +
        '<div class="mc-kanban-card-title">' + icon + ' ' + title + '</div>' +
        '<div class="mc-kanban-card-meta"><span class="mc-kanban-card-tag discovery">Auto-promoted</span></div>' +
        '<div class="mc-kanban-card-meta">Confidence ' + escapeHtml(String(confidence)) + '%</div>' +
      '</div>';
    }

    function mc2KanbanProgressSubgoalCard(item) {
      var assigneeId = String(item.assignee || '').trim();
      var a = (agentMapData || []).find(function (x) { return String(x.id) === assigneeId; }) || { id: assigneeId || 'main' };
      return '<div class="mc-kanban-card mc-kanban-card-progress" data-mc-kanban-kind="subgoal"' +
        ' data-goal-id="' + escapeHtml(String(item.goalId || '')) + '"' +
        ' data-subgoal-id="' + escapeHtml(String(item.subgoalId || '')) + '"' +
        ' data-title="' + escapeHtml(String(item.title || '')) + '"' +
        ' data-agent-id="' + escapeHtml(assigneeId) + '">' +
        '<div class="mc-kanban-card-title">' + escapeHtml(String(item.title || 'In progress')) + '</div>' +
        (assigneeId
          ? '<div class="mc-kanban-card-meta mc-kanban-card-agent">' + mc2AvatarHtml(a) + '<span>' + escapeHtml(agentNameById(assigneeId)) + '</span></div>'
          : '') +
        (item.progress ? '<div class="mc-kanban-card-meta">' + escapeHtml(String(item.progress)) + '% complete</div>' : '') +
      '</div>';
    }

    function mc2MissionWaitSubtitle(goal, ts) {
      var mission = String(goal && (goal.title || goal.objective) || 'Mission').trim();
      var wait = mc2ShortWaitTime(ts || (goal && goal.updatedAt));
      return mission + ' · waiting ' + wait;
    }

    function mc2PushActionRequiredItem(items, item) {
      if (!item || !item.title) return;
      var key = [
        item.action || '',
        item.goalId || '',
        item.subgoalId || '',
        item.agentId || '',
        item.pendingId || '',
        item.initiativeId || '',
        item.title,
      ].join('|');
      for (var i = 0; i < items.length; i++) {
        var existing = items[i];
        var existingKey = [
          existing.action || '',
          existing.goalId || '',
          existing.subgoalId || '',
          existing.agentId || '',
          existing.pendingId || '',
          existing.initiativeId || '',
          existing.title,
        ].join('|');
        if (existingKey === key) return;
      }
      items.push(item);
    }

    function mc2CollectActionRequiredItems() {
      var items = [];
      var goals = Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : [];
      var allWork = typeof flattenMissionWorkItems === 'function' ? flattenMissionWorkItems() : [];

      allWork.forEach(function (it) {
        if (String(it.status || '').toLowerCase() !== 'blocked') return;
        var ts = Number(it.updatedAt) || 0;
        mc2PushActionRequiredItem(items, {
          kind: 'error',
          action: 'goal-input',
          goalId: String(it.goalId || ''),
          subgoalId: String(it.subgoalId || ''),
          title: String(it.title || 'Blocked task').trim(),
          subtitle: it.missionTitle
            ? (it.missionTitle + ' · waiting ' + mc2ShortWaitTime(ts))
            : ('Mission · waiting ' + mc2ShortWaitTime(ts)),
          ts: ts,
        });
      });

      goals.forEach(function (g) {
        var goalId = String(g.id || '');
        var ts = Number(g.updatedAt) || 0;
        var status = String(g.status || '').toLowerCase();
        var needsInput = String(g.needsUserInput || '').trim();
        var blockedSubs = typeof countBlockedSubgoalsForGoal === 'function' ? countBlockedSubgoalsForGoal(g) : 0;

        if (needsInput) {
          mc2PushActionRequiredItem(items, {
            kind: 'warning',
            action: 'goal-input',
            goalId: goalId,
            title: needsInput.slice(0, 96),
            subtitle: mc2MissionWaitSubtitle(g, ts),
            ts: ts,
          });
          return;
        }
        if (status === 'blocked') {
          mc2PushActionRequiredItem(items, {
            kind: 'error',
            action: 'goal-input',
            goalId: goalId,
            title: String(g.blockedReason || g.title || g.objective || 'Mission blocked').trim().slice(0, 96),
            subtitle: mc2MissionWaitSubtitle(g, ts),
            ts: ts,
          });
          return;
        }
        if (blockedSubs > 0) {
          mc2PushActionRequiredItem(items, {
            kind: 'error',
            action: 'goal-input',
            goalId: goalId,
            title: blockedSubs + ' blocked task' + (blockedSubs === 1 ? '' : 's') + ' need response',
            subtitle: mc2MissionWaitSubtitle(g, ts),
            ts: ts,
          });
          return;
        }
        if ((typeof isGoalPartialWait === 'function' && isGoalPartialWait(g)) ||
          (typeof goalNeedsAttention === 'function' && goalNeedsAttention(g))) {
          var reason = typeof goalImplementationBlockedLabel === 'function'
            ? goalImplementationBlockedLabel(g)
            : '';
          mc2PushActionRequiredItem(items, {
            kind: 'warning',
            action: 'goal-input',
            goalId: goalId,
            title: reason || String(g.title || g.objective || 'Mission needs input').trim().slice(0, 96),
            subtitle: mc2MissionWaitSubtitle(g, ts),
            ts: ts,
          });
        }
      });

      var initiatives = Array.isArray(teamInitiativesSnapshot.initiatives) ? teamInitiativesSnapshot.initiatives : [];
      initiatives.forEach(function (it) {
        if (!mc2InitiativeWasAutoPromoted(it)) return;
        var ts = Number(it.updatedAt) || 0;
        mc2PushActionRequiredItem(items, {
          kind: 'warning',
          action: 'initiative-review',
          initiativeId: String(it.id || ''),
          title: 'Review auto-promoted initiative',
          subtitle: String(it.title || 'Untitled initiative').trim().slice(0, 96),
          ts: ts,
        });
      });

      mc2PendingItems().forEach(function (p) {
        var pendingId = String(p.id || '');
        var ts = Number(p.createdAt) || 0;
        mc2PushActionRequiredItem(items, {
          kind: 'warning',
          action: 'pending',
          pendingId: pendingId,
          title: String(mc2PendingTitle(p) || 'Pending approval').trim().slice(0, 96),
          subtitle: 'Awaiting your approval · ' + mc2ShortWaitTime(ts),
          ts: ts,
        });
      });

      var agents = agentMapData || [];
      var ctxMap = teamAgentContextSnapshot.agents || {};
      agents.forEach(function (a) {
        var id = String(a.id || '');
        var ctx = ctxMap[id] || { state: 'idle' };
        var s = String(ctx.state || 'idle').toLowerCase();
        var lastTs = Number(ctx.updatedAt) || 0;
        if (s === 'error') {
          var reason = String(ctx.currentThought || ctx.lastAction || '').trim() || 'Agent blocked';
          mc2PushActionRequiredItem(items, {
            kind: 'error',
            action: 'agent',
            agentId: id,
            title: reason.slice(0, 96),
            subtitle: agentCardShortName(a) + ' · waiting ' + mc2ShortWaitTime(lastTs),
            ts: lastTs,
          });
        }
      });

      items.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      return items;
    }

    function mc2ActionRequiredItemAttrs(item) {
      var attrs = ' data-attention-action="' + escapeHtml(item.action || '') + '"';
      if (item.goalId) attrs += ' data-goal-id="' + escapeHtml(item.goalId) + '"';
      if (item.subgoalId) attrs += ' data-subgoal-id="' + escapeHtml(item.subgoalId) + '"';
      if (item.agentId) attrs += ' data-agent-id="' + escapeHtml(item.agentId) + '"';
      if (item.pendingId) attrs += ' data-pending-id="' + escapeHtml(item.pendingId) + '"';
      if (item.initiativeId) attrs += ' data-initiative-id="' + escapeHtml(item.initiativeId) + '"';
      return attrs;
    }

    function mc2RenderActionBanner() {
      var banner = mc2El('mc2-action-banner');
      var countEl = mc2El('mc2-action-banner-count');
      var itemsEl = mc2El('mc2-action-banner-items');
      if (!banner || !itemsEl) return;
      var items = mc2CollectActionRequiredItems();
      if (!items.length) {
        banner.hidden = true;
        itemsEl.innerHTML = '';
        if (countEl) countEl.textContent = '0';
        return;
      }
      banner.hidden = false;
      if (countEl) countEl.textContent = String(items.length);
      itemsEl.innerHTML = items.slice(0, 6).map(function (item) {
        return '<button type="button" class="mc-action-banner-item ' + escapeHtml(item.kind || 'warning') + '"' +
          mc2ActionRequiredItemAttrs(item) + '>' +
          '<span class="mc-action-banner-item-title">' + escapeHtml(item.title) + '</span>' +
          '<span class="mc-action-banner-item-sub">' + escapeHtml(item.subtitle || '') + '</span>' +
        '</button>';
      }).join('');
    }

    function mc2CollectKanbanAttentionItems() {
      return mc2CollectActionRequiredItems().slice(0, 8).map(function (item) {
        return {
          kind: item.kind,
          action: item.action,
          goalId: item.goalId,
          subgoalId: item.subgoalId,
          agentId: item.agentId,
          pendingId: item.pendingId,
          initiativeId: item.initiativeId,
          title: item.title,
          subtitle: item.subtitle,
          text: escapeHtml(item.title) + (item.subtitle ? ' — ' + escapeHtml(item.subtitle) : ''),
          ts: item.ts,
        };
      });
    }

    function mc2CollectKanbanCompletedItems() {
      var items = [];
      var allItems = typeof flattenMissionWorkItems === 'function' ? flattenMissionWorkItems() : [];
      allItems.forEach(function (it) {
        if (String(it.status || '').toLowerCase() !== 'done') return;
        items.push({
          kind: 'subgoal',
          title: it.title,
          goalId: it.goalId,
          subgoalId: it.subgoalId,
          assignee: it.assignee,
          delegatedFrom: it.delegatedFrom,
          ts: Number(it.updatedAt) || 0,
        });
      });
      if (typeof listCompletedTasks === 'function') {
        listCompletedTasks({ range: 'today' }).slice(0, 8).forEach(function (task) {
          items.push({
            kind: 'turn',
            title: typeof mc2TaskDisplayTitle === 'function' ? mc2TaskDisplayTitle(task) : String(task.prompt || task.summary || 'Completed task'),
            agentId: task.agentId,
            ts: Number(task.ts) || 0,
          });
        });
      }
      items.sort(function (a, b) { return (Number(b.ts) || 0) - (Number(a.ts) || 0); });
      var seen = {};
      return items.filter(function (it) {
        var key = String(it.kind || '') + '|' + String(it.subgoalId || it.title || '') + '|' + String(it.agentId || '');
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      }).slice(0, 8);
    }

    function mc2CollectKanbanProgressItems() {
      var agents = agentMapData || [];
      var ctxMap = teamAgentContextSnapshot.agents || {};
      var items = [];
      agents.forEach(function (a) {
        var id = String(a.id || '');
        var ctx = ctxMap[id] || { state: 'idle' };
        if (String(ctx.state || 'idle').toLowerCase() === 'working') {
          items.push({ kind: 'agent', a: a, ctx: ctx });
        }
      });
      var allItems = typeof flattenMissionWorkItems === 'function' ? flattenMissionWorkItems() : [];
      allItems.forEach(function (it) {
        if (String(it.status || '').toLowerCase() === 'doing') items.push({ kind: 'subgoal', item: it });
      });
      return items;
    }

    function mc2CollectKanbanDiscoveryItems() {
      var initiatives = Array.isArray(teamInitiativesSnapshot.initiatives) ? teamInitiativesSnapshot.initiatives.slice() : [];
      return initiatives.filter(function (it) {
        return mc2InitiativeWasAutoPromoted(it);
      }).sort(function (a, b) {
        return (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
      }).slice(0, 8);
    }

    function mc2WireKanbanCol(col) {
      if (!col) return;
      col.querySelectorAll('.mc-kanban-card[data-mc-agent]').forEach(function (card) {
        card.addEventListener('click', function (e) {
          var ctxLink = e.target && e.target.closest ? e.target.closest('[data-mc-open-context]') : null;
          if (ctxLink) {
            e.preventDefault();
            e.stopPropagation();
            mc2OpenTaskDetailForAgent(ctxLink.getAttribute('data-mc-agent') || card.getAttribute('data-mc-agent') || '');
            return;
          }
          var aid = card.getAttribute('data-mc-agent');
          if (aid) mc2OpenTaskDetailForAgent(aid);
        });
      });
      col.querySelectorAll('.mc-kanban-card[data-mc-kanban-kind="attention"]').forEach(function (card) {
        card.addEventListener('click', function () {
          mc2HandleAttentionClick(card);
        });
      });
      col.querySelectorAll('.mc-kanban-card[data-mc-kanban-kind="subgoal"]').forEach(function (card) {
        card.addEventListener('click', function () {
          if (typeof mc2ShowMissionTaskDetails === 'function') mc2ShowMissionTaskDetails(card);
        });
      });
      col.querySelectorAll('.mc-kanban-card[data-mc-kanban-kind="discovery"]').forEach(function (card) {
        card.addEventListener('click', function () {
          var initiativeId = card.getAttribute('data-initiative-id') || '';
          if (initiativeId) mc2OpenTaskForInitiative(initiativeId);
        });
      });
      col.querySelectorAll('.mc-kanban-card.mc-kanban-card-completed').forEach(function (card) {
        card.addEventListener('click', function () {
          if (typeof mc2ShowMissionTaskDetails === 'function') {
            mc2ShowMissionTaskDetails(card);
            return;
          }
          var aid = card.getAttribute('data-mc-agent');
          if (aid) mc2OpenTaskDetailForAgent(aid);
        });
      });
    }

    function mc2RenderKanbanCol(colId, countId, html, emptyMsg) {
      var col = mc2El(colId);
      var count = mc2El(countId);
      if (!col) return;
      var itemCount = html ? (html.match(/mc-kanban-card/g) || []).length : 0;
      if (count) count.textContent = itemCount;
      if (!itemCount) {
        col.innerHTML = '<p class="mc-kanban-empty">' + emptyMsg + '</p>';
        return;
      }
      col.innerHTML = html;
      mc2WireKanbanCol(col);
    }

    function mc2RenderKanban() {
      var attention = mc2CollectKanbanAttentionItems();
      var completed = mc2CollectKanbanCompletedItems();
      var progress = mc2CollectKanbanProgressItems();
      var discoveries = mc2CollectKanbanDiscoveryItems();

      mc2RenderKanbanCol(
        'mc2-col-attention',
        'mc2-col-count-attention',
        attention.map(mc2KanbanAttentionCard).join(''),
        'All clear'
      );
      mc2RenderKanbanCol(
        'mc2-col-completed',
        'mc2-col-count-completed',
        completed.map(mc2KanbanCompletedCard).join(''),
        'Nothing completed yet'
      );
      mc2RenderKanbanCol(
        'mc2-col-progress',
        'mc2-col-count-progress',
        progress.map(function (entry) {
          if (entry.kind === 'agent') return mc2KanbanCard(entry.a, entry.ctx);
          return mc2KanbanProgressSubgoalCard(entry.item);
        }).join(''),
        'No active work'
      );
      mc2RenderKanbanCol(
        'mc2-col-discoveries',
        'mc2-col-count-discoveries',
        discoveries.map(mc2KanbanDiscoveryCard).join(''),
        'No discoveries yet'
      );
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
          var lastTask = typeof buildAgentLastTaskSummary === 'function'
            ? buildAgentLastTaskSummary(id)
            : { lines: ['None'], ts: 0 };
          var lastTaskLines = Array.isArray(lastTask.lines) && lastTask.lines.length ? lastTask.lines : ['None'];
          var lastTaskHtml = lastTaskLines.map(function (line) {
            return '<div class="mc-agent-overview-last-task-line">' + escapeHtml(line) + '</div>';
          }).join('');
          var active = agentCardActiveCount(ctx, metrics);
          var done = Number(metrics.totalHandled || 0);
          var waitingCount = s === 'waiting' ? 1 : 0;
          return '<div class="mc-agent-overview-card" data-mc-agent="' + escapeHtml(id) + '">' +
            '<div class="mc-kanban-card-head">' +
              mc2AvatarHtml(a) +
              '<span class="mc-agent-role">' + name + '</span>' +
              '<span class="mc-agent-state-dot ' + escapeHtml(s) + '" aria-label="' + escapeHtml(s) + '"></span>' +
            '</div>' +
            '<div class="mc-agent-overview-last-task">' +
              '<div class="mc-agent-overview-last-task-label">Last task:</div>' +
              '<div class="mc-agent-overview-last-task-lines">' + lastTaskHtml + '</div>' +
            '</div>' +
            '<div class="mc-agent-overview-stats">' +
              '<span class="active">' + active + ' Active</span>' +
              '<span>' + done + ' Done</span>' +
              (waitingCount ? '<span class="waiting">' + waitingCount + ' Waiting</span>' : '') +
            '</div>' +
          '</div>';
        }).join('');
        el.querySelectorAll('.mc-agent-overview-card[data-mc-agent]').forEach(function (card) {
          card.addEventListener('click', function () {
            var aid = card.getAttribute('data-mc-agent');
            if (aid) mc2OpenTaskDetailForAgent(aid);
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
      var displayTitle = mc2TaskDisplayTitle(task);
      var title = escapeHtml(displayTitle);
      var when = mc2RelTime(Number(task.ts) || Date.now());
      var skills = Number(task.skillCount) || 0;
      var skillsLabel = skills ? (skills + ' skill' + (skills === 1 ? '' : 's')) : 'No tools';
      return '<div class="mc-task-card" data-mc-turn-task="1" data-mc-task-agent="' + escapeHtml(agentId) + '"' +
        ' data-turn-ts="' + escapeHtml(String(task.ts || '')) + '"' +
        ' data-title="' + escapeHtml(displayTitle) + '" data-ts="' + escapeHtml(String(task.ts || '')) + '">' +
        '<div class="mc-task-card-title">' + title + '</div>' +
        '<div class="mc-task-card-meta">' +
          '<span class="mc-task-card-agent">' + mc2AvatarHtml(a) + '<span>' + name + '</span></span>' +
          '<span class="done-tag">Done</span>' +
          '<span>' + escapeHtml(when) + '</span>' +
          '<span>' + escapeHtml(skillsLabel) + '</span>' +
        '</div>' +
      '</div>';
    }

    function mc2MissionTaskStatusLabel(status) {
      var s = String(status || 'todo').toLowerCase();
      if (s === 'blocked') return 'blocked';
      if (s === 'doing') return 'in progress';
      if (s === 'done') return 'done';
      return 'open';
    }

    function mc2MissionTaskCard(item) {
      var status = String(item.status || 'todo').toLowerCase();
      var assigneeId = String(item.assignee || item.agentId || '').trim();
      var a = (agentMapData || []).find(function (x) { return String(x.id) === assigneeId; }) || { id: assigneeId || 'main' };
      var agentHtml = assigneeId
        ? '<span class="mc-task-card-agent">' + mc2AvatarHtml(a) + '<span>' + escapeHtml(agentNameById(assigneeId)) + '</span></span>'
        : '';
      var missionLine = item.missionTitle && item.kind !== 'goal'
        ? '<span class="mc-task-card-mission">' + escapeHtml(item.missionTitle) + '</span>'
        : '';
      var initiativeLine = item.fromInitiative
        ? '<span class="mc-task-card-initiative">From initiative</span>'
        : '';
      var delegatedLine = item.delegatedFrom
        ? '<span class="mc-task-card-delegation">Assigned by ' + escapeHtml(agentNameById(item.delegatedFrom) || item.delegatedFrom) + '</span>'
        : '';
      var pathLine = item.path && item.kind === 'subgoal'
        ? '<div class="mc-task-card-path">' + escapeHtml(item.path) + '</div>'
        : '';
      var desc = String(item.description || '').trim();
      var descHtml = desc ? '<p class="mc-task-card-desc">' + escapeHtml(desc.slice(0, 220)) + '</p>' : '';
      var progress = Number(item.progress);
      var progressLabel = isFinite(progress) && progress > 0 ? (progress + '%') : '';
      var goalId = String(item.goalId || '');
      var subgoalId = String(item.subgoalId || '');
      var selected = mc2SelectedTask &&
        String(mc2SelectedTask.subgoalId || '') === subgoalId &&
        String(mc2SelectedTask.goalId || '') === goalId;
      var actionsHtml = '';
      if (item.kind === 'subgoal' && goalId && subgoalId && typeof missionTaskActionButtonsHtml === 'function') {
        actionsHtml = missionTaskActionButtonsHtml(goalId, subgoalId, status, {
          fromInitiative: !!item.fromInitiative,
        });
      } else if (status === 'blocked' && goalId && typeof goalNeedsAttention === 'function') {
        actionsHtml = '<div class="mc-task-card-actions">' +
          '<button type="button" class="mc-task-card-btn primary" data-mc-task-action="respond"' +
            ' data-goal-id="' + escapeHtml(goalId) + '">Respond</button>' +
        '</div>';
      }
      return '<div class="mc-task-card mc-mission-task-card' + (selected ? ' mc-task-card-selected' : '') + '" data-mc-mission-task="1"' +
        ' data-goal-id="' + escapeHtml(goalId) + '"' +
        ' data-subgoal-id="' + escapeHtml(subgoalId) + '"' +
        ' data-agent-id="' + escapeHtml(String(item.agentId || assigneeId || '')) + '"' +
        ' data-status="' + escapeHtml(status) + '"' +
        ' data-title="' + escapeHtml(String(item.title || '')) + '">' +
        '<div class="mc-task-card-title">' + escapeHtml(item.title || 'Untitled') + '</div>' +
        pathLine +
        descHtml +
        '<div class="mc-task-card-meta">' +
          '<span class="team-goal-subgoal-status ' + escapeHtml(status) + '">' + escapeHtml(mc2MissionTaskStatusLabel(status)) + '</span>' +
          agentHtml +
          missionLine +
          initiativeLine +
          delegatedLine +
          (progressLabel ? '<span>' + escapeHtml(progressLabel) + '</span>' : '') +
        '</div>' +
        actionsHtml +
      '</div>';
    }

    function mc2MissionTasksSection(title, items) {
      if (!items.length) return '';
      return '<section class="mc-tasks-section">' +
        '<h4 class="mc-tasks-section-title">' + escapeHtml(title) + ' <span class="mc-tasks-section-count">' + items.length + '</span></h4>' +
        '<div class="mc-tasks-section-body">' + items.map(mc2MissionTaskCard).join('') + '</div>' +
      '</section>';
    }

    function mc2FilterMissionItems(items) {
      if (!mc2TasksAgentFilter) return items;
      return items.filter(function (it) {
        var aid = String(it.assignee || it.agentId || '').trim();
        return aid === mc2TasksAgentFilter;
      });
    }

    function mc2MissionTaskItemFromEl(el) {
      if (!el) return null;
      return {
        kind: 'subgoal',
        goalId: String(el.getAttribute('data-goal-id') || ''),
        subgoalId: String(el.getAttribute('data-subgoal-id') || ''),
        title: String(el.getAttribute('data-title') || '').trim(),
        agentId: String(el.getAttribute('data-agent-id') || ''),
        status: String(el.getAttribute('data-status') || 'blocked'),
      };
    }

    function mc2ShowMissionTaskDetails(card) {
      if (!card) return;
      var item = typeof mc2ResolveTaskFromCard === 'function' ? mc2ResolveTaskFromCard(card) : null;
      if (!item) {
        item = typeof mc2MissionTaskItemFromEl === 'function' ? mc2MissionTaskItemFromEl(card) : null;
        if (item && item.goalId && typeof findMissionTaskItem === 'function') {
          item = findMissionTaskItem({
            goalId: item.goalId,
            subgoalId: item.subgoalId,
            title: item.title,
            agentId: item.agentId,
          }) || item;
        }
      }
      if (item) {
        mc2OpenTaskDetail(item, { filter: item.status === 'blocked' ? 'blocked' : 'all' });
        return;
      }
      var goalId = card.getAttribute('data-goal-id');
      if (goalId) {
        mc2OpenTaskDetail(null, { goalId: goalId, filter: 'all' });
      }
    }

    function mc2WireMissionTaskCards(root) {
      if (!root) return;
      if (typeof wireMissionTaskActions === 'function') wireMissionTaskActions(root);
      root.querySelectorAll('.mc-mission-task-card[data-mc-mission-task]').forEach(function (card) {
        if (card._wiredCard) return;
        card._wiredCard = true;
        card.addEventListener('click', function (e) {
          if (e.target && e.target.closest && e.target.closest('[data-mc-task-action]')) return;
          var agentId = card.getAttribute('data-agent-id');
          var goalId = card.getAttribute('data-goal-id');
          if (goalId || (agentId && card.getAttribute('data-mc-mission-task'))) {
            mc2ShowMissionTaskDetails(card);
            return;
          }
          if (agentId) mc2OpenTaskDetailForAgent(agentId);
        });
      });
    }

    function mc2RenderTasks() {
      var el = mc2El('mc2-tasks-list');
      if (!el) return;
      mc2SyncAgentFilterControls();
      mc2SetTasksFilter(mc2TasksFilter);
      var titleEl = mc2El('mc2-tasks-title');
      var allItems = typeof flattenMissionWorkItems === 'function' ? flattenMissionWorkItems() : [];
      var groups = typeof groupMissionWorkItems === 'function'
        ? groupMissionWorkItems(mc2FilterMissionItems(allItems))
        : { blocked: [], doing: [], todo: [], done: [] };
      var openCount = groups.todo.length + groups.doing.length;
      var html = '';
      var filter = mc2TasksFilter;

      if (filter === 'all' || filter === 'blocked' || filter === 'open') {
        if (titleEl) {
          titleEl.textContent = filter === 'blocked'
            ? 'BLOCKED — ' + groups.blocked.length
            : (filter === 'open' ? 'OPEN & IN PROGRESS — ' + openCount : 'MISSION TASKS');
        }
        if (filter === 'all') {
          html += mc2MissionTasksSection('Blocked', groups.blocked);
          html += mc2MissionTasksSection('In progress', groups.doing);
          html += mc2MissionTasksSection('Open', groups.todo);
        } else if (filter === 'blocked') {
          html += groups.blocked.length
            ? mc2MissionTasksSection('Blocked', groups.blocked)
            : '<p class="mc-kanban-empty">No blocked mission tasks right now.</p>';
        } else {
          html += mc2MissionTasksSection('In progress', groups.doing);
          html += mc2MissionTasksSection('Open', groups.todo);
          if (!groups.doing.length && !groups.todo.length) {
            html = '<p class="mc-kanban-empty">No open mission tasks.</p>';
          }
        }
      }

      if (filter === 'all' || filter === 'done') {
        var range = teamAgentPanelRange || 'today';
        var rangeLabel = teamAgentRangeLabel(range);
        var tasks = listCompletedTasks({ range: range, agentId: mc2TasksAgentFilter });
        if (filter === 'done' && titleEl) {
          titleEl.textContent = 'COMPLETED — ' + rangeLabel.toUpperCase() + ' (' + tasks.length + ')';
        }
        html += '<section class="mc-tasks-section mc-tasks-section-done">' +
          '<h4 class="mc-tasks-section-title">Completed <span class="mc-tasks-section-count">' + tasks.length + '</span>' +
          (filter === 'all' ? ' <span class="mc-tasks-section-sub">' + escapeHtml(rangeLabel) + '</span>' : '') +
          '</h4>' +
          '<div class="mc-tasks-section-body">';
        if (!tasks.length) {
          html += '<p class="mc-kanban-empty">No completed agent turns for this range.</p>';
        } else {
          mc2TimelineSpyEnabled = filter === 'done';
          html += tasks.map(mc2TaskCard).join('');
        }
        html += '</div></section>';
      } else {
        mc2TimelineSpyEnabled = false;
      }

      if (!html) html = '<p class="mc-kanban-empty">No mission tasks yet.</p>';
      el.innerHTML = html;
      mc2WireMissionTaskCards(el);
      el.querySelectorAll('.mc-task-card[data-mc-turn-task]').forEach(function (card) {
        if (card._wiredTurnDetail) return;
        card._wiredTurnDetail = true;
        card.addEventListener('click', function (e) {
          if (e.target && e.target.closest && e.target.closest('[data-mc-task-action]')) return;
          var item = typeof mc2ResolveTaskFromCard === 'function' ? mc2ResolveTaskFromCard(card) : null;
          if (item) {
            mc2OpenTaskDetail(item, { filter: 'done' });
            return;
          }
          var aid = card.getAttribute('data-mc-task-agent');
          var turnTs = Number(card.getAttribute('data-turn-ts') || 0);
          if (turnTs && aid) {
            mc2OpenTaskDetail(null, { agentId: aid, turnTs: turnTs, filter: 'done' });
            return;
          }
          if (aid) mc2OpenTaskDetailForAgent(aid);
        });
      });
      el.querySelectorAll('.mc-task-card[data-mc-task-agent]:not([data-mc-mission-task]):not([data-mc-turn-task])').forEach(function (card) {
        if (card._wiredTurn) return;
        card._wiredTurn = true;
        card.addEventListener('click', function () {
          var aid = card.getAttribute('data-mc-task-agent');
          if (aid) mc2OpenTaskDetailForAgent(aid);
        });
      });
      if (filter === 'blocked' && groups.blocked.length) {
        var firstBlocked = el.querySelector('.mc-mission-task-card[data-status="blocked"]');
        if (firstBlocked) {
          try { firstBlocked.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {}
          if (typeof highlightBlockedTarget === 'function') highlightBlockedTarget(firstBlocked);
        }
      }
      mc2SyncTimelineHighlightForScroll();
    }

    function mc2RenderMovement() {
      var el = mc2El('mc2-recent-movement');
      if (!el) return;
      var groups = typeof buildMissionControlMovementGroups === 'function'
        ? buildMissionControlMovementGroups(10)
        : groupTeamActivityEvents((teamActivityEvents || []).slice(-80)).slice(0, 8);
      if (!groups.length) { el.innerHTML = '<p class="mc-kanban-empty">No activity yet.</p>'; return; }
      el.innerHTML = groups.map(function (group) {
        return renderTeamActivityGroupRow(group, { timeHtml: mc2RelTime(group.ts) });
      }).join('');
      mc2SyncTimelineHighlightForScroll();
    }

    function mc2RenderAttention() {
      var el = mc2El('mc2-attention');
      if (!el) return;
      var items = mc2CollectActionRequiredItems();
      if (!items.length) { el.innerHTML = '<p class="mc-kanban-empty">All clear.</p>'; return; }
      el.innerHTML = items.slice(0, 6).map(function (item) {
        var icon = item.kind === 'error' ? '🔴' : '→';
        var attrs = ' type="button" class="mc-attention-item mc-attention-item-structured ' + item.kind + '" data-attention-action="' + escapeHtml(item.action || '') + '"';
        if (item.goalId) attrs += ' data-goal-id="' + escapeHtml(item.goalId) + '"';
        if (item.subgoalId) attrs += ' data-subgoal-id="' + escapeHtml(item.subgoalId) + '"';
        if (item.agentId) attrs += ' data-agent-id="' + escapeHtml(item.agentId) + '"';
        if (item.pendingId) attrs += ' data-pending-id="' + escapeHtml(item.pendingId) + '"';
        if (item.initiativeId) attrs += ' data-initiative-id="' + escapeHtml(item.initiativeId) + '"';
        return '<button' + attrs + '>' +
          '<span class="mc-attention-icon">' + icon + '</span>' +
          '<span class="mc-attention-copy">' +
            '<span class="mc-attention-title">' + escapeHtml(item.title) + '</span>' +
            (item.subtitle ? '<span class="mc-attention-sub">' + escapeHtml(item.subtitle) + '</span>' : '') +
          '</span>' +
        '</button>';
      }).join('');
    }

    function mc2GoalById(goalId) {
      var id = String(goalId || '').trim();
      if (!id) return null;
      return (Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : []).find(function (g) {
        return String(g.id || '') === id;
      }) || null;
    }

    function mc2HandleAttentionClick(btn) {
      if (!btn) return;
      var action = String(btn.getAttribute('data-attention-action') || '').trim();
      if (action === 'goal-input') {
        var goalId = btn.getAttribute('data-goal-id') || '';
        var subgoalId = btn.getAttribute('data-subgoal-id') || '';
        if (subgoalId && typeof findMissionTaskItem === 'function') {
          var directTask = findMissionTaskItem({ goalId: goalId, subgoalId: subgoalId });
          if (directTask) {
            mc2OpenTaskDetail(directTask, { filter: 'blocked' });
            return;
          }
        }
        var blocked = typeof findBlockedWorkRefs === 'function' ? findBlockedWorkRefs() : [];
        var ref = null;
        var i;
        for (i = 0; i < blocked.length; i++) {
          if (blocked[i].goalId === goalId && blocked[i].kind === 'subgoal') {
            ref = blocked[i];
            break;
          }
        }
        if (ref && typeof findMissionTaskItem === 'function') {
          var taskItem = findMissionTaskItem({
            goalId: ref.goalId,
            subgoalId: ref.subgoalId,
            title: ref.title,
          });
          if (taskItem) {
            mc2OpenTaskDetail(taskItem, { filter: 'blocked' });
            return;
          }
        }
        var goal = mc2GoalById(goalId);
        if (goal && typeof openTeamUserInputModal === 'function') {
          openTeamUserInputModal(goal);
          return;
        }
        mc2OpenTasksView('blocked');
        return;
      }
      if (action === 'goal') {
        mc2OpenTasksView('all');
        return;
      }
      if (action === 'blocked-tasks') {
        mc2OpenTasksView('blocked');
        return;
      }
      if (action === 'agent') {
        mc2OpenTaskDetailForAgent(btn.getAttribute('data-agent-id') || '');
        return;
      }
      if (action === 'initiative-review') {
        var initiativeId = btn.getAttribute('data-initiative-id') || '';
        if (initiativeId) mc2OpenTaskForInitiative(initiativeId);
        return;
      }
      if (action === 'pending') {
        var pendingId = String(btn.getAttribute('data-pending-id') || '').trim();
        mc2SetView('tasks');
        if (!pendingId) return;
        setTimeout(function () {
          var cards = document.querySelectorAll('.mc-pending-card[data-pending-id]');
          var card = null;
          for (var i = 0; i < cards.length; i++) {
            if (String(cards[i].getAttribute('data-pending-id') || '') === pendingId) {
              card = cards[i];
              break;
            }
          }
          if (card) {
            try { card.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {}
          }
        }, 120);
      }
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
      var aid = String(agentId || '').trim();
      if (nextView === 'context') {
        mc2OpenTaskDetailForAgent(aid);
        return;
      }
      mc2InboxAgentFilter = aid;
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
      var blockedRef = typeof findFirstBlockedWorkRef === 'function' ? findFirstBlockedWorkRef() : null;
      var detailGoal = null;
      if (blockedRef && blockedRef.goalId) {
        detailGoal = goals.find(function (g) { return String(g.id || '') === blockedRef.goalId; }) || null;
      }
      if (!detailGoal && typeof getCurrentMissionGoal === 'function') {
        detailGoal = getCurrentMissionGoal();
      }
      if (!detailGoal && selectedTeamGoalId) {
        detailGoal = goals.find(function (g) { return String(g.id || '') === selectedTeamGoalId; }) || null;
      }
      if (!detailGoal && goals.length) detailGoal = goals[0];
      if (detailGoal) selectedTeamGoalId = String(detailGoal.id || '');
      if (typeof renderGoalDetail === 'function') {
        renderGoalDetail(detailGoal, mc2El('mc2-goal-detail'));
      }
      el.innerHTML = goals.map(function (g) {
        var id = String(g.id || '');
        var status = String(g.status || 'active').toLowerCase();
        var pct = Math.max(0, Math.min(100, Math.round(Number((g.progress && g.progress.pct) || 0))));
        var subs = Array.isArray(g.subgoals) ? g.subgoals : [];
        var doneSubs = subs.filter(function (s) { return String(s.status || '').toLowerCase() === 'done'; }).length;
        var selected = id === selectedTeamGoalId ? ' selected' : '';
        var projectName = mc2ProjectNameById(g.projectId);
        var projectLine = projectName
          ? '<div class="mc-progress-meta">Project: <button type="button" class="mc-panel-link" data-mc-nav="projects" data-project-id="' + escapeHtml(String(g.projectId || '')) + '">' + escapeHtml(projectName) + '</button></div>'
          : '';
        var toggleLabel = status === 'active' ? 'Pause' : (status === 'paused' ? 'Resume' : 'Activate');
        return '<div class="mc-progress-card mc-mission-select-card' + selected + '" data-goal-id="' + escapeHtml(id) + '" style="cursor:pointer;">' +
          '<div class="mc-progress-head">' +
            '<h3>' + escapeHtml(String(g.title || g.objective || 'Untitled mission')) + '</h3>' +
            '<span class="team-goal-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' +
          '</div>' +
          '<div class="mc-progress-bar"><span style="width:' + pct + '%"></span></div>' +
          '<div class="mc-progress-meta">' + pct + '% · Owner: ' + escapeHtml(goalOwnerLabel(g)) +
            (subs.length ? ' · ' + doneSubs + '/' + subs.length + ' tasks' : '') + '</div>' +
          projectLine +
          '<div class="team-initiative-actions" style="margin-top:0.35rem;">' +
            '<button type="button" class="secondary mc-mission-card-btn" data-mc-goal-action="run" data-goal-id="' + escapeHtml(id) + '">Run</button>' +
            '<button type="button" class="secondary mc-mission-card-btn" data-mc-goal-action="toggle" data-goal-id="' + escapeHtml(id) + '">' + escapeHtml(toggleLabel) + '</button>' +
          '</div>' +
        '</div>';
      }).join('');
      el.querySelectorAll('.mc-mission-select-card[data-goal-id]').forEach(function (card) {
        if (card._wiredSelect) return;
        card._wiredSelect = true;
        card.addEventListener('click', function (e) {
          if (e.target && e.target.closest && e.target.closest('[data-mc-goal-action], [data-mc-nav], .mc-panel-link')) return;
          var gid = card.getAttribute('data-goal-id') || '';
          if (!gid) return;
          selectedTeamGoalId = gid;
          mc2RenderGoals();
        });
      });
      el.querySelectorAll('[data-mc-goal-action]').forEach(function (btn) {
        if (btn._wiredMissionGoal) return;
        btn._wiredMissionGoal = true;
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (typeof runMissionGoalAction === 'function') {
            runMissionGoalAction(btn.getAttribute('data-goal-id'), btn.getAttribute('data-mc-goal-action'));
          }
        });
      });
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
      if (typeof renderInitiativesPanels === 'function') renderInitiativesPanels();
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
      mc2RenderActionBanner();
      mc2RenderPendingInline('mc2-goals-pending', 'mission_plan');
      mc2RenderPendingInline('mc2-tasks-pending', 'mission_plan');
      if (!(typeof shouldPauseTeamDashboardRefresh === 'function' && shouldPauseTeamDashboardRefresh())) {
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
        await fetchGoalsSnapshot();
        await fetchInitiativesSnapshot();
        if (window.cowCodeProjectsApi && typeof window.cowCodeProjectsApi.listProjects === 'function') {
          try {
            mc2ProjectsSnapshot = await window.cowCodeProjectsApi.listProjects();
          } catch (_) {}
        }
        if (mc2ActiveView === 'projects') mc2RenderProjects();
        if (mc2ActiveView === 'goals') mc2RenderGoals();
        if (mc2ActiveView === 'tasks') {
          mc2RenderTasks();
          mc2RenderTaskDetail();
        }
        renderMissionControl();
      } catch (err) {
        alert(err && err.message ? err.message : String(err));
      } finally {
        mc2PendingActionBusy = false;
        document.querySelectorAll('.mc-pending-btn').forEach(function (btn) { btn.disabled = false; });
      }
    }

    function renderMissionControl() {
      if (typeof shouldPauseTeamDashboardRefresh === 'function' && shouldPauseTeamDashboardRefresh()) return;
      try {
        mc2RenderMissionProgress();
        mc2RenderActionBanner();
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
        if (mc2ActiveView === 'tasks') {
          mc2RenderTasks();
          mc2RenderTaskDetail();
        }
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
      var goalId = row.getAttribute('data-goal-id') || '';
      var subgoalId = row.getAttribute('data-subgoal-id') || '';
      var initiativeId = row.getAttribute('data-initiative-id') || '';
      var agentId = row.getAttribute('data-agent-id') || '';
      var item = typeof findMissionTaskItem === 'function'
        ? findMissionTaskItem({ goalId: goalId, subgoalId: subgoalId, agentId: agentId })
        : null;
      if (!item && initiativeId) {
        item = typeof findMissionTaskItem === 'function'
          ? findMissionTaskItem({ subgoalId: 'init-' + initiativeId, goalId: goalId })
          : null;
      }
      if (item) {
        mc2OpenTaskDetail(item, { filter: 'all' });
        return;
      }
      if (initiativeId) {
        mc2OpenTaskForInitiative(initiativeId);
        return;
      }
      if (goalId) {
        mc2OpenTaskDetail(null, { goalId: goalId, subgoalId: subgoalId, filter: 'all' });
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
          mc2OpenTaskDetailForAgent(contextLink.getAttribute('data-mc-agent') || '');
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
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && drawer.classList.contains('open')) mc2CloseTaskDrawer();
      });
    })();
