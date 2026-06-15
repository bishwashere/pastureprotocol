/* MC2 Tasks page — list, filters, inline detail panel */
    function mc2TaskDisplayTitle(task) {
      var prompt = String(task && task.prompt || '').trim();
      if (prompt
        && !/^Handled in \d+/i.test(prompt)
        && !/^Completed turn/i.test(prompt)
        && !/^You are executing a persistent background mission tick/i.test(prompt)
      ) {
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
      if (s === 'waiting') return 'open';
      return 'open';
    }

    function mc2FormatDuration(ms) {
      if (!ms || ms < 0) return '';
      var s = Math.floor(ms / 1000);
      if (s < 60) return s + 's';
      var m = Math.floor(s / 60);
      if (m < 60) return m + 'm';
      var h = Math.floor(m / 60);
      var rm = m % 60;
      if (h < 24) return h + 'h' + (rm ? ' ' + rm + 'm' : '');
      var d = Math.floor(h / 24);
      var rh = h % 24;
      return d + 'd' + (rh ? ' ' + rh + 'h' : '');
    }

    function mc2TaskTimingBarHtml(item) {
      var now = Date.now();
      var createdAt = Number(item.createdAt) || 0;
      var startedAt = Number(item.startedAt) || 0;
      var completedAt = Number(item.completedAt) || 0;
      var waitingSince = Number(item.waitingSince) || createdAt;
      if (!createdAt && !waitingSince && !startedAt) return '';

      var waitMs = 0, activeMs = 0, label = '';
      var status = String(item.status || '').toLowerCase();

      if (status === 'done') {
        var refStart = createdAt || startedAt;
        waitMs = startedAt && createdAt ? startedAt - createdAt : 0;
        activeMs = startedAt && completedAt ? completedAt - startedAt
          : (completedAt && refStart ? completedAt - refStart : 0);
        var totalMs = completedAt && refStart ? completedAt - refStart : (waitMs + activeMs);
        label = 'Done in ' + mc2FormatDuration(totalMs);
      } else if (status === 'doing') {
        if (startedAt && createdAt) {
          waitMs = startedAt - createdAt;
          activeMs = now - startedAt;
          label = (waitMs > 60000 ? 'Waited ' + mc2FormatDuration(waitMs) + ' · ' : '') +
            'Active ' + mc2FormatDuration(activeMs);
        } else {
          // No startedAt yet — show full bar as waiting since createdAt
          var since = createdAt || waitingSince;
          waitMs = since ? now - since : 0;
          activeMs = 0;
          label = 'Waiting ' + mc2FormatDuration(waitMs);
        }
      } else {
        var since = waitingSince || createdAt;
        waitMs = since ? now - since : 0;
        label = 'Waiting ' + mc2FormatDuration(waitMs);
      }

      var total = waitMs + activeMs;
      if (!total || total <= 0) return '';
      var waitPct = Math.round((waitMs / total) * 100);
      var activePct = 100 - waitPct;

      return '<div class="mc-task-timing-bar mc-task-timing-bar--' + status + '" title="' + escapeHtml(label) + '">' +
        (waitPct > 0 ? '<span class="mc-task-timing-wait" style="width:' + waitPct + '%"></span>' : '') +
        (activePct > 0 && (status === 'doing' || status === 'done')
          ? '<span class="mc-task-timing-active" style="width:' + activePct + '%"></span>'
          : '') +
        '<span class="mc-task-timing-label">' + escapeHtml(label) + '</span>' +
      '</div>';
    }

    function mc2MissionTaskCard(item) {
      var status = String(item.status || 'todo').toLowerCase();
      var assigneeId = String(item.assignee || item.agentId || '').trim();
      var a = (agentMapData || []).find(function (x) { return String(x.id) === assigneeId; }) || { id: assigneeId || 'main' };
      var agentHtml = assigneeId
        ? '<span class="mc-task-card-agent">' + mc2AvatarHtml(a) + '<span>' + escapeHtml(agentNameById(assigneeId)) + '</span></span>'
        : '';
      var missionLine = item.missionTitle && item.kind !== 'mission'
        ? '<span class="mc-task-card-mission">' + escapeHtml(item.missionTitle) + '</span>'
        : '';
      var suggestedTaskLine = item.fromSuggestedTask
        ? '<span class="mc-task-card-suggestedTask">AI suggested</span>'
        : '';
      var labels = Array.isArray(item.labels) ? item.labels : [];
      var labelLine = labels.length
        ? labels.map(function (label) {
          return '<span class="mc-task-card-label">' + escapeHtml(label) + '</span>';
        }).join('')
        : '';
      var delegatedLine = item.delegatedFrom
        ? '<span class="mc-task-card-delegation">Assigned by ' + escapeHtml(agentNameById(item.delegatedFrom) || item.delegatedFrom) + '</span>'
        : '';
      var pathLine = item.path && item.kind === 'task'
        ? '<div class="mc-task-card-path">' + escapeHtml(item.path) + '</div>'
        : '';
      var desc = String(item.description || '').trim();
      var descHtml = desc ? '<p class="mc-task-card-desc">' + escapeHtml(desc.slice(0, 220)) + '</p>' : '';
      var expectedOutput = String(item.expectedOutput || '').trim();
      var outputHtml = expectedOutput
        ? '<p class="mc-task-card-output"><span class="mc-task-card-output-label">Output:</span> ' + escapeHtml(expectedOutput.slice(0, 120)) + '</p>'
        : '';
      var progress = Number(item.progress);
      var progressLabel = isFinite(progress) && progress > 0 ? (progress + '%') : '';
      var confidenceRaw = Number(item.routeConfidence || item.confidence || 0);
      var confidenceLabel = confidenceRaw > 0 ? (Math.round(confidenceRaw * 100) + '% confidence') : '';
      var missionId = String(item.missionId || '');
      var taskId = String(item.taskId || '');
      var selected = mc2SelectedTask && (
        (missionId || taskId)
          ? String(mc2SelectedTask.taskId || '') === taskId &&
            String(mc2SelectedTask.missionId || '') === missionId
          : Number(mc2SelectedTask.turnTs || 0) === Number(item.turnTs || 0) &&
            String(mc2SelectedTask.agentId || mc2SelectedTask.assignee || '') === assigneeId
      );
      var actionsHtml = '';
      if (item.kind === 'task' && missionId && taskId && typeof missionTaskActionButtonsHtml === 'function') {
        actionsHtml = missionTaskActionButtonsHtml(missionId, taskId, status, {
          fromSuggestedTask: !!item.fromSuggestedTask,
        });
      } else if (status === 'blocked' && missionId && typeof missionNeedsAttention === 'function') {
        actionsHtml = '<div class="mc-task-card-actions">' +
          '<button type="button" class="mc-task-card-btn primary" data-mc-task-action="respond"' +
            ' data-mission-id="' + escapeHtml(missionId) + '">Respond</button>' +
        '</div>';
      }
      return '<div class="mc-task-card mc-mission-task-card' + (selected ? ' mc-task-card-selected' : '') + '" data-mc-mission-task="1"' +
        ' data-mission-id="' + escapeHtml(missionId) + '"' +
        ' data-task-id="' + escapeHtml(taskId) + '"' +
        ' data-agent-id="' + escapeHtml(String(item.agentId || assigneeId || '')) + '"' +
        ' data-status="' + escapeHtml(status) + '"' +
        ' data-title="' + escapeHtml(String(item.title || '')) + '">' +
        '<div class="mc-task-card-title">' + escapeHtml(item.title || 'Untitled') + '</div>' +
        pathLine +
        descHtml +
        outputHtml +
        '<div class="mc-task-card-meta">' +
          '<span class="team-mission-task-status ' + escapeHtml(status) + '">' + escapeHtml(mc2MissionTaskStatusLabel(status)) + '</span>' +
          agentHtml +
          missionLine +
          suggestedTaskLine +
          labelLine +
          delegatedLine +
          (progressLabel ? '<span>' + escapeHtml(progressLabel) + '</span>' : '') +
          (confidenceLabel ? '<span class="mc-task-card-confidence">' + escapeHtml(confidenceLabel) + '</span>' : '') +
        '</div>' +
        actionsHtml +
        mc2TaskTimingBarHtml(item) +
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
      var filtered = items;
      if (selectedTeamMissionId) {
        filtered = filtered.filter(function (it) {
          return String(it.missionId || '') === selectedTeamMissionId;
        });
      }
      if (mc2TasksAgentFilter) {
        filtered = filtered.filter(function (it) {
          var aid = String(it.assignee || it.agentId || '').trim();
          return aid === mc2TasksAgentFilter;
        });
      }
      return filtered;
    }

    function mc2RenderCanonicalTaskCard(item) {
      if (item && item.kind === 'turn') return mc2TaskCard(item);
      return mc2MissionTaskCard(item);
    }

    function mc2MissionTaskItemFromEl(el) {
      if (!el) return null;
      return {
        kind: 'task',
        missionId: String(el.getAttribute('data-mission-id') || ''),
        taskId: String(el.getAttribute('data-task-id') || ''),
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
        if (item && item.missionId && typeof findMissionTaskItem === 'function') {
          item = findMissionTaskItem({
            missionId: item.missionId,
            taskId: item.taskId,
            title: item.title,
            agentId: item.agentId,
          }) || item;
        }
      }
      if (item) {
        mc2OpenTaskDetail(item, { filter: item.status === 'blocked' ? 'blocked' : 'all' });
        return;
      }
      var missionId = card.getAttribute('data-mission-id');
      if (missionId) {
        mc2OpenTaskDetail(null, { missionId: missionId, filter: 'all' });
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
          var missionId = card.getAttribute('data-mission-id');
          if (missionId || (agentId && card.getAttribute('data-mc-mission-task'))) {
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
      var range = teamAgentPanelRange || 'today';
      var allItems = typeof listCanonicalWorkItems === 'function'
        ? listCanonicalWorkItems({ range: range })
        : (typeof flattenMissionWorkItems === 'function' ? flattenMissionWorkItems() : []);
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
        var rangeLabel = teamAgentRangeLabel(range);
        var tasks = groups.done;
        if (filter === 'done' && titleEl) {
          titleEl.textContent = 'COMPLETED — ' + rangeLabel.toUpperCase() + ' (' + tasks.length + ')';
        }
        html += '<section class="mc-tasks-section mc-tasks-section-done">' +
          '<h4 class="mc-tasks-section-title">Completed <span class="mc-tasks-section-count">' + tasks.length + '</span>' +
          (filter === 'all' ? ' <span class="mc-tasks-section-sub">' + escapeHtml(rangeLabel) + '</span>' : '') +
          '</h4>' +
          '<div class="mc-tasks-section-body">';
        if (!tasks.length) {
          html += '<p class="mc-kanban-empty">No completed mission tasks for this range.</p>';
        } else {
          mc2TimelineSpyEnabled = filter === 'done';
          html += tasks.map(mc2RenderCanonicalTaskCard).join('');
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
