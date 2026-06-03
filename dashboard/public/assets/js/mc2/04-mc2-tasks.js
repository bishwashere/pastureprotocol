/* MC2 Tasks page — list, filters, inline detail panel */
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
