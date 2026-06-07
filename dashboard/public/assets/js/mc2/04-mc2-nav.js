/* MC2 navigation, view switching, projects sidebar, timeline scroll */
    function mc2SetView(view) {
      mc2ActiveView = view;
      var visibleView = (view === 'inbox' || view === 'outbox') ? 'activity' : view;
      ['mission', 'agents', 'tasks', 'context', 'missions', 'projects', 'activity', 'stats'].forEach(function (v) {
        var el = mc2El('mc2-view-' + v);
        if (el) el.hidden = v !== visibleView;
      });
      document.querySelectorAll('#page-team2 .mc-nav-item[data-mc-nav]').forEach(function (btn) {
        var nav = btn.getAttribute('data-mc-nav');
        btn.classList.toggle('active', nav === view);
      });
      if (visibleView === 'activity') mc2RenderActivity();
      if (view === 'missions') mc2RenderMissions();
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
      var api = window.pastureProjectsApi;
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
      var api = window.pastureProjectsApi;
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
