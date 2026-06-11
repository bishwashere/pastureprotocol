/* MC2 shared state, task drawer helpers, kanban card builders */
/* ── Mission Control (#team) ─────────────────────────────────────────── */

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
    var mc2TasksFilter = 'all';
    var mc2SelectedTask = null;
    var mc2AgentsSubView = 'overview';

    function mc2El(id) { return document.getElementById(id); }

    function mc2MatchesSelectedMission(missionId) {
      if (!selectedTeamMissionId) return true;
      return String(missionId || '') === selectedTeamMissionId;
    }

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
      var taskId = String(item.taskId || '');
      if (!taskId) return;
      var safeId = String(taskId).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      var card = document.querySelector(
        '#page-team .mc-mission-task-card[data-task-id="' + safeId + '"]'
      );
      if (card) {
        document.querySelectorAll('#page-team .mc-mission-task-card').forEach(function (c) {
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
      var body = mc2El('mc2-task-drawer-body');
      if (body) body.scrollTop = 0;
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

    function mc2RenderMissionTaskInactionHtml(inactionImpact) {
      if (!inactionImpact || !inactionImpact.lines || !inactionImpact.lines.length) return '';
      var kind = String(inactionImpact.impactKind || 'low');
      return '<section class="mc-task-inaction mc-task-inaction-' + escapeHtml(kind) + '">' +
        '<p class="mc-section-title" style="margin:0.55rem 0 0.35rem;">If you do nothing</p>' +
        '<dl class="mc-task-detail-fields mc-task-inaction-fields">' +
          inactionImpact.lines.map(function (row) {
            var valueClass = '';
            if (row.label === 'Required?' && row.value === 'Yes') valueClass = ' mc-task-inaction-required-yes';
            if (row.label === 'Impact' && String(row.value).toLowerCase() === 'high') valueClass = ' mc-task-inaction-impact-high';
            return '<dt>' + escapeHtml(row.label) + '</dt><dd class="' + valueClass + '">' + escapeHtml(row.value) + '</dd>';
          }).join('') +
        '</dl>' +
      '</section>';
    }

    function mc2RenderMissionTaskSourceChainHtml(sourceChain) {
      if (!sourceChain || !sourceChain.source) return '';
      var rows = [
        sourceChain.createdBy ? { label: 'Created by', value: sourceChain.createdBy } : null,
        sourceChain.agent ? { label: 'Agent', value: sourceChain.agent } : null,
        { label: 'Source', value: sourceChain.source },
        sourceChain.confidence != null && sourceChain.confidence > 0
          ? { label: 'Confidence', value: String(sourceChain.confidence) + '%' }
          : null,
        sourceChain.suggestedTaskTitle
          ? { label: 'SuggestedTask', value: sourceChain.suggestedTaskTitle }
          : null,
      ].filter(Boolean);
      if (!rows.length) return '';
      return '<section class="mc-task-source-chain">' +
        '<p class="mc-section-title" style="margin:0.55rem 0 0.35rem;">Source Chain</p>' +
        '<dl class="mc-task-detail-fields mc-task-source-chain-fields">' +
          rows.map(function (row) {
            return '<dt>' + escapeHtml(row.label) + '</dt><dd>' + escapeHtml(row.value) + '</dd>';
          }).join('') +
        '</dl>' +
      '</section>';
    }

    function mc2RenderAgentStatsForTaskMenu(agentId) {
      var aid = String(agentId || '').trim();
      if (!aid || typeof renderAgentMetricsCard !== 'function') return '';
      var metrics = (teamAgentMetricsSnapshot.agents || {})[aid] || null;
      return '<section class="mc-task-agent-stats">' +
        '<p class="mc-section-title" style="margin:0.65rem 0 0.35rem;">Agent report</p>' +
        renderAgentMetricsCard(aid, metrics) +
      '</section>';
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
      var agentStatsHtml = mc2RenderAgentStatsForTaskMenu(assignee);
      var sourceChain = item.sourceChain || null;
      var inactionImpact = item.inactionImpact || null;
      var reason = String(item.reason || '').trim();
      var skills = Array.isArray(item.skillsUsed) ? item.skillsUsed : [];
      var skillsLabel = skills.length ? skills.join(', ') : '—';
      var actionsHtml = typeof missionTaskActionButtonsHtml === 'function'
        ? missionTaskActionButtonsHtml(item.missionId, item.taskId, status, {
          fromSuggestedTask: !!item.fromSuggestedTask,
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
      var expectedOutput = String(item.expectedOutput || '').trim();
      var description = String(item.description || '').trim();
      var mainAsk = String(item.mainAsk || item.prompt || '').trim();
      var missionObjective = String(item.missionObjective || '').trim();
      var taskType = String(item.type || '').trim();
      var priority = Number(item.priority) || 0;
      var routeReason = String(item.routeReason || '').trim();
      var reviewNotes = String(item.reviewNotes || '').trim();
      var dependsOn = Array.isArray(item.dependsOn) ? item.dependsOn.filter(Boolean) : [];
      var missionHistory = Array.isArray(item.missionHistory) ? item.missionHistory : [];
      var missionProgress = item.missionProgress || null;
      var fields = [
        { label: 'Status', value: statusLabel },
        mission ? { label: 'Mission', value: mission } : null,
        missionObjective && missionObjective !== mission ? { label: 'Objective', value: missionObjective } : null,
        assignee ? { label: 'Assigned To', value: agentNameById(assignee) } : null,
        taskType ? { label: 'Type', value: taskType } : null,
        priority ? { label: 'Priority', value: 'P' + priority } : null,
        expectedOutput ? { label: 'Expected Output', value: expectedOutput } : null,
        item.dueAt ? { label: 'Due', value: mc2FormatTaskTimestamp(item.dueAt) } : null,
        dependsOn.length ? { label: 'Depends On', value: dependsOn.join(', ') } : null,
        item.createdAt ? { label: 'Created', value: mc2FormatTaskTimestamp(item.createdAt) } : null,
        item.startedAt ? { label: 'Started', value: mc2FormatTaskTimestamp(item.startedAt) } : null,
        item.completedAt && status === 'done' ? { label: 'Completed', value: mc2FormatTaskTimestamp(item.completedAt) } : null,
        { label: 'Skills Used', value: skillsLabel },
        routeReason ? { label: 'Route Reason', value: routeReason } : null,
      ].filter(Boolean);
      var fieldsHtml = '<dl class="mc-task-detail-fields">' + fields.map(function (row) {
        return '<dt>' + escapeHtml(row.label) + '</dt><dd>' + escapeHtml(row.value) + '</dd>';
      }).join('') + '</dl>';
      var sourceChainHtml = mc2RenderMissionTaskSourceChainHtml(sourceChain);
      var inactionHtml = mc2RenderMissionTaskInactionHtml(inactionImpact);

      var mainAskHtml = '';
      if (mainAsk) {
        mainAskHtml = '<div class="mc-task-detail-section">' +
          '<p class="mc-section-title" style="margin:0.55rem 0 0.35rem;">Main Ask / Prompt</p>' +
          '<div class="mc-task-detail-block">' + escapeHtml(mainAsk) + '</div>' +
        '</div>';
      }

      var descriptionHtml = '';
      if (description && description !== mainAsk && description !== reason) {
        descriptionHtml = '<div class="mc-task-detail-section">' +
          '<p class="mc-section-title" style="margin:0.55rem 0 0.35rem;">Description</p>' +
          '<div class="mc-task-detail-block">' + escapeHtml(description) + '</div>' +
        '</div>';
      }

      var reviewNotesHtml = '';
      if (reviewNotes) {
        reviewNotesHtml = '<div class="mc-task-detail-section">' +
          '<p class="mc-section-title" style="margin:0.55rem 0 0.35rem;">Review Notes</p>' +
          '<div class="mc-task-detail-block">' + escapeHtml(reviewNotes) + '</div>' +
        '</div>';
      }

      var missionProgressHtml = '';
      if (missionProgress && (missionProgress.pct || (missionProgress.evidence && missionProgress.evidence.length))) {
        var progressParts = [];
        if (missionProgress.pct) progressParts.push('Progress: ' + missionProgress.pct + '%');
        if (missionProgress.metrics && Object.keys(missionProgress.metrics).length) {
          Object.keys(missionProgress.metrics).forEach(function (k) {
            progressParts.push(k + ': ' + missionProgress.metrics[k]);
          });
        }
        if (missionProgress.evidence && missionProgress.evidence.length) {
          progressParts.push('Evidence: ' + missionProgress.evidence.join(' · '));
        }
        missionProgressHtml = '<div class="mc-task-detail-section">' +
          '<p class="mc-section-title" style="margin:0.55rem 0 0.35rem;">Mission Progress</p>' +
          '<div class="mc-task-detail-block">' + escapeHtml(progressParts.join('\n')) + '</div>' +
        '</div>';
      }

      var historyHtml = '';
      if (missionHistory.length) {
        historyHtml = '<div class="mc-task-detail-section">' +
          '<p class="mc-section-title" style="margin:0.55rem 0 0.35rem;">Recent Mission History</p>' +
          '<ul class="mc-task-history-list">' +
          missionHistory.map(function (entry) {
            var ts = entry.ts ? mc2FormatTaskTimestamp(entry.ts) : '';
            var summary = String(entry.summary || '').trim();
            var evidence = Array.isArray(entry.evidence) && entry.evidence.length
              ? ' — ' + entry.evidence.join(', ')
              : '';
            var skillsCalled = Array.isArray(entry.skillsCalled) && entry.skillsCalled.length
              ? ' [' + entry.skillsCalled.join(', ') + ']'
              : '';
            var statusBit = entry.status ? ' (' + entry.status + ')' : '';
            return '<li>' +
              (ts ? '<span class="mc-task-history-ts">' + escapeHtml(ts) + '</span> ' : '') +
              '<span class="mc-task-history-summary">' + escapeHtml(summary + evidence + skillsCalled + statusBit) + '</span>' +
            '</li>';
          }).join('') +
          '</ul>' +
        '</div>';
      }

      return '' +
        '<div class="mc-task-detail-head">' +
          '<h3 class="mc-task-detail-title" id="mc2-task-drawer-title">' + escapeHtml(title) + '</h3>' +
          '<span class="team-mission-task-status ' + escapeHtml(status) + '">' + escapeHtml(statusLabel) + '</span>' +
        '</div>' +
        mainAskHtml +
        descriptionHtml +
        fieldsHtml +
        sourceChainHtml +
        inactionHtml +
        (reason && reason !== mainAsk && reason !== description
          ? '<div class="mc-task-detail-reason"><strong>Reason:</strong> ' + escapeHtml(reason) + '</div>'
          : '') +
        reviewNotesHtml +
        missionProgressHtml +
        historyHtml +
        '<div id="mc2-task-retro-slot" class="mc-task-detail-section"></div>' +
        actionsHtml +
        '<p class="mc-section-title" style="margin:0.65rem 0 0.35rem;">Timeline</p>' +
        timelineHtml +
        agentStatsHtml +
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
        mc2LoadRetrospectiveSlot(drawerBody);
      }
      if (panel) {
        panel.hidden = true;
        panel.innerHTML = '<p class="team-agent-inbox-empty" style="margin:0;">Select a task from the board, list, or recent movement.</p>';
      }
    }

    var mc2RetroCache = null;
    var mc2RetroFetching = false;
    function mc2LoadRetrospectiveSlot(drawerBody) {
      var slot = drawerBody.querySelector('#mc2-task-retro-slot');
      if (!slot) return;
      if (mc2RetroCache) {
        slot.innerHTML = mc2BuildRetroHtml(mc2RetroCache);
        return;
      }
      if (mc2RetroFetching) return;
      mc2RetroFetching = true;
      fetch((typeof API !== 'undefined' ? API : '') + '/api/team/retrospective')
        .then(function (r) { return r.ok ? r.json() : { cases: [] }; })
        .then(function (data) {
          mc2RetroCache = data;
          mc2RetroFetching = false;
          var el = document.getElementById('mc2-task-retro-slot');
          if (el) el.innerHTML = mc2BuildRetroHtml(data);
        })
        .catch(function () { mc2RetroFetching = false; });
    }

    function mc2BuildRetroHtml(data) {
      if (!data || !data.cases || !data.cases.length) return '';
      var cases = data.cases.slice(0, 5);
      var html = '<p class="mc-section-title" style="margin:0.55rem 0 0.35rem;">Retrospective — Recent Cases (' + data.count + ' total)</p>';
      html += '<ul class="mc-task-history-list">';
      cases.forEach(function (c) {
        var scoreBit = c.score != null ? 'Score: ' + c.score + '/10' : '';
        var feedback = c.feedbackType || '';
        var userMsg = String(c.userMessage || '').slice(0, 150);
        var reason = String(c.selfReason || c.implicitFeedback || '').trim();
        html += '<li>';
        if (scoreBit) html += '<strong>' + escapeHtml(scoreBit) + '</strong> ';
        if (feedback) html += '<em>(' + escapeHtml(feedback) + ')</em> ';
        if (userMsg) html += '<br><span style="color:#94a3b8;">User: </span>' + escapeHtml(userMsg);
        if (reason) html += '<br><span style="color:#fbbf24;">Reason: </span>' + escapeHtml(reason);
        html += '</li>';
      });
      html += '</ul>';
      return html;
    }

    function mc2ResolveTaskFromCard(card) {
      if (!card) return null;
      var missionId = String(card.getAttribute('data-mission-id') || '').trim();
      var taskId = String(card.getAttribute('data-task-id') || '').trim();
      var title = String(card.getAttribute('data-title') || '').trim();
      var agentId = String(card.getAttribute('data-agent-id') || card.getAttribute('data-mc-agent') || '').trim();
      var turnTs = Number(card.getAttribute('data-turn-ts') || 0);
      var item = null;
      if (typeof findMissionTaskItem === 'function') {
        item = findMissionTaskItem({ missionId: missionId, taskId: taskId, title: title, agentId: agentId });
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
      if (!item && opts.missionId && typeof findMissionTaskItem === 'function') {
        item = findMissionTaskItem({
          missionId: opts.missionId,
          taskId: opts.taskId,
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
      if (!item) {
        item = {
          kind: 'agent',
          status: String(ctx.state || 'idle').toLowerCase() === 'error' ? 'blocked' : 'open',
          title: agentNameById(aid) + ' tasks',
          agentId: aid,
          assignee: aid,
          path: agentNameById(aid),
          description: String(ctx.currentThought || ctx.currentStep || ctx.lastAction || 'Agent task menu').trim(),
          reason: String(ctx.waitingFor || ctx.lastAction || '').trim(),
          updatedAt: Number(ctx.updatedAt) || Date.now(),
          createdAt: Number(ctx.updatedAt) || Date.now(),
        };
      }
      mc2OpenTaskDetail(item, { agentId: aid, filter: item && item.status === 'blocked' ? 'blocked' : 'all' });
    }

    function mc2OpenTaskForSuggestedTask(suggestedTaskId) {
      var id = String(suggestedTaskId || '').trim();
      if (!id) return;
      var taskId = 'init-' + id;
      var item = typeof findMissionTaskItem === 'function'
        ? findMissionTaskItem({ taskId: taskId })
        : null;
      if (item) {
        mc2OpenTaskDetail(item, { filter: 'all' });
        return;
      }
      selectedTeamSuggestedTaskId = id;
      mc2OpenTasksView('all');
    }

    window.mc2OpenTasksView = mc2OpenTasksView;
    window.mc2SetTasksFilter = mc2SetTasksFilter;
    window.mc2OpenTaskDetail = mc2OpenTaskDetail;
    window.mc2OpenTaskDetailForAgent = mc2OpenTaskDetailForAgent;
    window.mc2OpenTaskForSuggestedTask = mc2OpenTaskForSuggestedTask;
    window.mc2CloseTaskDrawer = mc2CloseTaskDrawer;

    function mc2AgentInitials(a) {
      var name = agentCardShortName(a);
      return name.slice(0, 2).toUpperCase();
    }

    // Ordered by golden angle (137.5°) so that any N consecutive entries
    // are maximally spread across the hue wheel — small teams always get
    // visually distinct colors, large teams still vary.
    var MC2_AGENT_COLORS = [
      '#ef4444', //  0°  red
      '#22c55e', // 137° green
      '#a855f7', // 275° purple
      '#f59e0b', //  52° amber
      '#0ea5e9', // 190° sky
      '#f43f5e', // 328° rose
      '#84cc16', // 105° lime
      '#6366f1', // 242° indigo
      '#f97316', //  20° orange
      '#10b981', // 157° emerald
      '#d946ef', // 295° fuchsia
      '#eab308', //  72° yellow
    ];

    function agentColorFromId(id) {
      var s = String(id || 'main');
      var hash = 0;
      for (var i = 0; i < s.length; i++) {
        hash = (hash * 31 + s.charCodeAt(i)) & 0xfffffff;
      }
      return MC2_AGENT_COLORS[hash % MC2_AGENT_COLORS.length];
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

    function mc2AvatarHtml(a, opts) {
      var large = opts && opts.large;
      var cls = 'mc-agent-avatar' + (large ? ' mc-agent-avatar--large' : '');
      var color = (a && a.color) || agentColorFromId(a && a.id);
      var borderStyle = ' style="border-color:' + color + '"';
      if (a && a.avatarUrl) {
        return (
          '<div class="' + cls + ' mc-agent-avatar--img"' + borderStyle + '>' +
            '<img src="' + escapeHtml(a.avatarUrl) + '" alt="' + escapeHtml(agentCardShortName(a)) + '" loading="lazy">' +
          '</div>'
        );
      }
      var initials = mc2AgentInitials(a);
      return '<div class="' + cls + '"' + borderStyle + '>' + escapeHtml(initials) + '</div>';
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
      if (/^You are executing a persistent background mission tick/i.test(t)) return true;
      if (/^Received (?:reply|delegated task) from\b/i.test(t)) return true;
      if (/^Delegation to .+ failed/i.test(t)) return true;
      if (/^Task failed/i.test(t)) return true;
      if (isEphemeralMissionLabel(t)) return true;
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

      // Use the same task-resolution logic the click handler uses, so the card title
      // matches what the detail panel shows instead of falling through to the mission name.
      if (typeof findMissionTaskForAgent === 'function') {
        var agentTask = findMissionTaskForAgent(agentId, ctx);
        if (agentTask && agentTask.title && !mc2GenericTaskNoise(agentTask.title)) {
          return agentTask.title.slice(0, 160);
        }
      }

      var mission = missionLabelForAgent(agentId, ctx);
      if (mission && !mc2GenericTaskNoise(mission)) return 'Running mission tick';

      if (state === 'idle') {
        var queued = String(ctx.currentMission || ctx.currentStep || '').trim();
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
        '<div class="mc-kanban-card-meta mc-kanban-card-agent">' +
          mc2AvatarHtml(a) +
          '<span>' + name + '</span>' +
        '</div>' +
        '<div class="mc-kanban-card-title mc-kanban-card-title--sub">' + escapeHtml(taskTitle) + '</div>' +
        progressHtml +
        (state === 'waiting' && waitingFor
          ? '<div class="mc-kanban-card-meta">Next: ' + escapeHtml(agentNameById(waitingFor)) + ' approval</div>'
          : '') +
        (lastTs ? '<div class="mc-kanban-card-meta">Last action: ' + mc2RelTime(lastTs) + '</div>' : '') +
        tagHtml +
        '<button type="button" class="mc-panel-link mc-kanban-context-link" data-mc-open-context="1" data-mc-agent="' + escapeHtml(id) + '">Agent context →</button>' +
      '</div>';
    }
