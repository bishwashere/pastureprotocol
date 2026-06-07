/* MC2 secondary views — activity, context, stats, missions, suggestedTasks, agents */
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
        if (item.missionId) attrs += ' data-mission-id="' + escapeHtml(item.missionId) + '"';
        if (item.taskId) attrs += ' data-task-id="' + escapeHtml(item.taskId) + '"';
        if (item.agentId) attrs += ' data-agent-id="' + escapeHtml(item.agentId) + '"';
        if (item.pendingId) attrs += ' data-pending-id="' + escapeHtml(item.pendingId) + '"';
        if (item.suggestedTaskId) attrs += ' data-suggestedTask-id="' + escapeHtml(item.suggestedTaskId) + '"';
        return '<button' + attrs + '>' +
          '<span class="mc-attention-icon">' + icon + '</span>' +
          '<span class="mc-attention-copy">' +
            '<span class="mc-attention-title">' + escapeHtml(item.title) +
              (item.tag ? ' ' + mc2AutoPromotedTagHtml('mc-attention-tag') : '') +
            '</span>' +
            (item.subtitle ? '<span class="mc-attention-sub">' + escapeHtml(item.subtitle) + '</span>' : '') +
          '</span>' +
        '</button>';
      }).join('');
    }

    function mc2MissionById(missionId) {
      var id = String(missionId || '').trim();
      if (!id) return null;
      return (Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : []).find(function (g) {
        return String(g.id || '') === id;
      }) || null;
    }

    function mc2HandleAttentionClick(btn) {
      if (!btn) return;
      var action = String(btn.getAttribute('data-attention-action') || '').trim();
      if (action === 'mission-input') {
        var missionId = btn.getAttribute('data-mission-id') || '';
        var taskId = btn.getAttribute('data-task-id') || '';
        if (taskId && typeof findMissionTaskItem === 'function') {
          var directTask = findMissionTaskItem({ missionId: missionId, taskId: taskId });
          if (directTask) {
            mc2OpenTaskDetail(directTask, { filter: 'blocked' });
            return;
          }
        }
        var blocked = typeof findBlockedWorkRefs === 'function' ? findBlockedWorkRefs() : [];
        var ref = null;
        var i;
        for (i = 0; i < blocked.length; i++) {
          if (blocked[i].missionId === missionId && blocked[i].kind === 'task') {
            ref = blocked[i];
            break;
          }
        }
        if (ref && typeof findMissionTaskItem === 'function') {
          var taskItem = findMissionTaskItem({
            missionId: ref.missionId,
            taskId: ref.taskId,
            title: ref.title,
          });
          if (taskItem) {
            mc2OpenTaskDetail(taskItem, { filter: 'blocked' });
            return;
          }
        }
        var mission = mc2MissionById(missionId);
        if (mission && typeof openTeamUserInputModal === 'function') {
          openTeamUserInputModal(mission);
          return;
        }
        mc2OpenTasksView('blocked');
        return;
      }
      if (action === 'mission') {
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
      if (action === 'suggestedTask-review') {
        var suggestedTaskId = btn.getAttribute('data-suggestedTask-id') || '';
        if (suggestedTaskId) mc2OpenTaskForSuggestedTask(suggestedTaskId);
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
      var el = mc2El('mc2-agents-' + direction + '-feed') || mc2El('mc2-agents-mailbox-feed') || mc2El('mc2-activity-feed');
      if (!el) return;
      var titleEl = mc2El('mc2-agents-mailbox-title') || mc2El('mc2-activity-title');
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
      mc2InboxAgentFilter = aid;
      mc2SyncAgentFilterControls();
      if (nextView) {
        if (nextView === 'context' || nextView === 'inbox' || nextView === 'outbox') {
          mc2SetView('agents');
          setTimeout(function () {
            var panel = mc2El('mc2-agents-panel-' + nextView);
            if (panel) {
              try { panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {}
            }
          }, 0);
        } else {
          mc2SetView(nextView);
        }
        return;
      }
      if (mc2ActiveView === 'activity' || mc2ActiveView === 'inbox' || mc2ActiveView === 'outbox') mc2RenderActivity();
      if (mc2ActiveView === 'context') mc2RenderContext();
      if (mc2ActiveView === 'agents') mc2RenderAgentsDetail();
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
        var hasLive = liveTs > 0 || ctx.state !== 'idle' || display.mission ||
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
      var el = mc2El('mc2-agents-context-list') || mc2El('mc2-context-list');
      if (!el) return;
      mc2SyncAgentFilterControls();
      var titleEl = mc2El('mc2-agents-context-title');
      var ids = mc2AgentIdsForFilter();
      if (!ids.length) {
        mc2TimelineSpyEnabled = false;
        if (titleEl) titleEl.textContent = 'ACTIVE CONTEXT';
        el.innerHTML = '<p class="team-agent-inbox-empty">No agents available.</p>';
        return;
      }
      var sections = mc2ContextSections();
      var label = mc2InboxAgentFilter ? agentNameById(mc2InboxAgentFilter) : 'all agents';
      if (titleEl) titleEl.textContent = mc2InboxAgentFilter ? ('ACTIVE CONTEXT — ' + label) : 'ACTIVE CONTEXT';
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
      document.querySelectorAll('#page-team .mc2-agent-filter-select').forEach(function (selectEl) {
        var isTasks = selectEl.id === 'mc2-tasks-agent-filter';
        var selected = isTasks ? mc2TasksAgentFilter : mc2InboxAgentFilter;
        var html = optionsHtml(selected);
        if (selectEl.innerHTML !== html) selectEl.innerHTML = html;
        if (selectEl.value !== selected) selectEl.value = selected;
      });
    }

    function mc2SetAgentsSubView(subView) {
      var next = String(subView || 'overview').trim();
      if (['overview', 'context', 'inbox', 'outbox'].indexOf(next) < 0) next = 'overview';
      mc2AgentsSubView = next;
      mc2ActiveView = 'agents';
      mc2RenderAgentsDetail();
      if (next !== 'overview') {
        setTimeout(function () {
          var panel = mc2El('mc2-agents-panel-' + next);
          if (panel) {
            try { panel.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (_) {}
          }
        }, 0);
      }
    }

    function mc2RenderAgentsSubApp() {
      mc2RenderContext();
      mc2RenderMailbox('inbox');
      mc2RenderMailbox('outbox');
    }

    function mc2ProjectNameById(projectId) {
      var pid = String(projectId || '').trim();
      if (!pid) return '';
      var match = (mc2ProjectsSnapshot || []).find(function (p) { return String(p.id || '') === pid; });
      return match ? String(match.name || '') : '';
    }

    async function mc2RenderMissions() {
      var el = mc2El('mc2-missions-list');
      if (!el) return;
      var api = window.pastureProjectsApi;
      if (api && typeof api.listProjects === 'function') {
        try {
          var projList = await api.listProjects();
          if (Array.isArray(projList)) mc2ProjectsSnapshot = projList;
        } catch (_) {}
      }
      var missions = Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : [];
      if (!missions.length) { el.innerHTML = '<p style="color:var(--muted);font-size:0.66rem;">No missions yet. Create one from the Team mission controls.</p>'; return; }
      var blockedRef = typeof findFirstBlockedWorkRef === 'function' ? findFirstBlockedWorkRef() : null;
      var detailMission = null;
      if (blockedRef && blockedRef.missionId) {
        detailMission = missions.find(function (g) { return String(g.id || '') === blockedRef.missionId; }) || null;
      }
      if (!detailMission && typeof getCurrentMissionMission === 'function') {
        detailMission = getCurrentMissionMission();
      }
      if (!detailMission && selectedTeamMissionId) {
        detailMission = missions.find(function (g) { return String(g.id || '') === selectedTeamMissionId; }) || null;
      }
      if (!detailMission && missions.length) detailMission = missions[0];
      if (detailMission) selectedTeamMissionId = String(detailMission.id || '');
      if (typeof renderMissionDetail === 'function') {
        renderMissionDetail(detailMission, mc2El('mc2-mission-detail'));
      }
      el.innerHTML = missions.map(function (g) {
        var id = String(g.id || '');
        var status = String(g.status || 'active').toLowerCase();
        var pct = Math.max(0, Math.min(100, Math.round(Number((g.progress && g.progress.pct) || 0))));
        var subs = Array.isArray(g.tasks) ? g.tasks : [];
        var doneSubs = subs.filter(function (s) { return String(s.status || '').toLowerCase() === 'done'; }).length;
        var selected = id === selectedTeamMissionId ? ' selected' : '';
        var projectName = mc2ProjectNameById(g.projectId);
        var projectLine = projectName
          ? '<div class="mc-progress-meta">Project: <button type="button" class="mc-panel-link" data-mc-nav="projects" data-project-id="' + escapeHtml(String(g.projectId || '')) + '">' + escapeHtml(projectName) + '</button></div>'
          : '';
        var toggleLabel = status === 'active' ? 'Pause' : (status === 'paused' ? 'Resume' : 'Activate');
        return '<div class="mc-progress-card mc-mission-select-card' + selected + '" data-mission-id="' + escapeHtml(id) + '" style="cursor:pointer;">' +
          '<div class="mc-progress-head">' +
            '<h3>' + escapeHtml(String(g.title || g.objective || 'Untitled mission')) + '</h3>' +
            '<span class="team-mission-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' +
          '</div>' +
          '<div class="mc-progress-bar"><span style="width:' + pct + '%"></span></div>' +
          '<div class="mc-progress-meta">' + pct + '% · Owner: ' + escapeHtml(missionOwnerLabel(g)) +
            (subs.length ? ' · ' + doneSubs + '/' + subs.length + ' tasks' : '') + '</div>' +
          projectLine +
          '<div class="team-suggestedTask-actions" style="margin-top:0.35rem;">' +
            '<button type="button" class="secondary mc-mission-card-btn" data-mc-mission-action="run" data-mission-id="' + escapeHtml(id) + '">Run</button>' +
            '<button type="button" class="secondary mc-mission-card-btn" data-mc-mission-action="toggle" data-mission-id="' + escapeHtml(id) + '">' + escapeHtml(toggleLabel) + '</button>' +
          '</div>' +
        '</div>';
      }).join('');
      el.querySelectorAll('.mc-mission-select-card[data-mission-id]').forEach(function (card) {
        if (card._wiredSelect) return;
        card._wiredSelect = true;
        card.addEventListener('click', function (e) {
          if (e.target && e.target.closest && e.target.closest('[data-mc-mission-action], [data-mc-nav], .mc-panel-link')) return;
          var gid = card.getAttribute('data-mission-id') || '';
          if (!gid) return;
          selectedTeamMissionId = gid;
          mc2RenderMissions();
        });
      });
      el.querySelectorAll('[data-mc-mission-action]').forEach(function (btn) {
        if (btn._wiredMissionMission) return;
        btn._wiredMissionMission = true;
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (typeof runMissionMissionAction === 'function') {
            runMissionMissionAction(btn.getAttribute('data-mission-id'), btn.getAttribute('data-mc-mission-action'));
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

    function mc2RenderSuggestedTasks() {
      if (typeof renderSuggestedTasksPanels === 'function') renderSuggestedTasksPanels();
    }

    function mc2RenderAgentsDetail() {
      mc2RenderAgentsOverview();
      mc2RenderAgentsSubApp();
    }
