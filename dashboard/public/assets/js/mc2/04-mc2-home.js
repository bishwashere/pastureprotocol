/* MC2 Home page — mission progress, kanban, movement, attention (live refresh) */

    /** Home stat cards and kanban columns share these collectors so counts always match. */
    function computeMc2HomeCounts() {
      return {
        inProgress: mc2CollectKanbanProgressItems().length,
        open: mc2CollectKanbanOpenItems().length,
        completed: mc2CollectKanbanCompletedItems().length,
        needsAttention: mc2CollectKanbanAttentionItems().length,
      };
    }

    function mc2FocusKanbanColumn(col) {
      var colId = {
        progress: 'mc2-col-progress',
        open: 'mc2-col-open',
        completed: 'mc2-col-completed',
        attention: 'mc2-col-attention',
      }[String(col || '').trim()];
      if (!colId) return;
      var body = mc2El(colId);
      if (!body) return;
      var wrap = body.closest('.mc-kanban-col') || body;
      wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function mc2RenderMissionProgress() {
      var counts = computeMc2HomeCounts();
      var missions = Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : [];
      var activeMission = getCurrentMissionMission();
      var pct = 0;
      var progressLabel = '— / — tasks completed';
      var etaLabel = '';
      if (activeMission) {
        var label = String(activeMission.title || activeMission.objective || '').trim();
        var totalSubs = 0, doneSubs = 0;
        // Use the same deduplicated task list as the kanban (flattenMissionWorkItems) so the
        // progress bar and the Work Completed lane always show consistent numbers.
        // Direct recursive walks on activeMission.tasks double-count delegated originals.
        var _flatItems = typeof flattenMissionWorkItems === 'function' ? flattenMissionWorkItems() : [];
        var _missionId = String(activeMission.id || '');
        var _missionTasks = _flatItems.filter(function (it) {
          return it.kind === 'task' && String(it.missionId || '') === _missionId;
        });
        if (_missionTasks.length > 0) {
          totalSubs = _missionTasks.length;
          _missionTasks.forEach(function (it) {
            if (String(it.status || '').toLowerCase() === 'done') doneSubs++;
          });
        } else {
          // Fallback: raw walk when flattenMissionWorkItems returns nothing for this mission.
          (activeMission.tasks || []).forEach(function sg(s) {
            totalSubs++;
            if (String(s.status || '').toLowerCase() === 'done') doneSubs++;
            (s.tasks || []).forEach(sg);
          });
        }
        pct = totalSubs > 0 ? Math.max(0, Math.min(100, Math.round((doneSubs / totalSubs) * 100))) : 0;
        progressLabel = totalSubs > 0
          ? doneSubs + ' / ' + totalSubs + ' tasks completed · ' + pct + '%'
          : (label ? label : 'Active mission') + ' — ' + pct + '%';
      }
      var fill = mc2El('mc2-progress-bar-fill');
      if (fill) fill.style.width = pct + '%';
      var pl = mc2El('mc2-progress-label');
      if (pl) pl.textContent = progressLabel;
      var pp = mc2El('mc2-progress-percent');
      if (pp) pp.textContent = pct + '%';
      var eta = mc2El('mc2-eta-label');
      var runningLabel = counts.inProgress > 0
        ? '⏳ Agent working… (' + counts.inProgress + ' in progress)'
        : (etaLabel || (activeMission ? 'ETA: tracking live work' : 'ETA: no active mission'));
      if (eta) eta.textContent = runningLabel;
      var statActive = mc2El('mc2-stat-active'); if (statActive) statActive.textContent = counts.inProgress;
      var statOpen = mc2El('mc2-stat-open'); if (statOpen) statOpen.textContent = counts.open;
      var statAttention = mc2El('mc2-stat-attention'); if (statAttention) statAttention.textContent = counts.needsAttention;
      var statDone = mc2El('mc2-stat-done'); if (statDone) statDone.textContent = counts.completed;
      var statPace = mc2El('mc2-stat-pace');
      if (statPace) {
        var events = teamActivityEvents || [];
        var hourAgo = Date.now() - 3600000;
        var recent = events.filter(function (e) { return Number(e.ts) > hourAgo && String(e.type) === 'turn_done'; }).length;
        statPace.textContent = recent + '/hr';
      }
      var missionSel = mc2El('mc2-mission-select');
      if (missionSel) {
        var missionList = Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : [];
        var currentMission = getCurrentMissionMission();
        var statusLabel = { active: '', paused: ' [paused]', blocked: ' [blocked]', completed: ' [done]' };
        missionSel.innerHTML = (missionList.length === 0 ? '<option value="">No missions</option>' : '') +
          missionList.map(function (g) {
            var gid = String(g.id || '');
            var status = String(g.status || 'active').toLowerCase();
            var sel = currentMission && String(currentMission.id || '') === gid ? ' selected' : '';
            var label = escapeHtml(String(g.title || g.objective || 'Untitled mission')) + escapeHtml(statusLabel[status] || (' [' + status + ']'));
            return '<option value="' + escapeHtml(gid) + '"' + sel + '>' + label + '</option>';
          }).join('');
      }
    }

    function mc2SuggestedTaskWasAutoPromoted(suggestedTask) {
      var raw = suggestedTask && suggestedTask.activity;
      var lines = Array.isArray(raw) ? raw : (raw ? [String(raw)] : []);
      return lines.some(function (line) {
        return String(line || '').indexOf('Auto-promoted to task in ') >= 0;
      });
    }

    function mc2ProposedSuggestedTaskNeedsApproval(suggestedTask) {
      var status = String(suggestedTask && suggestedTask.status || 'proposed').toLowerCase();
      if (status === 'rejected' || status === 'completed' || status === 'accepted') return false;
      if (typeof suggestedTaskIsOnMission === 'function' && suggestedTaskIsOnMission(suggestedTask)) return false;
      return status === 'proposed' || status === 'open';
    }

    function mc2ProposedSuggestedTaskSubtitle(suggestedTask) {
      var confidence = Math.round((Number(suggestedTask && suggestedTask.confidence) || 0) * 100);
      var ts = Number(suggestedTask && suggestedTask.updatedAt) || 0;
      var parts = ['Awaiting approval'];
      if (confidence > 0) parts.unshift('Confidence ' + confidence + '%');
      if (ts) parts.push('proposed ' + mc2ShortWaitTime(ts));
      return parts.join(' · ');
    }

    function mc2SuggestedTaskDiscoveryIcon(suggestedTask) {
      var type = String(suggestedTask && suggestedTask.type || 'observation').toLowerCase();
      if (type === 'risk' || type === 'gap' || type === 'warning') return '⚠';
      return '💡';
    }

    function mc2ProposedTagHtml(extraClass) {
      var cls = 'mc-kanban-card-tag discovery' + (extraClass ? ' ' + extraClass : '');
      return '<span class="' + cls + '">Proposed</span>';
    }

    function mc2AutoPromotedTagHtml(extraClass) {
      return mc2ProposedTagHtml(extraClass);
    }

    function mc2TaskTitleForSuggestedTask(suggestedTask) {
      var suggestedTaskId = String(suggestedTask && suggestedTask.id || '');
      var taskId = suggestedTaskId ? 'init-' + suggestedTaskId : '';
      var fallback = String(suggestedTask && suggestedTask.title || 'Untitled task').trim();
      if (!taskId || typeof findMissionTaskItem !== 'function') return fallback;
      var taskItem = findMissionTaskItem({ taskId: taskId, title: suggestedTask.title });
      return String((taskItem && taskItem.title) || fallback).trim();
    }

    function mc2AutoPromotedSuggestedTaskSubtitle(suggestedTask) {
      var confidence = Math.round((Number(suggestedTask && suggestedTask.confidence) || 0) * 100);
      var ts = Number(suggestedTask && suggestedTask.updatedAt) || 0;
      var parts = ['Needs review'];
      if (confidence > 0) parts.unshift('Confidence ' + confidence + '%');
      if (ts) parts.push('waiting ' + mc2ShortWaitTime(ts));
      return parts.join(' · ');
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
      if (item.missionId) attrs += ' data-mission-id="' + escapeHtml(String(item.missionId)) + '"';
      if (item.taskId) attrs += ' data-task-id="' + escapeHtml(String(item.taskId)) + '"';
      if (item.agentId) attrs += ' data-mc-agent="' + escapeHtml(String(item.agentId)) + '" data-agent-id="' + escapeHtml(String(item.agentId)) + '"';
      if (item.kind === 'turn' && item.ts) attrs += ' data-turn-ts="' + escapeHtml(String(item.ts)) + '" data-mc-kanban-kind="turn"';
      if (item.kind) attrs += ' data-mc-kanban-kind="' + escapeHtml(String(item.kind)) + '"';
      return '<div' + attrs + '>' +
        '<div class="mc-kanban-card-title">✓ ' + title + '</div>' +
        meta.map(function (line) { return '<div class="mc-kanban-card-meta">' + line + '</div>'; }).join('') +
        (when ? '<div class="mc-kanban-card-meta mc-kanban-card-when">' + escapeHtml(when) + '</div>' : '') +
        (typeof mc2TaskTimingBarHtml === 'function' ? mc2TaskTimingBarHtml(Object.assign({ status: 'done' }, item)) : '') +
      '</div>';
    }

    function mc2KanbanAttentionCard(item) {
      var icon = item.tag && item.discoveryType
        ? (item.discoveryType === 'risk' || item.discoveryType === 'gap' || item.discoveryType === 'warning' ? '⚠' : '💡')
        : (item.kind === 'error' ? '🔴' : '⚠');
      var attrs = ' class="mc-kanban-card mc-kanban-card-attention ' + escapeHtml(item.kind || 'warning') + '"';
      attrs += ' data-mc-kanban-kind="attention" data-attention-action="' + escapeHtml(item.action || '') + '"';
      if (item.missionId) attrs += ' data-mission-id="' + escapeHtml(item.missionId) + '"';
      if (item.taskId) attrs += ' data-task-id="' + escapeHtml(item.taskId) + '"';
      if (item.agentId) attrs += ' data-agent-id="' + escapeHtml(item.agentId) + '"';
      if (item.pendingId) attrs += ' data-pending-id="' + escapeHtml(item.pendingId) + '"';
      if (item.suggestedTaskId) attrs += ' data-suggestedTask-id="' + escapeHtml(item.suggestedTaskId) + '"';
      var timingItem = { status: item.status || 'blocked', createdAt: item.createdAt || item.ts || 0, startedAt: item.startedAt || 0, waitingSince: item.waitingSince || item.ts || 0 };
      return '<div' + attrs + ' role="button" tabindex="0">' +
        '<div class="mc-kanban-card-title">' + icon + ' ' + escapeHtml(item.title) + '</div>' +
        (item.isMission
          ? '<div class="mc-kanban-card-meta"><span class="mc-task-card-label mc-task-label-mission">Mission</span></div>'
          : '') +
        (item.tag
          ? '<div class="mc-kanban-card-meta">' + mc2ProposedTagHtml() + '</div>'
          : '') +
        (item.subtitle || item.text
          ? '<div class="mc-kanban-card-meta">' + escapeHtml(item.subtitle || String(item.text || '').replace(/^[^—]+—\s*/, '')) + '</div>'
          : '') +
        (item.ts ? '<div class="mc-kanban-card-meta mc-kanban-card-when">' + mc2RelTime(item.ts) + '</div>' : '') +
        (typeof mc2TaskTimingBarHtml === 'function' ? mc2TaskTimingBarHtml(timingItem) : '') +
      '</div>';
    }

    function mc2KanbanDiscoveryCard(suggestedTask) {
      var id = String(suggestedTask.id || '');
      var icon = mc2SuggestedTaskDiscoveryIcon(suggestedTask);
      var title = escapeHtml(String(suggestedTask.title || 'Untitled discovery'));
      var confidence = Math.round((Number(suggestedTask.confidence) || 0) * 100);
      var proposedTs = Number(suggestedTask.updatedAt || suggestedTask.proposedAt || suggestedTask.createdAt) || 0;
      var timingItem = { status: 'todo', createdAt: proposedTs, waitingSince: proposedTs };
      return '<div class="mc-kanban-card mc-kanban-card-discovery" data-mc-kanban-kind="discovery" data-suggestedTask-id="' + escapeHtml(id) + '" role="button" tabindex="0">' +
        '<div class="mc-kanban-card-title">' + icon + ' ' + title + '</div>' +
        '<div class="mc-kanban-card-meta">' + mc2ProposedTagHtml() + '</div>' +
        '<div class="mc-kanban-card-meta">Confidence ' + escapeHtml(String(confidence)) + '%</div>' +
        (typeof mc2TaskTimingBarHtml === 'function' ? mc2TaskTimingBarHtml(timingItem) : '') +
      '</div>';
    }

    function mc2KanbanProgressTaskCard(item) {
      var assigneeId = String(item.assignee || '').trim();
      var a = (agentMapData || []).find(function (x) { return String(x.id) === assigneeId; }) || { id: assigneeId || 'main' };
      return '<div class="mc-kanban-card mc-kanban-card-progress" data-mc-kanban-kind="task"' +
        ' data-mission-id="' + escapeHtml(String(item.missionId || '')) + '"' +
        ' data-task-id="' + escapeHtml(String(item.taskId || '')) + '"' +
        ' data-title="' + escapeHtml(String(item.title || '')) + '"' +
        ' data-agent-id="' + escapeHtml(assigneeId) + '">' +
        '<div class="mc-kanban-card-title">' + escapeHtml(String(item.title || 'In progress')) + '</div>' +
        (assigneeId
          ? '<div class="mc-kanban-card-meta mc-kanban-card-agent">' + mc2AvatarHtml(a) + '<span>' + escapeHtml(agentNameById(assigneeId)) + '</span></div>'
          : '') +
        (item.progress ? '<div class="mc-kanban-card-meta">' + escapeHtml(String(item.progress)) + '% complete</div>' : '') +
        (typeof mc2TaskTimingBarHtml === 'function' ? mc2TaskTimingBarHtml(item) : '') +
      '</div>';
    }

    function mc2KanbanOpenTaskCard(item) {
      var assigneeId = String(item.assignee || item.agentId || '').trim();
      var a = assigneeId
        ? ((agentMapData || []).find(function (x) { return String(x.id) === assigneeId; }) || { id: assigneeId })
        : null;
      return '<div class="mc-kanban-card mc-kanban-card-open" data-mc-kanban-kind="task"' +
        ' data-mission-id="' + escapeHtml(String(item.missionId || '')) + '"' +
        ' data-task-id="' + escapeHtml(String(item.taskId || '')) + '"' +
        ' data-title="' + escapeHtml(String(item.title || '')) + '"' +
        (assigneeId ? ' data-agent-id="' + escapeHtml(assigneeId) + '"' : '') + '>' +
        '<div class="mc-kanban-card-title">' + escapeHtml(String(item.title || 'Open task')) + '</div>' +
        (a && assigneeId
          ? '<div class="mc-kanban-card-meta mc-kanban-card-agent">' + mc2AvatarHtml(a) + '<span>' + escapeHtml(agentNameById(assigneeId)) + '</span></div>'
          : '<div class="mc-kanban-card-meta">Not yet assigned</div>') +
        (item.missionTitle ? '<div class="mc-kanban-card-meta">' + escapeHtml(String(item.missionTitle)) + '</div>' : '') +
        (typeof mc2TaskTimingBarHtml === 'function' ? mc2TaskTimingBarHtml(item) : '') +
      '</div>';
    }

    function mc2MissionWaitSubtitle(mission, ts) {
      var mission = String(mission && (mission.title || mission.objective) || 'Mission').trim();
      var wait = mc2ShortWaitTime(ts || (mission && mission.updatedAt));
      return mission + ' · waiting ' + wait;
    }

    function mc2PushActionRequiredItem(items, item) {
      if (!item || !item.title) return;
      var key = [
        item.action || '',
        item.missionId || '',
        item.taskId || '',
        item.agentId || '',
        item.pendingId || '',
        item.suggestedTaskId || '',
        item.title,
      ].join('|');
      for (var i = 0; i < items.length; i++) {
        var existing = items[i];
        var existingKey = [
          existing.action || '',
          existing.missionId || '',
          existing.taskId || '',
          existing.agentId || '',
          existing.pendingId || '',
          existing.suggestedTaskId || '',
          existing.title,
        ].join('|');
        if (existingKey === key) return;
      }
      items.push(item);
    }

    function mc2CollectActionRequiredItems() {
      var items = [];
      var missions = Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : [];
      var allWork = typeof flattenMissionWorkItems === 'function' ? flattenMissionWorkItems() : [];
      var missionsWithInput = {};
      missions.forEach(function (g) {
        var missionId = String(g.id || '');
        var ask = String(g.needsUserInput || '').trim();
        if (!missionId || !ask) return;
        if (typeof isOrphanedLetterPrompt === 'function' && isOrphanedLetterPrompt(ask)) return;
        missionsWithInput[missionId] = true;
      });

      allWork.forEach(function (it) {
        if (String(it.status || '').toLowerCase() !== 'blocked') return;
        if (!mc2MatchesSelectedMission(it.missionId)) return;
        var ts = Number(it.updatedAt) || 0;
        if (it.kind === 'agent') {
          var agentId = String(it.agentId || it.assignee || '').trim();
          mc2PushActionRequiredItem(items, {
            kind: 'error',
            action: 'agent',
            agentId: agentId,
            title: String(it.title || 'Agent blocked').trim().slice(0, 96),
            subtitle: agentNameById(agentId) + ' · waiting ' + mc2ShortWaitTime(ts),
            ts: ts,
          });
          return;
        }
        if (it.kind === 'mission') {
          var blockedMissionId = String(it.missionId || '');
          var blockedTitle = String(it.description || it.title || 'Mission blocked').trim().slice(0, 96) || 'Mission blocked';
          mc2PushActionRequiredItem(items, {
            kind: 'error',
            action: 'mission-input',
            missionId: blockedMissionId,
            isMission: true,
            title: blockedTitle,
            subtitle: mc2MissionWaitSubtitle(
              missions.find(function (g) { return String(g.id || '') === blockedMissionId; }) || { title: it.title },
              ts
            ),
            ts: ts,
          });
          return;
        }
        if (missionsWithInput[String(it.missionId || '')]) return;
        var taskTitle = String(it.title || 'Blocked task').trim();
        mc2PushActionRequiredItem(items, {
          kind: 'error',
          action: 'mission-input',
          missionId: String(it.missionId || ''),
          taskId: String(it.taskId || ''),
          title: '\u201c' + taskTitle.slice(0, 80) + (taskTitle.length > 80 ? '\u2026' : '') + '\u201d',
          subtitle: it.missionTitle
            ? (it.missionTitle + ' · waiting ' + mc2ShortWaitTime(ts))
            : ('Mission · waiting ' + mc2ShortWaitTime(ts)),
          ts: ts,
          status: 'blocked',
          createdAt: Number(it.createdAt) || 0,
          startedAt: Number(it.startedAt) || 0,
          waitingSince: Number(it.waitingSince) || 0,
        });
      });

      missions.forEach(function (g) {
        var missionId = String(g.id || '');
        if (!mc2MatchesSelectedMission(missionId)) return;
        if (!missionsWithInput[missionId]) return;
        var ts = Number(g.updatedAt) || 0;
        var needsInput = String(g.needsUserInput || '').trim();
        mc2PushActionRequiredItem(items, {
          kind: 'warning',
          action: 'mission-input',
          missionId: missionId,
          isMission: true,
          title: needsInput.slice(0, 96),
          subtitle: mc2MissionWaitSubtitle(g, ts),
          ts: ts,
        });
      });

      var suggestedTasks = Array.isArray(teamSuggestedTasksSnapshot.suggestedTasks) ? teamSuggestedTasksSnapshot.suggestedTasks : [];
      suggestedTasks.forEach(function (it) {
        if (selectedTeamMissionId) {
          var ids = Array.isArray(it.relatedMissionIds) ? it.relatedMissionIds : [];
          if (ids.indexOf(selectedTeamMissionId) < 0) return;
        }
        var suggestedTaskId = String(it.id || '');
        var ts = Number(it.updatedAt) || 0;
        if (!mc2ProposedSuggestedTaskNeedsApproval(it)) return;
        mc2PushActionRequiredItem(items, {
          kind: 'warning',
          action: 'suggestedTask-review',
          suggestedTaskId: suggestedTaskId,
          title: String(it.title || 'Untitled proposal').trim().slice(0, 96),
          tag: 'Proposed',
          discoveryType: String(it.type || 'observation').toLowerCase(),
          subtitle: mc2ProposedSuggestedTaskSubtitle(it),
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

      items.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      return items;
    }

    function mc2MapKanbanAttentionItem(item) {
      return {
        kind: item.kind,
        action: item.action,
        missionId: item.missionId,
        taskId: item.taskId,
        agentId: item.agentId,
        pendingId: item.pendingId,
        suggestedTaskId: item.suggestedTaskId,
        title: item.title,
        subtitle: item.subtitle,
        tag: item.tag,
        discoveryType: item.discoveryType,
        text: escapeHtml(item.title) + (item.subtitle ? ' — ' + escapeHtml(item.subtitle) : ''),
        ts: item.ts,
      };
    }

    function mc2CollectKanbanAttentionItems() {
      return mc2CollectActionRequiredItems().map(mc2MapKanbanAttentionItem);
    }

    function mc2CollectKanbanCompletedItems() {
      var items = [];
      // When no mission is explicitly selected, scope to the current active mission so the
      // count matches the progress bar. Without this, the lane would show done items from
      // ALL missions while the progress bar shows only the active one.
      var _activeMission = !selectedTeamMissionId ? getCurrentMissionMission() : null;
      var _activeMissionId = _activeMission ? String(_activeMission.id || '') : '';
      var allItems = typeof listCanonicalWorkItems === 'function'
        ? listCanonicalWorkItems({ status: 'done' })
        : (typeof flattenMissionWorkItems === 'function' ? flattenMissionWorkItems() : []);
      allItems.forEach(function (it) {
        if (String(it.status || '').toLowerCase() !== 'done') return;
        if (!mc2MatchesSelectedMission(it.missionId)) return;
        // Scope to active mission when no explicit selection
        if (_activeMissionId && String(it.missionId || '') !== _activeMissionId) return;
        items.push({
          kind: it.kind === 'turn' ? 'turn' : 'task',
          status: 'done',
          title: it.title,
          missionId: it.missionId,
          taskId: it.taskId,
          assignee: it.assignee,
          agentId: it.agentId,
          delegatedFrom: it.delegatedFrom,
          ts: Number(it.updatedAt || it.completedAt || it.turnTs) || 0,
          createdAt: Number(it.createdAt) || 0,
          startedAt: Number(it.startedAt) || 0,
          completedAt: Number(it.completedAt) || 0,
        });
      });
      items.sort(function (a, b) { return (Number(b.ts) || 0) - (Number(a.ts) || 0); });
      var seen = {};
      return items.filter(function (it) {
        var key = String(it.kind || '') + '|' + String(it.taskId || it.title || '') + '|' + String(it.agentId || '');
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      });
    }

    function mc2CollectKanbanProgressItems() {
      var agents = agentMapData || [];
      var ctxMap = teamAgentContextSnapshot.agents || {};
      var items = [];
      var allItems = typeof flattenMissionWorkItems === 'function' ? flattenMissionWorkItems() : [];
      var currentMission = typeof getCurrentMissionMission === 'function' ? getCurrentMissionMission() : null;
      if (currentMission &&
        typeof missionAwaitingUserDecision === 'function' &&
        missionAwaitingUserDecision(currentMission)) {
        return items;
      }
      var missionAgentIds = {};
      if (selectedTeamMissionId) {
        allItems.forEach(function (it) {
          if (String(it.missionId || '') === selectedTeamMissionId) {
            var aid = String(it.assignee || it.agentId || '');
            if (aid) missionAgentIds[aid] = true;
          }
        });
      }
      var doingAssignees = {};
      allItems.forEach(function (it) {
        if (String(it.status || '').toLowerCase() !== 'doing') return;
        if (!mc2MatchesSelectedMission(it.missionId)) return;
        var aid = String(it.assignee || it.agentId || '').trim();
        if (aid) doingAssignees[aid] = true;
        items.push({ kind: 'task', item: it });
      });
      agents.forEach(function (a) {
        var id = String(a.id || '');
        var ctx = ctxMap[id] || { state: 'idle' };
        var state = String(ctx.state || 'idle').toLowerCase();
        if (state !== 'working') return;
        if (selectedTeamMissionId && !missionAgentIds[id]) return;
        if (doingAssignees[id]) return;
        items.push({ kind: 'agent', a: a, ctx: ctx });
      });
      return items;
    }

    function mc2CollectKanbanOpenItems() {
      var allItems = typeof flattenMissionWorkItems === 'function' ? flattenMissionWorkItems() : [];
      var items = [];
      allItems.forEach(function (it) {
        var s = String(it.status || 'todo').toLowerCase();
        if (s === 'doing' || s === 'done' || s === 'blocked') return;
        if (!mc2MatchesSelectedMission(it.missionId)) return;
        items.push(it);
      });
      items.sort(function (a, b) { return (Number(a.updatedAt) || 0) - (Number(b.updatedAt) || 0); });
      return items;
    }

    function mc2CollectKanbanDiscoveryItems() {
      var suggestedTasks = Array.isArray(teamSuggestedTasksSnapshot.suggestedTasks) ? teamSuggestedTasksSnapshot.suggestedTasks.slice() : [];
      return suggestedTasks.filter(function (it) {
        if (!mc2ProposedSuggestedTaskNeedsApproval(it)) return false;
        if (selectedTeamMissionId) {
          var ids = Array.isArray(it.relatedMissionIds) ? it.relatedMissionIds : [];
          if (ids.indexOf(selectedTeamMissionId) < 0) return false;
        }
        return true;
      }).sort(function (a, b) {
        return (Number(b.confidence) || 0) - (Number(a.confidence) || 0);
      });
    }

    function mc2WireKanbanCol(col) {
      if (!col) return;
      col.querySelectorAll('.mc-kanban-card[data-mc-agent]').forEach(function (card) {
        card.addEventListener('click', function (e) {
          var ctxLink = e.target && e.target.closest ? e.target.closest('[data-mc-open-context]') : null;
          if (ctxLink) {
            e.preventDefault();
            e.stopPropagation();
            mc2SetAgentFilter(ctxLink.getAttribute('data-mc-agent') || card.getAttribute('data-mc-agent') || '', 'context');
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
      col.querySelectorAll('.mc-kanban-card[data-mc-kanban-kind="task"]').forEach(function (card) {
        card.addEventListener('click', function () {
          if (typeof mc2ShowMissionTaskDetails === 'function') mc2ShowMissionTaskDetails(card);
        });
      });
      col.querySelectorAll('.mc-kanban-card[data-mc-kanban-kind="discovery"]').forEach(function (card) {
        card.addEventListener('click', function () {
          var suggestedTaskId = card.getAttribute('data-suggestedTask-id') || '';
          if (suggestedTaskId) mc2OpenTaskForSuggestedTask(suggestedTaskId);
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

    var MC2_KANBAN_DISPLAY_LIMIT = 3;
    var mc2KanbanColExpanded = {
      attention: false,
      completed: false,
      progress: false,
      discoveries: false,
    };

    function mc2KanbanExpandHtml(key, hiddenCount, expanded, totalCount) {
      if (!expanded && hiddenCount > 0) {
        return '<button type="button" class="mc-kanban-expand" data-mc-kanban-expand="' + escapeHtml(key) + '">' +
          'Click to expand below for ' + hiddenCount + ' more</button>';
      }
      if (expanded && totalCount > MC2_KANBAN_DISPLAY_LIMIT) {
        return '<button type="button" class="mc-kanban-expand mc-kanban-collapse" data-mc-kanban-collapse="' + escapeHtml(key) + '">' +
          'Show less</button>';
      }
      return '';
    }

    function mc2WireKanbanExpand(col) {
      if (!col) return;
      col.querySelectorAll('[data-mc-kanban-expand]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          var key = btn.getAttribute('data-mc-kanban-expand') || '';
          if (key && Object.prototype.hasOwnProperty.call(mc2KanbanColExpanded, key)) {
            mc2KanbanColExpanded[key] = true;
            mc2RenderKanban();
          }
        });
      });
      col.querySelectorAll('[data-mc-kanban-collapse]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          var key = btn.getAttribute('data-mc-kanban-collapse') || '';
          if (key && Object.prototype.hasOwnProperty.call(mc2KanbanColExpanded, key)) {
            mc2KanbanColExpanded[key] = false;
            mc2RenderKanban();
          }
        });
      });
    }

    function mc2RenderKanbanCol(colId, countId, items, renderCard, emptyMsg, expandKey) {
      var col = mc2El(colId);
      var count = mc2El(countId);
      if (!col) return;
      var totalCount = Array.isArray(items) ? items.length : 0;
      if (count) count.textContent = String(totalCount);
      if (!totalCount) {
        col.innerHTML = '<p class="mc-kanban-empty">' + emptyMsg + '</p>';
        return;
      }
      var expanded = expandKey ? !!mc2KanbanColExpanded[expandKey] : false;
      var visibleCount = expanded ? totalCount : Math.min(MC2_KANBAN_DISPLAY_LIMIT, totalCount);
      var hiddenCount = totalCount - visibleCount;
      var html = items.slice(0, visibleCount).map(renderCard).join('') +
        mc2KanbanExpandHtml(expandKey || '', hiddenCount, expanded, totalCount);
      col.innerHTML = html;
      mc2WireKanbanCol(col);
      mc2WireKanbanExpand(col);
    }

    function mc2RenderKanban() {
      mc2RenderKanbanCol(
        'mc2-col-progress',
        'mc2-col-count-progress',
        mc2CollectKanbanProgressItems(),
        function (entry) {
          if (entry.kind === 'agent') return mc2KanbanCard(entry.a, entry.ctx);
          return mc2KanbanProgressTaskCard(entry.item);
        },
        'No active work',
        'progress'
      );
      mc2RenderKanbanCol(
        'mc2-col-open',
        'mc2-col-count-open',
        mc2CollectKanbanOpenItems(),
        mc2KanbanOpenTaskCard,
        'No open tasks',
        'open'
      );
      mc2RenderKanbanCol(
        'mc2-col-completed',
        'mc2-col-count-completed',
        mc2CollectKanbanCompletedItems(),
        mc2KanbanCompletedCard,
        'Nothing completed yet',
        'completed'
      );
      mc2RenderKanbanCol(
        'mc2-col-attention',
        'mc2-col-count-attention',
        mc2CollectKanbanAttentionItems(),
        mc2KanbanAttentionCard,
        'All clear',
        'attention'
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
          var selected = mc2InboxAgentFilter && id === mc2InboxAgentFilter ? ' selected' : '';
          return '<div class="mc-agent-overview-card' + selected + '" data-mc-agent="' + escapeHtml(id) + '">' +
            renderAgentCardMenuButton(id) +
            '<div class="mc-kanban-card-head">' +
              mc2AvatarHtml(a, { large: true }) +
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
        wireAgentCardMenus(el);
        el.querySelectorAll('.mc-agent-overview-card[data-mc-agent]').forEach(function (card) {
          card.addEventListener('click', function () {
            var aid = card.getAttribute('data-mc-agent');
            if (!aid) return;
            if (elId === 'mc2-agents-detail') {
              mc2SetAgentFilter(aid);
              return;
            }
            mc2OpenTaskDetailForAgent(aid);
          });
        });
      }
      render('mc2-agents-overview');
      render('mc2-agents-detail');
    }

    window.computeMc2HomeCounts = computeMc2HomeCounts;
    window.mc2FocusKanbanColumn = mc2FocusKanbanColumn;
