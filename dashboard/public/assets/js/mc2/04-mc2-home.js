/* MC2 Home page — mission progress, kanban, movement, attention (live refresh) */
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
