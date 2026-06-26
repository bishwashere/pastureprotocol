const API = '';
    var validPages = ['home', 'chat', 'brain', 'crons', 'skills', 'groups', 'config', 'memory', 'test', 'team', 'team-agent'];
    var IDENTITY_FILE_ORDER = ['SOUL.md', 'WhoAmI.md', 'MyHuman.md', 'group.md'];
    var IDENTITY_FILE_LABELS = {
      'SOUL.md': 'Soul',
      'WhoAmI.md': 'Who am I',
      'MyHuman.md': 'My human',
      'group.md': 'Group rules',
      'MEMORY.md': 'Memory',
    };
    var AGENT_IDENTITY_FILE_ORDER = ['SOUL.md', 'WhoAmI.md', 'MyHuman.md', 'group.md', 'MEMORY.md'];
    var tideChecklistCache = null;
    var TEAM_ACTIVITY_POLL_MS = 1200;
    var TEAM_ACTIVITY_MAX_ITEMS = 120;
    var teamActivityEvents = [];
    var teamActivityEventIds = {};
    var teamActivityLastTs = 0;
    var teamActivityPollTimer = null;
    var selectedTeamInboxAgentId = '';
    var teamAgentPanelRange = 'today';
    var teamTopTab = 'roster';
    var teamViewMode = 'cards';
    var teamViewActiveOnly = false;
    var teamAgentContextSnapshot = { agents: {}, updatedAt: 0 };
    var teamAgentMetricsSnapshot = { agents: {}, updatedAt: 0 };
    var teamMissionsSnapshot = { missions: [], updatedAt: 0 };
    var mc2PendingSnapshot = { pending: [], updatedAt: 0 };
    var teamSuggestedTasksSnapshot = { suggestedTasks: [], updatedAt: 0 };

    function wireClick(id, handler) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('click', handler);
    }

    function wireEl(id, type, handler, options) {
      var el = document.getElementById(id);
      if (!el) return false;
      el.addEventListener(type, handler, options);
      return true;
    }

    function dashboardRouteFromPath() {
      try {
        var p = parsePath();
        if (p.name === 'team' && p.mc2View === 'projects') {
          var path = (location.pathname || '').replace(/^\//, '').replace(/\/$/, '');
          if (path === 'projects') {
            try { history.replaceState(null, '', '/team/projects'); } catch (_) {}
          }
        }
        if (p.name === 'config') {
          var configPath = (location.pathname || '').replace(/^\//, '').replace(/\/$/, '');
          if (configPath === 'tide' || configPath === 'llm') {
            try { history.replaceState(null, '', '/config'); } catch (_) {}
          }
        }
        setPage(p.name, p.memoryFile, p.openIdentity, p.teamAgentId, p.mc2View);
      } catch (err) {
        console.error('[dashboard] route failed:', err);
        setPage('home');
      }
    }
    var dashboardRouteFromHash = dashboardRouteFromPath;
    var selectedTeamMissionId = '';
    var selectedTeamSuggestedTaskId = '';
    var teamPageFullscreen = false;
    function isMemoryNotesFile(id) {
      return id === 'MEMORY.md';
    }
    function isMemoryChatLogFile(id) {
      return id && (id.indexOf('chat-log/') === 0 || id.indexOf('group-chat-log/') === 0);
    }
    function isMemoryChatDayFile(id) {
      return id && id.indexOf('chat-log/day/') === 0;
    }
    function isMemoryWorkspaceFile(id) {
      return isMemoryNotesFile(id) || isMemoryChatLogFile(id);
    }
    function pageIdForRoute(routeName) {
      if (routeName === 'team') return 'team';
      return routeName;
    }
    function setPage(name, memoryFileId, openIdentityFileId, teamAgentId, mc2View) {
      if (name === 'chat' || name === 'status') name = 'home';
      if (!name || !validPages.includes(name)) name = 'home';
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('nav a').forEach(a => a.classList.remove('active'));
      var pageId = pageIdForRoute(name);
      var page = document.getElementById('page-' + pageId);
      var link = document.querySelector('nav a[data-page="' + name + '"]');
      if (page) page.classList.add('active');
      if (link) link.classList.add('active');
      document.body.classList.toggle('dashboard-home-active', name === 'home');
      document.body.classList.toggle('dashboard-team-active', pageId === 'team');
      if (name === 'crons') fetchCrons();
      if (name === 'skills') fetchSkills();
      if (name === 'brain' && typeof fetchBrainCloud === 'function') fetchBrainCloud();
      if (name === 'groups') fetchGroups();
      if (name === 'home') {
        fetchStatus();
        if (typeof fetchChatAgents === 'function') fetchChatAgents();
        if (typeof renderHomeIdentityTiles === 'function') renderHomeIdentityTiles();
      }
      if (pageId === 'team') {
        if (typeof startTeamActivityFeed === 'function') startTeamActivityFeed();
        fetchAgentMapData().then(function () {
          if (teamAgentId) {
            selectTeamInboxAgent(teamAgentId);
            openAgentEditModal(teamAgentId);
          }
          renderMissionControl();
          fetchMc2PendingApprovals();
          if (mc2View && typeof mc2SetView === 'function') {
            mc2SetView(mc2View, true);
          }
        });
      } else {
        if (typeof stopTeamActivityFeed === 'function') stopTeamActivityFeed();
        if (typeof setTeamPageFullscreen === 'function') setTeamPageFullscreen(false);
      }
      if (name === 'config') fetchConfig();
      if (name === 'test') fetchTests();
      if (name === 'memory') {
        fetchMemoryFiles().then(function () {
          if (memoryFileId) selectMemoryFile(memoryFileId, isMemoryChatLogFile(memoryFileId));
        });
      }
      if (openIdentityFileId) openIdentityEditor(openIdentityFileId);
    }
    var MC2_VIEW_ROUTES = ['home', 'mission', 'tasks', 'agents', 'projects', 'activity', 'missions', 'context', 'inbox', 'outbox'];
    function parsePath() {
      var raw = (location.pathname || '/home').replace(/^\//, '') || 'home';
      var slash = raw.indexOf('/');
      var name = slash >= 0 ? raw.slice(0, slash) : raw;
      var subFile = slash >= 0 ? raw.slice(slash + 1) : null;
      if (name === 'chat' || name === 'status') name = 'home';
      if (name === 'agents') name = 'team';
      if (name === 'projects') {
        return { name: 'team', memoryFile: null, openIdentity: null, teamAgentId: null, mc2View: 'projects' };
      }
      if (name === 'tide' || name === 'llm') {
        return { name: 'config', memoryFile: null, openIdentity: null, teamAgentId: null };
      }
      if (name === 'team' || name === 'team') {
        if (subFile) {
          var decodedSub = decodeURIComponent(subFile);
          if (MC2_VIEW_ROUTES.indexOf(decodedSub) >= 0) {
            var mc2View = decodedSub === 'home' ? 'mission' : decodedSub;
            return { name: 'team', memoryFile: null, openIdentity: null, teamAgentId: null, mc2View: mc2View };
          }
          return { name: 'team', memoryFile: null, openIdentity: null, teamAgentId: decodedSub, mc2View: null };
        }
        return { name: 'team', memoryFile: null, openIdentity: null, teamAgentId: null, mc2View: null };
      }
      if (name === 'team-agent') {
        return {
          name: 'team',
          memoryFile: null,
          openIdentity: null,
          teamAgentId: subFile ? decodeURIComponent(subFile) : null,
        };
      }
      if (name === 'soul') {
        if (!subFile || subFile === 'SOUL.md') {
          return { name: 'home', memoryFile: null, openIdentity: 'SOUL.md', teamAgentId: null };
        }
        if (isMemoryWorkspaceFile(subFile)) {
          return { name: 'memory', memoryFile: subFile, openIdentity: null, teamAgentId: null };
        }
        if (IDENTITY_FILE_LABELS[subFile]) {
          return { name: 'home', memoryFile: null, openIdentity: subFile, teamAgentId: null };
        }
        return { name: 'memory', memoryFile: subFile, openIdentity: null, teamAgentId: null };
      }
      if (name === 'memory') {
        return { name: 'memory', memoryFile: subFile, openIdentity: null, teamAgentId: null };
      }
      return { name: name, memoryFile: null, openIdentity: null, teamAgentId: null };
    }
    document.querySelectorAll('nav a[data-page]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        history.pushState(null, '', '/' + a.dataset.page);
        dashboardRouteFromPath();
      });
    });
    window.addEventListener('popstate', function () {
      dashboardRouteFromPath();
    });

    function buildStatusLine(data) {
      var parts = [];
      if (data && data.daemonRunning) parts.push('Daemon is running');
      else parts.push('Daemon is not running');
      if (data && data.dashboardUrl) parts.push('Dashboard: ' + data.dashboardUrl);
      if (data && data.stateDir) parts.push('Pasture: ' + data.stateDir);
      return parts.join(' | ');
    }
    function setDaemonStatus(data) {
      var dot = document.getElementById('chat-status-dot');
      var text = document.getElementById('chat-status-text');
      var running = !!(data && data.daemonRunning);
      var cls = running ? 'status-dot running' : 'status-dot stopped';
      if (dot) dot.className = cls;
      if (text) text.textContent = buildStatusLine(data || {});
    }
    async function fetchStatus() {
      try {
        const statusRes = await fetch(API + '/api/status');
        const statusData = await statusRes.json();
        setDaemonStatus(statusData);
      } catch (e) {
        setDaemonStatus({ daemonRunning: false });
      }
      function formatUptime(sec) {
        if (sec == null || typeof sec !== 'number' || sec < 0) return '—';
        const d = Math.floor(sec / 86400);
        const h = Math.floor((sec % 86400) / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = sec % 60;
        const parts = [];
        if (d > 0) parts.push(d + 'd');
        if (h > 0) parts.push(h + 'h');
        if (m > 0) parts.push(m + 'm');
        if (s > 0 || parts.length === 0) parts.push(s + 's');
        return parts.join(' ');
      }
      function setOverview(d) {
        var fields = [
          ['chat-overview-uptime', d.daemonRunning && d.daemonUptimeSeconds != null ? formatUptime(d.daemonUptimeSeconds) : '—'],
          ['chat-overview-crons', typeof d.cronCount === 'number' ? d.cronCount : '—'],
          ['chat-overview-skills', typeof d.skillsEnabledCount === 'number' ? d.skillsEnabledCount : '—'],
          ['chat-overview-model', d.priorityModelLabel || '—'],
          ['chat-overview-timezone', d.timezone || '—'],
          ['chat-overview-time-format', d.timeFormat === '12' ? '12-hour' : d.timeFormat === '24' ? '24-hour' : (d.timeFormat || '—')],
        ];
        var groupVal;
        if (typeof d.groupSkillsDeniedCount === 'number') groupVal = d.groupSkillsDeniedCount + ' denied';
        else if (typeof d.groupSkillsEnabledCount === 'number') groupVal = d.groupSkillsEnabledCount;
        else groupVal = '—';
        fields.push(['chat-overview-group-skills', groupVal]);
        fields.forEach(function (pair) {
          var el = document.getElementById(pair[0]);
          if (el) el.textContent = pair[1];
        });
      }
      try {
        const overviewRes = await fetch(API + '/api/overview');
        if (overviewRes.ok) {
          const d = await overviewRes.json();
          setDaemonStatus(d);
          setOverview(d);
          return;
        }
      } catch (_) {}
      try {
        const [cronsRes, skillsRes, groupSkillsRes, groupConfigRes, configRes] = await Promise.all([
          fetch(API + '/api/crons'),
          fetch(API + '/api/skills'),
          fetch(API + '/api/group/skills'),
          fetch(API + '/api/groups/default/config'),
          fetch(API + '/api/config')
        ]);
        const crons = cronsRes.ok ? await cronsRes.json() : {};
        const skills = skillsRes.ok ? await skillsRes.json() : {};
        const groupSkills = groupSkillsRes.ok ? await groupSkillsRes.json() : {};
        const groupConfig = groupConfigRes.ok ? await groupConfigRes.json() : {};
        const config = configRes.ok ? await configRes.json() : {};
        const jobs = crons.jobs || [];
        const cronCount = jobs.filter(function (j) { return j.enabled !== false; }).length;
        const skillsEnabled = skills.enabled || [];
        const groupSkillsEnabled = groupSkills.enabled || [];
        const groupSkillsDenied = Array.isArray(groupConfig.skillsDeny) ? groupConfig.skillsDeny : [];
        const models = config.llm && Array.isArray(config.llm.models) ? config.llm.models : [];
        const priorityEntry = models.find(function (m) { return m.priority === true || m.priority === 1 || String(m.priority).toLowerCase() === 'true'; }) || models[0];
        const priorityModelLabel = priorityEntry ? (priorityEntry.model || priorityEntry.provider || '—') : '—';
        const def = config.agents && config.agents.defaults ? config.agents.defaults : {};
        const tz = def.userTimezone && String(def.userTimezone).trim() && String(def.userTimezone).toLowerCase() !== 'auto' ? def.userTimezone : (typeof Intl !== 'undefined' && Intl.DateTimeFormat && Intl.DateTimeFormat().resolvedOptions ? Intl.DateTimeFormat().resolvedOptions().timeZone : 'UTC');
        const fmt = def.timeFormat === '12' || def.timeFormat === '24' ? def.timeFormat : null;
        setOverview({
          daemonRunning: false,
          daemonUptimeSeconds: null,
          cronCount: cronCount,
          skillsEnabledCount: skillsEnabled.length,
          groupSkillsEnabledCount: groupSkillsEnabled.length,
          groupSkillsDeniedCount: groupSkillsDenied.length,
          priorityModelLabel: priorityModelLabel,
          timezone: tz,
          timeFormat: fmt || '—'
        });
      } catch (_) {}
    }

    function dashboardBoot() {
      fetchStatus();
      if (!window._pastureDashboardStatusPoll) {
        window._pastureDashboardStatusPoll = setInterval(fetchStatus, 8000);
      }
      if (typeof renderHomeIdentityTiles === 'function') renderHomeIdentityTiles();
    }
    dashboardBoot();
