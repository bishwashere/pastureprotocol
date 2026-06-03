// ── Chat session persistence ──────────────────────────────────────────
    var SESSIONS_KEY = 'cowcode_chat_sessions_v1';
    var MAX_SESSIONS = 20;

    function loadAllSessions() {
      try { return JSON.parse(localStorage.getItem(SESSIONS_KEY) || '[]'); } catch (_) { return []; }
    }
    function saveAllSessions(arr) {
      try { localStorage.setItem(SESSIONS_KEY, JSON.stringify(arr)); } catch (_) {}
    }
    function getSessionsForAgent(agentId) {
      return loadAllSessions().filter(function (s) { return s.agentId === agentId; });
    }
    function upsertSession(session) {
      var all = loadAllSessions();
      var idx = all.findIndex(function (s) { return s.id === session.id; });
      if (idx >= 0) { all[idx] = session; } else { all.unshift(session); }
      all.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
      saveAllSessions(all.slice(0, MAX_SESSIONS));
    }
    function deleteSessionById(id) {
      saveAllSessions(loadAllSessions().filter(function (s) { return s.id !== id; }));
    }
    function formatSessionTime(ts) {
      if (!ts) return '';
      var d = new Date(ts), now = new Date();
      var diff = Math.floor((now - d) / 1000);
      if (diff < 60) return 'just now';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
      return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
    }

    var selectedChatAgentId = 'main';
    var chatMessages = [];
    var chatMessagesByAgent = {};
    var chatLoading = false;
    var chatStreamActive = false;
    var chatAbortController = null;
    var currentSessionId = null;

    function newSessionId() { return 'cs-' + Date.now(); }

    function saveCurrentSession() {
      if (!currentSessionId) return;
      var msgs = chatMessagesByAgent[selectedChatAgentId] || [];
      var userMsgs = msgs.filter(function (m) { return m.role === 'user'; });
      if (!userMsgs.length) return;
      var title = userMsgs[0].content.length > 72 ? userMsgs[0].content.slice(0, 72) + '…' : userMsgs[0].content;
      upsertSession({ id: currentSessionId, agentId: selectedChatAgentId, title: title, messages: msgs, updatedAt: Date.now() });
    }

    function renderHistoryPanel() {
      var panel = document.getElementById('chat-history-panel');
      if (!panel) return;
      var sessions = getSessionsForAgent(selectedChatAgentId);
      if (!sessions.length) {
        panel.innerHTML = '<div class="chat-history-empty">No history yet for this agent.</div>';
        return;
      }
      panel.innerHTML = sessions.map(function (s) {
        var sid = escapeHtml(s.id);
        var title = escapeHtml(s.title || '(no title)');
        var ago = escapeHtml(formatSessionTime(s.updatedAt));
        var count = s.messages ? Math.floor(s.messages.filter(function (m) { return m.role === 'user'; }).length) : 0;
        return '<div class="chat-history-item" data-sid="' + sid + '">' +
          '<div class="chat-history-item-text">' +
            '<div class="chat-history-item-title">' + title + '</div>' +
            '<div class="chat-history-item-meta">' + count + ' message' + (count !== 1 ? 's' : '') + ' · ' + ago + '</div>' +
          '</div>' +
          '<button type="button" class="chat-history-delete" data-del="' + sid + '" title="Delete">✕</button>' +
        '</div>';
      }).join('');
      panel.querySelectorAll('.chat-history-item').forEach(function (item) {
        item.addEventListener('click', function (e) {
          if (e.target.closest('.chat-history-delete')) return;
          var sid = item.getAttribute('data-sid');
          restoreSession(sid);
          closeChatHistory();
        });
      });
      panel.querySelectorAll('.chat-history-delete').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var sid = btn.getAttribute('data-del');
          deleteSessionById(sid);
          if (currentSessionId === sid) {
            currentSessionId = newSessionId();
            chatMessages = [];
            chatMessagesByAgent[selectedChatAgentId] = [];
            renderChatMessages();
          }
          renderHistoryPanel();
        });
      });
    }

    function restoreSession(sid) {
      var all = loadAllSessions();
      var session = all.find(function (s) { return s.id === sid; });
      if (!session) return;
      saveCurrentSession();
      currentSessionId = session.id;
      chatMessages = (session.messages || []).slice();
      chatMessagesByAgent[selectedChatAgentId] = chatMessages;
      renderChatMessages();
    }

    function openChatHistory() {
      renderHistoryPanel();
      var panel = document.getElementById('chat-history-panel');
      if (panel) panel.classList.add('open');
    }
    function closeChatHistory() {
      var panel = document.getElementById('chat-history-panel');
      if (panel) panel.classList.remove('open');
    }
    function toggleChatHistory() {
      var panel = document.getElementById('chat-history-panel');
      if (!panel) return;
      if (panel.classList.contains('open')) { closeChatHistory(); } else { openChatHistory(); }
    }
    // ─────────────────────────────────────────────────────────────────────

    function syncChatSendButton() {
      var btn = document.getElementById('chat-send');
      if (!btn) return;
      if (chatLoading) {
        btn.classList.add('chat-btn-stop');
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>';
        btn.setAttribute('aria-label', 'Stop');
        btn.title = 'Stop';
      } else {
        btn.classList.remove('chat-btn-stop');
        btn.textContent = 'Send';
        btn.removeAttribute('aria-label');
        btn.title = '';
      }
    }

    var agentMapData = [];
    var agentMapLastLayouts = {};
    var AGENT_MAP_PREFIXES = [
      { prefix: 'agent-map', mode: 'chat' },
      { prefix: 'team-map', mode: 'edit-page' },
    ];

    function agentMapEls(prefix) {
      return {
        canvas: document.getElementById(prefix + '-canvas'),
        scaler: document.getElementById(prefix + '-scaler'),
        inner: document.getElementById(prefix + '-canvas-inner'),
        arrows: document.getElementById(prefix + '-arrows'),
        nodes: document.getElementById(prefix + '-nodes'),
      };
    }

    function updateAgentMapSelection() {
      document.querySelectorAll('.agent-map-node').forEach(function (n) {
        n.classList.toggle('selected', n.getAttribute('data-agent-id') === selectedChatAgentId);
      });
    }

    // Tree layout constants
    var T_NODE_W = 132;   // card width
    var T_NODE_H = 96;    // fallback card height (measured after render)
    var T_H_GAP  = 20;    // horizontal gap between siblings
    var T_V_GAP  = 52;    // vertical gap root→children
    var T_PAD_X  = 16;    // horizontal canvas padding
    var T_PAD_Y  = 10;    // vertical canvas padding

    function measureAgentNodeHeight(nodesEl) {
      var maxH = T_NODE_H;
      if (!nodesEl) return maxH;
      nodesEl.querySelectorAll('.agent-map-node').forEach(function (n) {
        var h = n.offsetHeight || 0;
        if (h > maxH) maxH = h;
      });
      return maxH;
    }

    function agentTreeLayout(agents, nodeH) {
      var nh = nodeH || T_NODE_H;
      var root = agents.find(function(a) { return a.id === 'main'; }) || agents[0];
      var others = agents.filter(function(a) { return a !== root; });
      var n = others.length;
      var rowW = n > 0 ? n * T_NODE_W + (n - 1) * T_H_GAP : 0;
      var canvasW = Math.max(rowW, T_NODE_W) + T_PAD_X * 2;
      var canvasH = T_PAD_Y + nh + (n > 0 ? T_V_GAP + nh : 0) + T_PAD_Y;
      var positions = {};
      // Root centered
      positions[root.id] = { x: (canvasW - T_NODE_W) / 2, y: T_PAD_Y };
      // Children evenly spread
      var startX = (canvasW - rowW) / 2;
      others.forEach(function(a, i) {
        positions[a.id] = { x: startX + i * (T_NODE_W + T_H_GAP), y: T_PAD_Y + nh + T_V_GAP };
      });
      return { positions: positions, canvasW: canvasW, canvasH: canvasH, nodeH: nh, root: root, others: others };
    }

    function applyAgentMapLayout(layout, els) {
      if (!els || !els.inner || !layout) return;
      els.inner.style.width = layout.canvasW + 'px';
      els.inner.style.height = layout.canvasH + 'px';
      if (els.scaler) {
        els.scaler.style.width = layout.canvasW + 'px';
        els.scaler.style.height = layout.canvasH + 'px';
      }
    }

    function repositionAgentMapNodes(nodesEl, layout) {
      if (!nodesEl || !layout) return;
      var nh = layout.nodeH || T_NODE_H;
      nodesEl.querySelectorAll('.agent-map-node').forEach(function (node) {
        var id = node.getAttribute('data-agent-id');
        var pos = layout.positions[id];
        if (!pos) return;
        node.style.left = pos.x + 'px';
        node.style.top = pos.y + 'px';
      });
    }

    function fitAgentMapToContainer(prefix) {
      var els = agentMapEls(prefix);
      var layout = agentMapLastLayouts[prefix];
      if (!els.canvas || !els.scaler || !els.inner || !layout) return;
      var availW = els.canvas.clientWidth;
      var availH = els.canvas.clientHeight;
      if (availW < 1 || availH < 1) return;
      var scale = Math.min(1, availW / layout.canvasW, availH / layout.canvasH);
      els.inner.style.transform = 'scale(' + scale + ')';
      els.scaler.style.width = Math.ceil(layout.canvasW * scale) + 'px';
      els.scaler.style.height = Math.ceil(layout.canvasH * scale) + 'px';
      els.inner.style.width = layout.canvasW + 'px';
      els.inner.style.height = layout.canvasH + 'px';
    }

    function buildInboundLinks(agents) {
      var inbound = {};
      (agents || []).forEach(function(a) {
        var allow = Array.isArray(a.agentMessaging && a.agentMessaging.allow) ? a.agentMessaging.allow : [];
        allow.forEach(function(target) {
          if (!(agents || []).some(function(x) { return x.id === target; })) return;
          if (!inbound[target]) inbound[target] = [];
          if (inbound[target].indexOf(a.id) === -1) inbound[target].push(a.id);
        });
      });
      return inbound;
    }

    function drawAgentMapArrows(agents, layout, els, markerPrefix) {
      if (!els) els = agentMapEls('agent-map');
      markerPrefix = markerPrefix || 'agent';
      if (!els.arrows || !els.inner || !layout) { if (els.arrows) els.arrows.innerHTML = ''; return; }
      var w = layout.canvasW;
      var h = layout.canvasH;
      els.arrows.setAttribute('width', String(w));
      els.arrows.setAttribute('height', String(h));
      els.arrows.setAttribute('viewBox', '0 0 ' + w + ' ' + h);

      var nh = layout.nodeH || T_NODE_H;
      var defs = '<defs>' +
        '<marker id="' + markerPrefix + '-arrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">' +
          '<polygon points="0 0, 7 3, 0 6" fill="#a78bfa" opacity="0.8"/>' +
        '</marker>' +
        '<marker id="' + markerPrefix + '-tree-arrowhead" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto">' +
          '<polygon points="0 0, 7 3, 0 6" fill="#71717a" opacity="0.95"/>' +
        '</marker>' +
        '<marker id="' + markerPrefix + '-reply-arrowhead" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">' +
          '<polygon points="0 0, 6 3, 0 6" fill="#22c55e" opacity="0.55"/>' +
        '</marker>' +
      '</defs>';
      var shapes = [];

      // Outbound delegation (purple) + reply return (green). No grey org-tree connectors.
      (agents || []).forEach(function(a) {
        var allow = Array.isArray(a.agentMessaging && a.agentMessaging.allow) ? a.agentMessaging.allow : [];
        if (!allow.length) return;
        allow.forEach(function(target) {
          if (!(agents || []).some(function(x) { return x.id === target; })) return;
          var fp = layout.positions[a.id];
          var tp = layout.positions[target];
          if (!fp || !tp) return;
          var fx = fp.x + T_NODE_W / 2, fy = fp.y + nh / 2;
          var tx = tp.x + T_NODE_W / 2, ty = tp.y + nh / 2;
          var cx = (fx + tx) / 2, cy = Math.min(fy, ty) - 28;
          shapes.push('<path d="M' + fx + ',' + fy + ' Q' + cx + ',' + cy + ' ' + tx + ',' + ty + '" class="agent-map-arrow-line" marker-end="url(#' + markerPrefix + '-arrowhead)"/>');
          var rcx = (fx + tx) / 2, rcy = Math.max(fy, ty) + 34;
          shapes.push('<path d="M' + tx + ',' + ty + ' Q' + rcx + ',' + rcy + ' ' + fx + ',' + fy + '" class="agent-map-reply-line" marker-end="url(#' + markerPrefix + '-reply-arrowhead)"/>');
        });
      });

      els.arrows.innerHTML = defs + shapes.join('');
    }

    function renderAgentMapForPrefix(mapConfig) {
      var prefix = mapConfig.prefix;
      var mode = mapConfig.mode || 'chat';
      var els = agentMapEls(prefix);
      if (!els.nodes || !els.inner) return;
      var agents = agentMapData || [];
      var markerPrefix = prefix === 'agent-map' ? 'agent' : 'team';
      if (mode === 'edit-page') agents = getTeamAgentsForView(agents);
      if (!agents.length) {
        els.nodes.innerHTML = '';
        agentMapLastLayouts[prefix] = null;
        els.inner.style.height = '3rem';
        els.inner.style.transform = '';
        if (els.scaler) { els.scaler.style.width = ''; els.scaler.style.height = ''; }
        if (els.arrows) els.arrows.innerHTML = '';
        return;
      }

      var layout = agentTreeLayout(agents);
      applyAgentMapLayout(layout, els);
      var inboundLinks = buildInboundLinks(agents);

      els.nodes.innerHTML = agents.map(function(a) {
        var pos = layout.positions[a.id] || { x: 0, y: 0 };
        var id = escapeHtml(a.id);
        var rawTitle = (a.title && String(a.title).trim()) ? String(a.title).trim() : '';
        var titleHtml = rawTitle
          ? '<div class="agent-map-node-title">' + escapeHtml(rawTitle) + '</div><div class="agent-map-node-id-sub">' + id + '</div>'
          : '<div class="agent-map-node-id">' + id + '</div>';
        var skillCount = Array.isArray(a.skillsEnabled) ? a.skillsEnabled.length : 0;
        var isMain = a.id === 'main';
        var meta = mode === 'edit-page'
          ? (skillCount + ' skill' + (skillCount === 1 ? '' : 's'))
          : (skillCount + ' skill' + (skillCount === 1 ? '' : 's') + ' · ' + (isMain ? 'root' : 'agent'));
        var stateHtml = renderAgentMapStateHtml(a.id, mode);
        var selectedId = mode === 'edit-page' ? selectedTeamInboxAgentId : selectedChatAgentId;
        var sel = a.id === selectedId ? ' selected' : '';
        var chatLabel = rawTitle ? rawTitle + ' (' + a.id + ')' : a.id;
        var fromIds = inboundLinks[a.id] || [];
        var inboundHtml = fromIds.length
          ? '<div class="agent-map-node-inbound" title="Receives delegation from ' + escapeHtml(fromIds.join(', ')) + '">← ' + escapeHtml(fromIds.join(', ')) + '</div>'
          : '';
        var inboundClass = fromIds.length ? ' agent-map-node-has-inbound' : '';
        var nodeTitle = mode === 'edit-page'
          ? 'Open inbox for ' + escapeHtml(chatLabel)
          : 'Chat with ' + escapeHtml(chatLabel);
        return '<div class="agent-map-node' + sel + inboundClass + '" data-agent-id="' + id + '" role="button" tabindex="0"' +
          ' title="' + nodeTitle + '"' +
          ' style="left:' + pos.x + 'px; top:' + pos.y + 'px;">' +
          '<button type="button" class="agent-map-node-edit" data-agent-id="' + id + '" aria-label="Edit ' + id + '" title="Edit agent">✎</button>' +
          titleHtml +
          inboundHtml +
          stateHtml +
          '<div class="agent-map-node-meta">' + escapeHtml(meta) + '</div></div>';
      }).join('');

      els.nodes.querySelectorAll('.agent-map-node-edit').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var aid = btn.getAttribute('data-agent-id');
          if (!aid) return;
          openAgentEditModal(aid);
        });
      });
      els.nodes.querySelectorAll('.agent-map-node').forEach(function(node) {
        function pick() {
          var id = node.getAttribute('data-agent-id');
          if (!id) return;
          if (mode === 'edit-page') {
            selectTeamInboxAgent(id);
            return;
          }
          var sel = document.getElementById('chat-agent-select');
          if (sel) sel.value = id;
          setChatAgent(id);
          updateAgentMapSelection();
        }
        node.addEventListener('click', pick);
        node.addEventListener('keydown', function(e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
        });
      });

      var measuredH = measureAgentNodeHeight(els.nodes);
      if (Math.abs(measuredH - layout.nodeH) > 2) {
        layout = agentTreeLayout(agents, measuredH);
        applyAgentMapLayout(layout, els);
        repositionAgentMapNodes(els.nodes, layout);
      }
      agentMapLastLayouts[prefix] = layout;
      drawAgentMapArrows(agents, layout, els, markerPrefix);
      requestAnimationFrame(function () {
        fitAgentMapToContainer(prefix);
        drawAgentMapArrows(agents, layout, els, markerPrefix);
      });
    }

    function renderAgentMap() {
      AGENT_MAP_PREFIXES.forEach(renderAgentMapForPrefix);
    }

    async function fetchAgentMapData() {
      try {
        var r = await fetch(API + '/api/agents');
        var d = await r.json();
        var agents = Array.isArray(d.agents) ? d.agents : [];
        agentMapData = agents;
        if (!agents.length) agentMapData = [{ id: 'main' }];
        renderAgentMap();
        renderTeamActivity();
        renderAgentInbox();
        renderAgentOutbox();
        renderAgentContext();
        renderAgentMetrics();
        renderTeamAgentCards();
        renderGoalsOwnerOptions();
        return agentMapData;
      } catch (_) {
        agentMapData = [{ id: 'main' }];
        renderAgentMap();
        renderTeamActivity();
        renderAgentInbox();
        renderAgentOutbox();
        renderAgentContext();
        renderAgentMetrics();
        renderTeamAgentCards();
        renderGoalsOwnerOptions();
        return agentMapData;
      }
    }

    function agentNameById(agentId) {
      var id = (agentId || '').trim();
      if (!id) return '';
      var hit = (agentMapData || []).find(function (a) { return a && a.id === id; });
      if (hit) return agentDisplayLabel(hit);
      return id;
    }

    function formatAgentStateDisplay(state) {
      var s = String(state || 'idle').toLowerCase();
      if (s === 'blocked') s = 'waiting';
      if (s === 'working') return { className: 'working', text: '🟢 Working' };
      if (s === 'waiting') return { className: 'waiting', text: '🟡 Waiting' };
      if (s === 'error') return { className: 'error', text: '🔴 Error' };
      return { className: 'idle', text: '⚪ Idle' };
    }

    function formatAgentMapStateLabel(state) {
      return formatAgentStateDisplay(state);
    }

    function renderAgentMapStateHtml(agentId, mode) {
      if (mode !== 'edit-page') return '';
      var ctx = (teamAgentContextSnapshot.agents || {})[String(agentId || '').trim()] || { state: 'idle' };
      var stateInfo = formatAgentMapStateLabel(ctx.state);
      return '<div class="agent-map-node-state ' + stateInfo.className + '">' + escapeHtml(stateInfo.text) + '</div>';
    }

    function formatInboxTime(ts) {
      var d = new Date(Number(ts) || Date.now());
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }

    var TEAM_AGENT_RANGE_LABELS = {
      today: 'Today',
      yesterday: 'Yesterday',
      last7: 'Last week',
      last30: 'Last 30 days',
      all: 'All time',
    };

    function startOfLocalDayMs(ts) {
      var d = new Date(Number(ts) || Date.now());
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    }

    function getTeamAgentRangeWindow(range) {
      var key = String(range || 'today').trim();
      if (key === 'all') return null;
      var now = Date.now();
      var todayStart = startOfLocalDayMs(now);
      if (key === 'today') return { since: todayStart, until: now };
      if (key === 'yesterday') {
        return { since: todayStart - 86400000, until: todayStart - 1 };
      }
      if (key === 'last7') return { since: todayStart - 7 * 86400000, until: now };
      if (key === 'last30') return { since: todayStart - 30 * 86400000, until: now };
      return { since: todayStart, until: now };
    }

    function teamAgentRangeLabel(range) {
      return TEAM_AGENT_RANGE_LABELS[String(range || 'today')] || 'Today';
    }

    function eventTsInTeamAgentRange(ts, range) {
      var window = getTeamAgentRangeWindow(range);
      if (!window) return true;
      var n = Number(ts) || 0;
      return n >= window.since && n <= window.until;
    }

    function teamActivityEventsForRange(range) {
      var events = teamActivityEvents || [];
      if (!getTeamAgentRangeWindow(range)) return events.slice();
      return events.filter(function (event) {
        return eventTsInTeamAgentRange(event && event.ts, range);
      });
    }

    function filterFlowsByTeamAgentRange(flows, range) {
      if (!getTeamAgentRangeWindow(range)) return flows;
      return flows.filter(function (flow) {
        return eventTsInTeamAgentRange(flow && flow.ts, range);
      });
    }

    function setTeamAgentPanelRange(range) {
      var key = String(range || 'today').trim();
      if (!TEAM_AGENT_RANGE_LABELS[key]) key = 'today';
      teamAgentPanelRange = key;
      document.querySelectorAll('.team-agent-panel-range').forEach(function (btn) {
        var active = btn.getAttribute('data-range') === teamAgentPanelRange;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      fetchTeamMetricsFeed();
      renderAgentContext();
      renderAgentInbox();
      renderAgentOutbox();
      renderAgentMetrics();
      if (typeof renderMissionControl === 'function') renderMissionControl();
      if (typeof mc2SyncTimelineHighlightForScroll === 'function') mc2SyncTimelineHighlightForScroll();
    }

    function selectTeamInboxAgent(agentId) {
      selectedTeamInboxAgentId = String(agentId || '').trim();
      document.querySelectorAll('#team-map-nodes .agent-map-node').forEach(function (n) {
        n.classList.toggle('selected', n.getAttribute('data-agent-id') === selectedTeamInboxAgentId);
      });
      document.querySelectorAll('#team-agent-cards .team-agent-card').forEach(function (n) {
        n.classList.toggle('selected', n.getAttribute('data-agent-id') === selectedTeamInboxAgentId);
      });
      renderAgentInbox();
      renderAgentOutbox();
      renderAgentContext();
      renderAgentMetrics();
      renderCurrentMission();
      renderTeamTaskSummary();
      if (selectedTeamInboxAgentId) setTeamRailExpanded('context', true);
    }

    function setTeamViewTab(mode) {
      teamViewMode = mode === 'tree' ? 'tree' : 'cards';
      var cardsTab = document.getElementById('team-view-tab-cards');
      var treeTab = document.getElementById('team-view-tab-tree');
      var cardsView = document.getElementById('team-cards-view');
      var treeView = document.getElementById('team-tree-view');
      if (cardsTab) {
        cardsTab.classList.toggle('active', teamViewMode === 'cards');
        cardsTab.setAttribute('aria-selected', teamViewMode === 'cards' ? 'true' : 'false');
      }
      if (treeTab) {
        treeTab.classList.toggle('active', teamViewMode === 'tree');
        treeTab.setAttribute('aria-selected', teamViewMode === 'tree' ? 'true' : 'false');
      }
      if (cardsView) cardsView.hidden = teamViewMode !== 'cards';
      if (treeView) treeView.hidden = teamViewMode !== 'tree';
      if (teamViewMode === 'tree') {
        renderAgentMapForPrefix({ prefix: 'team-map', mode: 'edit-page' });
        requestAnimationFrame(function () {
          fitAgentMapToContainer('team-map');
          var layout = agentMapLastLayouts['team-map'];
          var els = agentMapEls('team-map');
          if (layout && els) drawAgentMapArrows(agentMapData, layout, els, 'team');
        });
      }
    }

    var TEAM_TOP_TAB_DESC = {
      roster: 'Browse your agent team — click a card for Active Context, Inbox, Outbox, or Stats; use ✎ to edit, or switch to Tree for hierarchy.',
      goals: 'Long-running objectives your agents work on autonomously — create goals, track subgoals, and run or pause work.',
      initiatives: 'Proactive suggestions from goal reflection and team activity — review and promote into goals or subgoals.',
    };

    function isGoalPartialWait(goal) {
      var w = goal && goal.waitCondition;
      if (!w || typeof w !== 'object') return false;
      return String(w.kind || '').toLowerCase() === 'partial';
    }

    function goalImplementationBlockedLabel(goal) {
      if (!goal) return '';
      var w = goal.waitCondition;
      var reason = String((w && (w.reason || w.condition)) || goal.blockedReason || '').trim();
      if (isGoalPartialWait(goal)) {
        var appliesTo = (w && (w.waitAppliesTo || w.scope)) || 'implementation';
        return reason || ('Implementation blocked (' + appliesTo + ') — research continues');
      }
      return reason;
    }

    function formatGoalImplementationAttention(goal) {
      var title = escapeHtml(String(goal.title || goal.objective || 'Mission').slice(0, 48));
      var ask = String(goal.needsUserInput || '').trim();
      var reason = goalImplementationBlockedLabel(goal);
      var text = title + ': Implementation blocked — research continues';
      if (reason && reason !== 'Implementation blocked — research continues') {
        text += ' (' + escapeHtml(reason.slice(0, 56)) + ')';
      }
      if (ask) text += ' · ' + escapeHtml(ask.slice(0, 72));
      return text;
    }

    function setTeamTopTab(tab) {
      teamTopTab = tab === 'goals' ? 'goals' : (tab === 'initiatives' ? 'initiatives' : 'roster');
      var rosterTab = document.getElementById('team-top-tab-roster');
      var goalsTab = document.getElementById('team-top-tab-goals');
      var initiativesTab = document.getElementById('team-top-tab-initiatives');
      var tabDesc = document.getElementById('team-top-tab-desc');
      var rosterView = document.getElementById('team-roster-view');
      var goalsView = document.getElementById('team-goals-view');
      var initiativesView = document.getElementById('team-initiatives-view');
      if (tabDesc) tabDesc.textContent = TEAM_TOP_TAB_DESC[teamTopTab] || TEAM_TOP_TAB_DESC.roster;
      if (rosterTab) {
        rosterTab.classList.toggle('active', teamTopTab === 'roster');
        rosterTab.setAttribute('aria-selected', teamTopTab === 'roster' ? 'true' : 'false');
      }
      if (goalsTab) {
        goalsTab.classList.toggle('active', teamTopTab === 'goals');
        goalsTab.setAttribute('aria-selected', teamTopTab === 'goals' ? 'true' : 'false');
      }
      if (initiativesTab) {
        initiativesTab.classList.toggle('active', teamTopTab === 'initiatives');
        initiativesTab.setAttribute('aria-selected', teamTopTab === 'initiatives' ? 'true' : 'false');
      }
      if (rosterView) rosterView.hidden = teamTopTab !== 'roster';
      if (goalsView) goalsView.hidden = teamTopTab !== 'goals';
      if (initiativesView) initiativesView.hidden = teamTopTab !== 'initiatives';
      if (teamTopTab === 'goals' && (!teamGoalsSnapshot.goals || !teamGoalsSnapshot.goals.length)) {
        fetchGoalsSnapshot();
      }
      if (teamTopTab === 'initiatives' && (!teamInitiativesSnapshot.initiatives || !teamInitiativesSnapshot.initiatives.length)) {
        fetchInitiativesSnapshot();
      }
      if (typeof renderTeamUserInputModal === 'function') renderTeamUserInputModal();
    }

    function formatGoalTs(ts) {
      var n = Number(ts);
      if (!isFinite(n) || n <= 0) return 'never';
      return new Date(n).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function goalOwnerLabel(goal) {
      return agentNameById(goal && goal.ownerAgentId ? goal.ownerAgentId : 'main');
    }

    function activeGoalLabelForAgent(agentId) {
      var goals = Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : [];
      var owned = goals.filter(function (g) {
        return String(g.ownerAgentId || '') === String(agentId || '') &&
          String(g.status || 'active').toLowerCase() === 'active';
      });
      if (!owned.length) return '';
      owned.sort(function (a, b) {
        if (!!b.running !== !!a.running) return (b.running ? 1 : 0) - (a.running ? 1 : 0);
        return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
      });
      var g = owned[0];
      return String(g.title || '').trim() || String(g.objective || '').trim();
    }

    var EPHEMERAL_GOAL_LABELS = {
      'Answer user question': 1,
      'Handle delegated task': 1,
      'Improve onboarding conversion': 1,
      'Analyze product metrics': 1,
      'Fix nginx issue': 1,
      'Fix technical issue': 1,
      'Generate marketing ideas': 1,
    };

    function isEphemeralGoalLabel(label) {
      var g = String(label || '').trim();
      return !g || !!EPHEMERAL_GOAL_LABELS[g];
    }

    function missionLabelForAgent(agentId, ctx) {
      var row = ctx || {};
      var state = String(row.state || 'idle').toLowerCase();
      var stored = String(row.currentGoal || '').trim();
      if (state === 'idle') {
        return activeGoalLabelForAgent(agentId) || '';
      }
      if (stored && !isEphemeralGoalLabel(stored)) return stored;
      var fromGoals = activeGoalLabelForAgent(agentId);
      return fromGoals || stored || '';
    }

    function isAgentContextActive(ctx) {
      var s = String(ctx && ctx.state || 'idle').toLowerCase();
      return s === 'working' || s === 'waiting' || s === 'error';
    }

    function pickLiveMissionAgentId() {
      var map = teamAgentContextSnapshot.agents || {};
      var candidates = [];
      function add(id) {
        var key = String(id || '').trim();
        if (!key || candidates.indexOf(key) >= 0) return;
        if (!isAgentContextActive(map[key])) return;
        candidates.push(key);
      }
      add(selectedTeamInboxAgentId);
      add('main');
      Object.keys(map).forEach(add);
      if (!candidates.length) return '';
      candidates.sort(function (a, b) {
        return (Number(map[b] && map[b].updatedAt) || 0) - (Number(map[a] && map[a].updatedAt) || 0);
      });
      return candidates[0];
    }

    function getLiveMissionFromTeamContext() {
      var agentId = pickLiveMissionAgentId();
      if (!agentId) return null;
      var ctx = (teamAgentContextSnapshot.agents || {})[agentId] || {};
      var goalLabel = missionLabelForAgent(agentId, ctx);
      var thought = String(ctx.currentThought || ctx.currentStep || '').trim();
      var waitingFor = String(ctx.waitingFor || '').trim();
      var lastAction = String(ctx.lastAction || '').trim();
      if (!goalLabel && !thought && !waitingFor && !lastAction) return null;
      if (!goalLabel && thought) goalLabel = thought.length > 120 ? thought.slice(0, 119) + '…' : thought;
      if (!goalLabel) goalLabel = 'Active team work';
      var subgoals = [];
      if (thought) subgoals.push({ title: thought, status: 'doing' });
      if (waitingFor) {
        subgoals.push({
          title: 'Waiting on ' + agentNameById(waitingFor),
          status: 'todo',
        });
      }
      if (lastAction) subgoals.push({ title: lastAction, status: 'done' });
      return {
        live: true,
        title: goalLabel,
        objective: thought,
        ownerAgentId: agentId,
        progressLabel: 'In progress',
        subgoals: subgoals,
      };
    }

    function getCurrentMissionGoal() {
      var goals = Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals.slice() : [];
      if (!goals.length) return null;
      var isActive = function (g) {
        return String(g && g.status || 'active').toLowerCase() === 'active';
      };
      if (selectedTeamGoalId) {
        var selected = goals.find(function (g) { return String(g.id || '') === selectedTeamGoalId; });
        if (selected && isActive(selected)) return selected;
      }
      var running = goals.find(function (g) { return !!g.running && isActive(g); });
      if (running) return running;
      var active = goals.filter(isActive);
      active.sort(function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); });
      if (active.length) return active[0];
      if (selectedTeamGoalId) {
        var anySelected = goals.find(function (g) { return String(g.id || '') === selectedTeamGoalId; });
        if (anySelected) return anySelected;
      }
      goals.sort(function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); });
      return goals[0] || null;
    }

    function teamHasSavedGoals() {
      return Array.isArray(teamGoalsSnapshot.goals) && teamGoalsSnapshot.goals.length > 0;
    }

    function getCurrentMission() {
      var stored = getCurrentMissionGoal();
      if (stored) return { kind: 'stored', goal: stored };
      var live = getLiveMissionFromTeamContext();
      if (live) return { kind: 'live', mission: live, noSavedGoal: !teamHasSavedGoals() };
      return null;
    }

    function missionSubgoalIcon(status) {
      var s = normalizeSubgoalStatus(status);
      if (s === 'done') return '✓';
      if (s === 'doing') return '→';
      return '○';
    }

    function missionSubgoalClass(status) {
      var s = normalizeSubgoalStatus(status);
      if (s === 'done') return 'mission-done';
      if (s === 'doing') return 'mission-doing';
      return 'mission-todo';
    }

    function flattenMissionSubgoals(subgoals, out, depth) {
      var list = Array.isArray(subgoals) ? subgoals : [];
      var acc = out || [];
      var level = Number(depth) || 0;
      if (level > 4 || acc.length >= 12) return acc;
      list.forEach(function (sg) {
        if (!sg || typeof sg !== 'object' || acc.length >= 12) return;
        acc.push(sg);
        flattenMissionSubgoals(sg.subgoals, acc, level + 1);
      });
      return acc;
    }

    function renderCurrentMission() {
      var panel = document.getElementById('team-current-mission');
      if (!panel) return;
      var current = getCurrentMission();
      if (!current) {
        panel.innerHTML = '' +
          '<h3 class="team-current-mission-title">Current Mission</h3>' +
          '<p class="team-current-mission-empty">No active mission. Team is idle — create a mission or send a task in chat.</p>';
        return;
      }
      var goal = current.kind === 'live' ? current.mission : current.goal;
      var liveOnly = current.kind === 'live' && !!current.noSavedGoal;
      var goalLabel = String(goal.title || '').trim() || String(goal.objective || '').trim() || 'Untitled mission';
      var progressText = goal.progressLabel
        ? String(goal.progressLabel)
        : (normalizeSubgoalProgress(goal.progress && goal.progress.pct) + '%');
      var owner = goalOwnerLabel(goal);
      var subgoals = current.kind === 'live'
        ? (Array.isArray(goal.subgoals) ? goal.subgoals : [])
        : flattenMissionSubgoals(Array.isArray(goal.subgoals) ? goal.subgoals : [], [], 0);
      var subgoalsHtml = subgoals.length
        ? '<ul class="team-current-mission-subgoal-list">' + subgoals.map(function (sg) {
          var title = String(sg.title || '').trim() || 'Untitled subgoal';
          var icon = missionSubgoalIcon(sg.status);
          var cls = missionSubgoalClass(sg.status);
          return '<li class="' + cls + '" title="' + escapeHtml(title) + '">' + escapeHtml(icon + ' ' + title) + '</li>';
        }).join('') + '</ul>'
        : '<p class="team-current-mission-empty" style="margin:0;">No subgoals yet.</p>';
      var goalHeading = liveOnly ? 'Activity' : 'Mission';
      var noteHtml = liveOnly
        ? '<p class="team-current-mission-empty" style="margin:0.35rem 0 0;">No saved mission yet — this is live agent context from chat. Create a mission to track objectives and subgoals.</p>'
        : '';
      panel.innerHTML = '' +
        '<h3 class="team-current-mission-title">Current Mission</h3>' +
        (liveOnly ? '<p class="team-current-mission-meta" style="margin:0 0 0.35rem;"><em>Live work (not a saved goal)</em></p>' : '') +
        '<p class="team-current-mission-meta"><strong>' + goalHeading + ':</strong> ' + escapeHtml(goalLabel) + '</p>' +
        '<p class="team-current-mission-meta"><strong>Progress:</strong> ' + escapeHtml(progressText) + '</p>' +
        '<p class="team-current-mission-meta"><strong>Owner:</strong> ' + escapeHtml(owner) + '</p>' +
        '<div class="team-current-mission-subgoals">' +
          '<h4>' + (liveOnly ? 'Steps' : 'Subgoals') + '</h4>' +
          subgoalsHtml +
        '</div>' +
        noteHtml;
    }

    function collectSubgoalsByStatus(subgoals, acc) {
      var out = acc || { todo: [], doing: [], blocked: [] };
      (subgoals || []).forEach(function (sg) {
        if (!sg || typeof sg !== 'object') return;
        var title = String(sg.title || '').trim();
        var status = normalizeSubgoalStatus(sg.status);
        if (title) {
          if (status === 'todo') out.todo.push(title);
          else if (status === 'doing') out.doing.push(title);
          else if (status === 'blocked') out.blocked.push(title);
        }
        collectSubgoalsByStatus(sg.subgoals, out);
      });
      return out;
    }

    function countCompletedTasksToday() {
      return listCompletedTasks({ range: 'today' }).length;
    }

    function extractTurnDoneSkills(summary) {
      var text = String(summary || '');
      var m = text.match(/using\s+(\d+)\s+skill/i);
      if (m) return Number(m[1]) || 0;
      return 0;
    }

    function taskPromptForTurnDone(event, events) {
      var agentId = String(event && event.agentId || '').trim();
      var ts = Number(event && event.ts) || 0;
      if (!agentId || !ts) return '';
      var list = Array.isArray(events) ? events : (teamActivityEvents || []);
      var idx = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i] === event) { idx = i; break; }
        if (String(list[i].id || '') && String(list[i].id) === String(event.id || '')) { idx = i; break; }
        if (Number(list[i].ts) === ts && String(list[i].type) === 'turn_done' && String(list[i].agentId) === agentId) {
          idx = i;
          break;
        }
      }
      if (idx < 0) idx = list.findIndex(function (e) {
        return String(e.type) === 'turn_done' && String(e.agentId) === agentId && Number(e.ts) === ts;
      });
      var prompt = '';
      if (idx >= 0) {
        for (var j = idx - 1; j >= 0; j--) {
          var prev = list[j];
          if (String(prev.agentId || '') !== agentId) continue;
          if (String(prev.type || '') === 'turn_start') {
            prompt = String(prev.message || '').trim();
            break;
          }
          if (String(prev.type || '') === 'turn_done') break;
        }
      }
      prompt = prompt.replace(/^\[Retry with tools\]\s*/i, '').trim();
      prompt = prompt.replace(/^The user asked:\s*["“]?/i, '').replace(/["”]\.\s*Use available tools.*$/i, '').trim();
      if (!prompt) prompt = String(event.message || '').trim();
      return prompt;
    }

    function listCompletedTasks(opts) {
      opts = opts || {};
      var range = String(opts.range || 'today').trim();
      var agentFilter = String(opts.agentId || '').trim();
      var events = teamActivityEvents || [];
      var window = getTeamAgentRangeWindow(range);
      var since = window ? window.since : startOfLocalDayMs(Date.now());
      var until = window ? window.until : (Date.now() + 86400000);
      var out = [];
      events.forEach(function (event) {
        if (String(event.type || '') !== 'turn_done') return;
        var ts = Number(event.ts) || 0;
        if (!ts || ts < since || ts > until) return;
        var agentId = String(event.agentId || '').trim();
        if (agentFilter && agentId !== agentFilter) return;
        var summary = String(event.message || '').trim();
        out.push({
          id: String(event.id || ts + '-' + agentId),
          agentId: agentId,
          ts: ts,
          summary: summary,
          prompt: taskPromptForTurnDone(event, events),
          skillCount: extractTurnDoneSkills(summary),
        });
      });
      if (window.cowCodeCompletedTasks && typeof window.cowCodeCompletedTasks.consolidateCompletedTasks === 'function') {
        out = window.cowCodeCompletedTasks.consolidateCompletedTasks(out);
      }
      return out;
    }

    function computeTeamTaskSummary() {
      var agents = teamAgentContextSnapshot.agents || {};
      var active = 0;
      var waiting = 0;
      var blocked = 0;
      var waitingAgents = [];
      Object.keys(agents).forEach(function (id) {
        var ctx = agents[id] || {};
        var s = String(ctx.state || 'idle').toLowerCase();
        if (s === 'working') {
          active++;
        } else if (s === 'waiting') {
          waiting++;
          waitingAgents.push({ id: id, ctx: ctx });
        } else if (s === 'error') {
          blocked++;
        }
      });

      var subgoals = { todo: [], doing: [], blocked: [] };
      var blockedReasons = [];
      var implementationBlockedLabels = [];
      (Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : []).forEach(function (g) {
        var status = String(g.status || '').toLowerCase();
        if (status === 'blocked') {
          blocked++;
          var reason = String(g.blockedReason || g.title || g.objective || '').trim();
          if (reason) blockedReasons.push(reason);
        } else if (isGoalPartialWait(g) || String(g.needsUserInput || '').trim()) {
          implementationBlockedLabels.push(goalImplementationBlockedLabel(g) || String(g.needsUserInput || '').trim());
        }
        collectSubgoalsByStatus(g.subgoals, subgoals);
      });
      blocked += subgoals.blocked.length;

      var blockedLabel = '';
      if (subgoals.blocked.length) blockedLabel = subgoals.blocked[0];
      else if (implementationBlockedLabels.length) {
        blockedLabel = implementationBlockedLabels[0] + '. Research continues.';
      } else if (blockedReasons.length) blockedLabel = blockedReasons[0];
      else if (waitingAgents.length) {
        waitingAgents.sort(function (a, b) {
          return (Number(b.ctx.updatedAt) || 0) - (Number(a.ctx.updatedAt) || 0);
        });
        var w = waitingAgents[0].ctx;
        var waitFor = String(w.waitingFor || '').trim();
        if (waitFor) blockedLabel = 'Waiting for ' + agentNameById(waitFor) + ' response';
        else blockedLabel = String(w.currentThought || w.currentStep || w.currentGoal || '').trim();
      }

      return {
        active: active,
        waiting: waiting,
        blocked: blocked,
        completedToday: countCompletedTasksToday(),
        blockedLabel: blockedLabel,
      };
    }

    function renderTeamTaskSummary() {
      var badgesEl = document.getElementById('team-task-summary-badges');
      var blockedEl = document.getElementById('team-task-blocked');
      if (!badgesEl || !blockedEl) return;
      var summary = computeTeamTaskSummary();
      badgesEl.innerHTML = '' +
        '<span class="team-task-badge active">[' + escapeHtml(String(summary.active)) + ' Active]</span>' +
        '<span class="team-task-badge waiting">[' + escapeHtml(String(summary.waiting)) + ' Waiting]</span>' +
        '<span class="team-task-badge blocked">[' + escapeHtml(String(summary.blocked)) + ' Blocked]</span>' +
        '<span class="team-task-badge completed">[' + escapeHtml(String(summary.completedToday)) + ' Completed Today]</span>';
      blockedEl.innerHTML = summary.blockedLabel
        ? '<strong>' + (summary.blockedLabel.indexOf('Research continues') >= 0 ? 'Implementation blocked:' : 'Blocked:') + '</strong> ' + escapeHtml(summary.blockedLabel)
        : '<strong>Blocked:</strong> <span class="empty">None</span>';
      blockedEl.classList.toggle('empty', !summary.blockedLabel);
    }

    function normalizeSubgoalStatus(status) {
      var s = String(status || '').toLowerCase();
      if (s === 'done' || s === 'doing' || s === 'blocked' || s === 'todo') return s;
      return 'todo';
    }

    function normalizeSubgoalProgress(value) {
      var n = Number(value);
      if (!isFinite(n)) return 0;
      return Math.max(0, Math.min(100, Math.round(n)));
    }

    function countGoalSubgoals(subgoals) {
      if (!Array.isArray(subgoals) || !subgoals.length) return 0;
      var total = 0;
      subgoals.forEach(function (sg) {
        total += 1 + countGoalSubgoals(sg && sg.subgoals);
      });
      return total;
    }

    function indexGoalSubgoals(subgoals, out) {
      if (!Array.isArray(subgoals)) return out;
      var index = out || {};
      subgoals.forEach(function (sg) {
        if (!sg || typeof sg !== 'object') return;
        var id = String(sg.id || '').trim();
        if (id) index[id] = sg;
        indexGoalSubgoals(sg.subgoals, index);
      });
      return index;
    }

    function renderGoalSubgoalTree(subgoals, lookup, depth) {
      var list = Array.isArray(subgoals) ? subgoals : [];
      if (!list.length) return '';
      var level = Number(depth) || 0;
      return list.map(function (sg) {
        if (!sg || typeof sg !== 'object') return '';
        var title = String(sg.title || '').trim() || 'Untitled subgoal';
        var status = normalizeSubgoalStatus(sg.status);
        var progress = normalizeSubgoalProgress(sg.progress);
        var assignee = String(sg.assignee || '').trim();
        var deps = Array.isArray(sg.depends_on) ? sg.depends_on.slice(0, 8) : [];
        var depsLabel = deps.map(function (depId) {
          var key = String(depId || '').trim();
          var dep = lookup[key];
          return dep && dep.title ? dep.title : key;
        }).filter(Boolean).join(', ');
        var children = renderGoalSubgoalTree(sg.subgoals, lookup, level + 1);
        var summary = '<span class="team-goal-subgoal-row">' +
          '<span class="team-goal-subgoal-title">' + escapeHtml(title) + '</span>' +
          '<span class="team-goal-subgoal-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' +
          '<span class="team-goal-subgoal-meta">' + escapeHtml(String(progress)) + '%</span>' +
          (assignee ? '<span class="team-goal-subgoal-meta">assignee: ' + escapeHtml(agentNameById(assignee)) + '</span>' : '') +
          (depsLabel ? '<span class="team-goal-subgoal-meta">depends on: ' + escapeHtml(depsLabel) + '</span>' : '') +
        '</span>';
        return '<details class="team-goal-subgoal-node" ' + (level < 1 ? 'open' : '') + '>' +
          '<summary>' + summary + '</summary>' +
          (children || '') +
        '</details>';
      }).join('');
    }

    function renderGoalDetail(goal) {
      var detail = document.getElementById('team-goal-detail');
      if (!detail) return;
      if (!goal || typeof goal !== 'object') {
        detail.innerHTML = '<p class="team-agent-inbox-empty" style="margin:0;padding:0;">Select a goal to view details and subgoals.</p>';
        return;
      }
      var status = String(goal.status || 'active').toLowerCase();
      var pct = normalizeSubgoalProgress(goal.progress && goal.progress.pct);
      var subgoals = Array.isArray(goal.subgoals) ? goal.subgoals : [];
      var subgoalLookup = indexGoalSubgoals(subgoals, {});
      var subgoalTree = renderGoalSubgoalTree(subgoals, subgoalLookup, 0);
      detail.innerHTML = '' +
        '<h4>' + escapeHtml(goal.title || 'Untitled mission') + ' <span class="team-goal-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span></h4>' +
        '<div class="team-goal-detail-row"><strong>Owner:</strong> ' + escapeHtml(goalOwnerLabel(goal)) + '</div>' +
        '<div class="team-goal-detail-row"><strong>Objective:</strong> ' + escapeHtml(String(goal.objective || '')) + '</div>' +
        '<div class="team-goal-detail-row"><strong>Progress:</strong> ' + escapeHtml(String(pct)) + '%</div>' +
        (goal.lastActivity ? '<div class="team-goal-detail-row"><strong>Latest activity:</strong> ' + escapeHtml(String(goal.lastActivity)) + '</div>' : '') +
        '<div class="team-goal-subgoals">' +
          '<h5>Subgoals (expandable tree)</h5>' +
          (subgoalTree || '<p class="team-agent-inbox-empty" style="margin:0;padding:0;">No subgoals yet.</p>') +
        '</div>';
    }

    function renderGoalsOwnerOptions() {
      var el = document.getElementById('team-goal-owner');
      if (!el) return;
      var agents = agentMapData || [];
      if (!agents.length) {
        el.innerHTML = '<option value="main">main</option>';
        return;
      }
      el.innerHTML = agents.map(function (a) {
        var id = String(a && a.id || 'main');
        return '<option value="' + escapeHtml(id) + '">' + escapeHtml(agentDisplayLabel(a)) + '</option>';
      }).join('');
    }

    function renderGoalsList() {
      var wrap = document.getElementById('team-goals-list');
      if (!wrap) return;
      var goals = Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals.slice() : [];
      goals.sort(function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); });
      if (!goals.length) {
        selectedTeamGoalId = '';
        wrap.innerHTML = '<p class="team-agent-inbox-empty" style="margin:0;padding:0.5rem 0;">No missions yet.</p>';
        renderGoalDetail(null);
        renderCurrentMission();
        renderTeamTaskSummary();
        return;
      }
      if (!selectedTeamGoalId || !goals.some(function (g) { return String(g.id || '') === selectedTeamGoalId; })) {
        selectedTeamGoalId = String(goals[0].id || '');
      }
      wrap.innerHTML = goals.map(function (g) {
        var id = String(g.id || '');
        var status = String(g.status || 'active').toLowerCase();
        var pct = Number(g.progress && g.progress.pct);
        if (!isFinite(pct)) pct = 0;
        pct = Math.max(0, Math.min(100, Math.round(pct)));
        var running = !!g.running;
        var selected = id === selectedTeamGoalId ? ' selected' : '';
        var subgoalCount = countGoalSubgoals(g.subgoals);
        var openInitiativesCount = (Array.isArray(teamInitiativesSnapshot.initiatives) ? teamInitiativesSnapshot.initiatives : []).filter(function (it) {
          var related = Array.isArray(it.relatedGoalIds) ? it.relatedGoalIds : [];
          var status = String(it.status || 'open').toLowerCase();
          return related.indexOf(id) >= 0 && (status === 'open' || status === 'accepted');
        }).length;
        var runningTxt = running ? ('Working: ' + escapeHtml(goalOwnerLabel(g))) : '';
        var last = formatGoalTs(g.lastRunAt);
        var next = formatGoalTs(g.nextRunAt);
        return '<div class="team-goal-card' + selected + '" data-goal-id="' + escapeHtml(id) + '">' +
          '<div class="team-goal-card-head">' +
            '<h4 class="team-goal-card-title">' + escapeHtml(g.title || 'Untitled mission') + '</h4>' +
            '<span class="team-goal-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' +
          '</div>' +
          '<div class="team-goal-meta"><strong>Owner:</strong> ' + escapeHtml(goalOwnerLabel(g)) + '</div>' +
          '<div class="team-goal-meta"><strong>Objective:</strong> ' + escapeHtml(String(g.objective || '').slice(0, 180)) + '</div>' +
          '<div class="team-goal-meta"><strong>Subgoals:</strong> ' + escapeHtml(String(subgoalCount)) + '</div>' +
          '<div class="team-goal-meta"><strong>Open Initiatives:</strong> ' + escapeHtml(String(openInitiativesCount)) + '</div>' +
          '<div class="team-goal-progress"><span style="width:' + pct + '%"></span></div>' +
          '<div class="team-goal-meta"><strong>Progress:</strong> ' + pct + '%</div>' +
          '<div class="team-goal-meta"><strong>Last:</strong> ' + escapeHtml(last) + ' <strong>Next:</strong> ' + escapeHtml(next) + '</div>' +
          (runningTxt ? '<div class="team-goal-meta"><strong>' + runningTxt + '</strong></div>' : '') +
          (g.lastActivity ? '<div class="team-goal-meta"><strong>Activity:</strong> ' + escapeHtml(g.lastActivity) + '</div>' : '') +
          '<div class="team-goal-actions">' +
            '<button type="button" class="secondary" data-goal-run="' + escapeHtml(id) + '" style="margin:0;">Run now</button>' +
            '<button type="button" class="secondary" data-goal-toggle="' + escapeHtml(id) + '" style="margin:0;">' + (status === 'active' ? 'Pause' : (status === 'paused' ? 'Resume' : 'Activate')) + '</button>' +
          '</div>' +
        '</div>';
      }).join('');
      renderGoalDetail(goals.find(function (g) { return String(g.id || '') === selectedTeamGoalId; }) || goals[0]);
      renderCurrentMission();
      renderTeamTaskSummary();

      wrap.querySelectorAll('button[data-goal-run]').forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          e.preventDefault();
          e.stopPropagation();
          var id = btn.getAttribute('data-goal-run');
          if (!id) return;
          btn.disabled = true;
          try {
            await fetch(API + '/api/goals/' + encodeURIComponent(id) + '/run', { method: 'POST' });
          } catch (_) {}
          btn.disabled = false;
          fetchGoalsSnapshot();
        });
      });
      wrap.querySelectorAll('button[data-goal-toggle]').forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          e.preventDefault();
          e.stopPropagation();
          var id = btn.getAttribute('data-goal-toggle');
          if (!id) return;
          var goal = goals.find(function (g) { return String(g.id) === id; });
          if (!goal) return;
          var nextStatus = goal.status === 'active' ? 'paused' : 'active';
          btn.disabled = true;
          try {
            await fetch(API + '/api/goals/' + encodeURIComponent(id), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: nextStatus }),
            });
          } catch (_) {}
          btn.disabled = false;
          fetchGoalsSnapshot();
        });
      });
      wrap.querySelectorAll('.team-goal-card').forEach(function (card) {
        card.addEventListener('click', function () {
          var id = String(card.getAttribute('data-goal-id') || '').trim();
          if (!id) return;
          selectedTeamGoalId = id;
          renderGoalsList();
        });
      });
    }

    function renderInitiativeDetail(initiative) {
      var detail = document.getElementById('team-initiative-detail');
      if (!detail) return;
      if (!initiative || typeof initiative !== 'object') {
        detail.innerHTML = '<p class="team-agent-inbox-empty" style="margin:0;padding:0;">Select an initiative to review and promote.</p>';
        return;
      }
      var relatedGoals = Array.isArray(initiative.relatedGoalIds) ? initiative.relatedGoalIds : [];
      var relatedLabel = relatedGoals.length ? relatedGoals.map(function (gid) {
        var goal = (teamGoalsSnapshot.goals || []).find(function (g) { return String(g.id || '') === String(gid); });
        return goal ? goal.title : gid;
      }).join(', ') : '—';
      detail.innerHTML = '' +
        '<h4>' + escapeHtml(initiative.title || 'Untitled initiative') + '</h4>' +
        '<div class="team-initiative-row"><strong>Type:</strong> <span class="team-initiative-type">' + escapeHtml(initiative.type || 'observation') + '</span></div>' +
        '<div class="team-initiative-row"><strong>Status:</strong> <span class="team-initiative-status ' + escapeHtml(String(initiative.status || 'open').toLowerCase()) + '">' + escapeHtml(initiative.status || 'open') + '</span></div>' +
        '<div class="team-initiative-row"><strong>Confidence:</strong> ' + escapeHtml(String(Math.round((Number(initiative.confidence) || 0) * 100))) + '%</div>' +
        '<div class="team-initiative-row"><strong>Description:</strong> ' + escapeHtml(initiative.description || '') + '</div>' +
        '<div class="team-initiative-row"><strong>Source:</strong> ' + escapeHtml(initiative.source || '') + '</div>' +
        '<div class="team-initiative-row"><strong>Created by:</strong> ' + escapeHtml(agentNameById(initiative.createdBy || 'main')) + '</div>' +
        '<div class="team-initiative-row"><strong>Related goals:</strong> ' + escapeHtml(relatedLabel) + '</div>' +
        '<div class="team-initiative-row"><strong>Activity:</strong> ' + escapeHtml((initiative.activity || []).join(' | ') || '—') + '</div>' +
        '<div class="team-initiative-row"><strong>Specialist reviews:</strong> ' + escapeHtml((initiative.specialistReviews || []).join(' | ') || '—') + '</div>' +
        '<div class="team-initiative-actions">' +
          '<button type="button" class="secondary" id="team-init-accept">Accept</button>' +
          '<button type="button" class="secondary" id="team-init-reject">Reject</button>' +
          '<button type="button" class="secondary" id="team-init-promote-goal">Promote to Goal</button>' +
          '<button type="button" class="secondary" id="team-init-promote-subgoal">Promote to Subgoal</button>' +
        '</div>';
      var acceptBtn = document.getElementById('team-init-accept');
      var rejectBtn = document.getElementById('team-init-reject');
      var promoteGoalBtn = document.getElementById('team-init-promote-goal');
      var promoteSubgoalBtn = document.getElementById('team-init-promote-subgoal');
      if (acceptBtn) {
        acceptBtn.addEventListener('click', async function () {
          await fetch(API + '/api/initiatives/' + encodeURIComponent(initiative.id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'accepted' }),
          }).catch(function () {});
          fetchInitiativesSnapshot();
        });
      }
      if (rejectBtn) {
        rejectBtn.addEventListener('click', async function () {
          await fetch(API + '/api/initiatives/' + encodeURIComponent(initiative.id), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: 'rejected' }),
          }).catch(function () {});
          fetchInitiativesSnapshot();
        });
      }
      if (promoteGoalBtn) {
        promoteGoalBtn.addEventListener('click', async function () {
          await fetch(API + '/api/initiatives/' + encodeURIComponent(initiative.id) + '/promote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'goal' }),
          }).catch(function () {});
          fetchGoalsSnapshot();
          fetchInitiativesSnapshot();
        });
      }
      if (promoteSubgoalBtn) {
        promoteSubgoalBtn.addEventListener('click', async function () {
          var goalId = relatedGoals[0] || ((teamGoalsSnapshot.goals || [])[0] && (teamGoalsSnapshot.goals || [])[0].id);
          if (!goalId) return;
          await fetch(API + '/api/initiatives/' + encodeURIComponent(initiative.id) + '/promote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: 'subgoal', goalId: goalId }),
          }).catch(function () {});
          fetchGoalsSnapshot();
          fetchInitiativesSnapshot();
        });
      }
    }

    function renderInitiativesList() {
      var wrap = document.getElementById('team-initiatives-list');
      if (!wrap) return;
      var initiatives = Array.isArray(teamInitiativesSnapshot.initiatives) ? teamInitiativesSnapshot.initiatives.slice() : [];
      initiatives.sort(function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); });
      if (!initiatives.length) {
        selectedTeamInitiativeId = '';
        wrap.innerHTML = '<p class="team-agent-inbox-empty" style="margin:0;padding:0.5rem 0;">No initiatives yet.</p>';
        renderInitiativeDetail(null);
        return;
      }
      if (!selectedTeamInitiativeId || !initiatives.some(function (i) { return String(i.id || '') === selectedTeamInitiativeId; })) {
        selectedTeamInitiativeId = String(initiatives[0].id || '');
      }
      wrap.innerHTML = initiatives.map(function (it) {
        var id = String(it.id || '');
        var selected = id === selectedTeamInitiativeId ? ' selected' : '';
        var confidence = Math.round((Number(it.confidence) || 0) * 100);
        var status = String(it.status || 'open').toLowerCase();
        return '<div class="team-initiative-card' + selected + '" data-initiative-id="' + escapeHtml(id) + '">' +
          '<div class="team-goal-card-head">' +
            '<h4 class="team-goal-card-title">' + escapeHtml(it.title || 'Untitled initiative') + '</h4>' +
            '<span class="team-initiative-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' +
          '</div>' +
          '<div class="team-goal-meta"><span class="team-initiative-type">' + escapeHtml(it.type || 'observation') + '</span></div>' +
          '<div class="team-goal-meta"><strong>Confidence:</strong> ' + escapeHtml(String(confidence)) + '%</div>' +
          '<div class="team-goal-meta"><strong>Source:</strong> ' + escapeHtml(it.source || '') + '</div>' +
          '<div class="team-goal-meta">' + escapeHtml(String(it.description || '').slice(0, 180)) + '</div>' +
        '</div>';
      }).join('');
      renderInitiativeDetail(initiatives.find(function (i) { return String(i.id || '') === selectedTeamInitiativeId; }) || initiatives[0]);
      wrap.querySelectorAll('.team-initiative-card').forEach(function (card) {
        card.addEventListener('click', function () {
          var id = String(card.getAttribute('data-initiative-id') || '').trim();
          if (!id) return;
          selectedTeamInitiativeId = id;
          renderInitiativesList();
        });
      });
    }

    function renderTeamAgentCards() {
      var row = document.getElementById('team-agent-cards');
      if (!row) return;
      var agents = getTeamAgentsForView(agentMapData || []);
      if (!agents.length) {
        row.innerHTML = '<p class="team-agent-inbox-empty" style="margin:0;padding:0.5rem 0;">' +
          (teamViewActiveOnly ? 'No active agents right now.' : 'No agents yet.') +
        '</p>';
        return;
      }
      row.innerHTML = agents.map(function (a) {
        var id = String(a && a.id || '');
        var shortName = escapeHtml(agentCardShortName(a));
        var ctx = (teamAgentContextSnapshot.agents || {})[id] || { state: 'idle' };
        var emoji = getStateEmoji(ctx.state);
        var stateLabel = getStateTextLabel(ctx.state);
        var metrics = (teamAgentMetricsSnapshot.agents || {})[id] || {};
        var activeCount = agentCardActiveCount(ctx, metrics);
        var sel = id === selectedTeamInboxAgentId ? ' selected' : '';
        return '<div class="team-agent-card' + sel + '" data-agent-id="' + escapeHtml(id) + '" role="button" tabindex="0" title="Open ' + shortName + '">' +
          '<button type="button" class="team-agent-card-edit" data-agent-id="' + escapeHtml(id) + '" aria-label="Edit ' + escapeHtml(id) + '" title="Edit agent">✎</button>' +
          '<div class="team-agent-card-head">' + shortName + ' ' + emoji + '</div>' +
          '<div class="team-agent-card-state">' + escapeHtml(stateLabel) + '</div>' +
          '<div class="team-agent-card-active">' + escapeHtml(String(activeCount)) + ' active</div>' +
        '</div>';
      }).join('');
      row.querySelectorAll('.team-agent-card-edit').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var aid = btn.getAttribute('data-agent-id');
          if (aid) openAgentEditModal(aid);
        });
      });
      row.querySelectorAll('.team-agent-card').forEach(function (card) {
        function pick() {
          var id = card.getAttribute('data-agent-id');
          if (id) selectTeamInboxAgent(id);
        }
        card.addEventListener('click', pick);
        card.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); }
        });
      });
    }

    function renderAgentContextBullets(items) {
      if (!items || !items.length) return '';
      return '<ul class="team-agent-context-bullets">' + items.map(function (b) {
        return '<li>' + escapeHtml(String(b)) + '</li>';
      }).join('') + '</ul>';
    }

    function formatContextStateBadge(state) {
      var info = formatAgentStateDisplay(state);
      return '<span class="team-agent-context-state ' + info.className + '">' + escapeHtml(info.text) + '</span>';
    }

    function resolveAgentContextDisplay(agentId, ctx) {
      var row = ctx || { state: 'idle' };
      var state = String(row.state || 'idle').toLowerCase();
      var goal = missionLabelForAgent(agentId, row);
      var thought = String(row.currentThought || row.currentStep || '').trim();
      if (!thought && String(row.state || '') === 'idle') thought = 'Standing by for the next task.';
      var waitingOn = String(row.waitingFor || '').trim()
        ? agentNameById(row.waitingFor)
        : 'None';
      var lastAction = String(row.lastAction || '').trim() || 'None';
      return { goal: goal, thought: thought, waitingOn: waitingOn, lastAction: lastAction, state: row.state };
    }

    function renderAgentContextField(label, value, mutedWhenNone) {
      var text = String(value || '').trim() || 'None';
      var muted = mutedWhenNone && text === 'None';
      return '<div class="team-agent-context-row"><strong>' + escapeHtml(label) + '</strong>' +
        '<div class="team-agent-context-value' + (muted ? ' muted' : '') + '">' + escapeHtml(text) + '</div></div>';
    }

    function renderAgentContextCard(agentId, ctx) {
      var label = agentNameById(agentId);
      var display = resolveAgentContextDisplay(agentId, ctx);
      var html = '<div class="team-agent-context-card">' +
        '<div class="team-agent-context-card-head">' +
          '<h4>' + escapeHtml(label) + '</h4>' +
          formatContextStateBadge(display.state) +
        '</div>';
      html += renderAgentContextField('Current Mission:', display.goal, true);
      html += renderAgentContextField('Current Thought:', display.thought, false);
      html += renderAgentContextField('Waiting On:', display.waitingOn, true);
      html += renderAgentContextField('Last Action:', display.lastAction, true);
      html += '</div>';
      return html;
    }

    function renderAgentContextOverview() {
      var el = document.getElementById('team-agent-context-overview');
      if (!el) return;
      var agents = getTeamAgentsForView(agentMapData || []);
      if (!agents.length) {
        el.innerHTML = teamViewActiveOnly ? 'No active agents.' : '';
        return;
      }
      el.innerHTML = agents.map(function (a) {
        var id = String(a && a.id || '');
        var ctx = (teamAgentContextSnapshot.agents || {})[id] || { state: 'idle' };
        var label = agentDisplayLabel(a);
        var display = resolveAgentContextDisplay(id, ctx);
        var bits = [];
        if (display.goal) bits.push(display.goal);
        if (display.thought && display.thought !== 'Standing by for the next task.') {
          bits.push(display.thought);
        } else if (display.waitingOn !== 'None') {
          bits.push('Waiting on ' + display.waitingOn);
        }
        var detail = bits.length ? ' — ' + bits.join(' · ') : '';
        return '<span class="accent">' + escapeHtml(label) + '</span>' + escapeHtml(detail);
      }).join('<br>');
    }

    function renderAgentContextHistory(agentId, events) {
      var id = String(agentId || '').trim();
      var rows = (events || []).filter(function (event) {
        var aid = String(event.agentId || '').trim();
        var target = String(event.targetAgentId || '').trim();
        return aid === id || target === id;
      }).slice().sort(function (a, b) {
        return (Number(b.ts) || 0) - (Number(a.ts) || 0);
      });
      if (!rows.length) {
        return '<p class="team-agent-inbox-empty">No recorded activity for this agent in ' +
          escapeHtml(teamAgentRangeLabel(teamAgentPanelRange).toLowerCase()) + '.</p>';
      }
      var html = '<div class="team-agent-context-card"><h4>Activity in range</h4><ul class="team-agent-context-bullets">';
      rows.slice(0, 40).forEach(function (event) {
        var time = formatInboxTime(event.ts);
        var line = formatTeamActivityText(event);
        html += '<li><span class="skill-meta">' + escapeHtml(time) + '</span> — ' + line + '</li>';
      });
      html += '</ul></div>';
      return html;
    }

    function renderAgentContext() {
      renderAgentContextOverview();
      var detail = document.getElementById('team-agent-context-detail');
      var titleEl = document.getElementById('team-agent-context-title');
      var subEl = document.getElementById('team-agent-context-subtitle');
      var rangeLabel = teamAgentRangeLabel(teamAgentPanelRange);
      if (!detail) return;
      if (!selectedTeamInboxAgentId) {
        if (titleEl) titleEl.textContent = 'Active Context';
        if (subEl) subEl.textContent = rangeLabel + ' — present working memory';
        detail.innerHTML = '<p class="team-agent-inbox-empty">Select an agent to see what they are thinking about right now.</p>';
        return;
      }
      var label = agentNameById(selectedTeamInboxAgentId);
      if (titleEl) titleEl.textContent = label + ' — Active Context';
      if (teamAgentPanelRange === 'today') {
        if (subEl) subEl.textContent = 'What this agent is thinking about right now';
        var ctx = (teamAgentContextSnapshot.agents || {})[selectedTeamInboxAgentId] || { state: 'idle' };
        detail.innerHTML = renderAgentContextCard(selectedTeamInboxAgentId, ctx);
        return;
      }
      if (subEl) subEl.textContent = rangeLabel + ' — activity from team log';
      detail.innerHTML = renderAgentContextHistory(
        selectedTeamInboxAgentId,
        teamActivityEventsForRange(teamAgentPanelRange)
      );
    }

    function renderAgentMetricsCard(agentId, metrics) {
      var label = agentNameById(agentId);
      var row = metrics || {
        tasksHandled: 0,
        delegatedOut: 0,
        receivedFromOthers: 0,
        averageExecutionSec: '0s',
        mostUsedSkills: [],
      };
      var html = '<div class="team-agent-metrics-card"><h4>' + escapeHtml(label) + '</h4>';
      html += '<div class="team-agent-metrics-row"><strong>Tasks handled:</strong> ' + escapeHtml(String(row.tasksHandled || 0)) + '</div>';
      html += '<div class="team-agent-metrics-row"><strong>Delegated out:</strong> ' + escapeHtml(String(row.delegatedOut || 0)) + '</div>';
      html += '<div class="team-agent-metrics-row"><strong>Received from others:</strong> ' + escapeHtml(String(row.receivedFromOthers || 0)) + '</div>';
      html += '<div class="team-agent-metrics-row"><strong>Average execution:</strong> ' + escapeHtml(String(row.averageExecutionSec || '0s')) + '</div>';
      html += '<div class="team-agent-metrics-row"><strong>Most used skills:</strong>';
      var skills = Array.isArray(row.mostUsedSkills) ? row.mostUsedSkills : [];
      if (!skills.length) {
        html += '<br><span class="skill-meta">No skill usage recorded yet.</span>';
      } else {
        html += '<ul class="team-agent-metrics-skills">';
        skills.forEach(function (s) {
          var sid = typeof s === 'string' ? s : (s && s.skillId ? s.skillId : '');
          if (!sid) return;
          html += '<li>' + escapeHtml(sid) + '</li>';
        });
        html += '</ul>';
      }
      html += '</div></div>';
      return html;
    }

    function renderAgentMetrics() {
      var detail = document.getElementById('team-agent-stats-detail');
      var titleEl = document.getElementById('team-agent-stats-title');
      var subEl = document.getElementById('team-agent-stats-subtitle');
      if (!detail) return;
      var rangeLabel = teamAgentRangeLabel(teamAgentPanelRange);
      if (!selectedTeamInboxAgentId) {
        if (titleEl) titleEl.textContent = 'Agent Metrics';
        if (subEl) subEl.textContent = rangeLabel + ' — historical performance';
        detail.innerHTML = '<p class="team-agent-inbox-empty">Select an agent to view task and skill statistics.</p>';
        return;
      }
      var label = agentNameById(selectedTeamInboxAgentId);
      if (titleEl) titleEl.textContent = label + ' — Stats';
      if (subEl) subEl.textContent = rangeLabel + ' — tasks, delegation, and skill usage';
      var metrics = (teamAgentMetricsSnapshot.agents || {})[selectedTeamInboxAgentId] || null;
      if (!metrics) {
        detail.innerHTML = '<p class="team-agent-inbox-empty">Loading stats for ' + escapeHtml(label) + '…</p>';
        return;
      }
      detail.innerHTML = renderAgentMetricsCard(selectedTeamInboxAgentId, metrics);
    }

    function fmtMatchPct(value) {
      var n = Number(value);
      if (!isFinite(n)) return '0%';
      if (n > 1) n = n / 100;
      return Math.round(Math.max(0, Math.min(1, n)) * 100) + '%';
    }

    function renderRoutingFactors(routing) {
      if (!routing || typeof routing !== 'object') return '';
      var html = '<div class="team-agent-inbox-routing">';
      if (routing.reason) {
        html += '<div class="team-agent-inbox-block"><strong>Why this agent:</strong><br>' +
          escapeHtml(routing.reason) + '</div>';
      }
      if (routing.routingMethod === 'llm') {
        var llmLine = 'Semantic router (LLM)';
        if (routing.keywordAction) llmLine += ' — keyword was: ' + routing.keywordAction;
        if (routing.llmReason) llmLine += '<br>' + escapeHtml(routing.llmReason);
        if (routing.llmConfidence != null) {
          llmLine += '<br>LLM confidence: ' + fmtMatchPct(routing.llmConfidence);
        }
        html += '<div class="team-agent-inbox-block"><strong>Routing:</strong><br>' + llmLine + '</div>';
      } else if (routing.routingMethod === 'keyword') {
        html += '<div class="team-agent-inbox-block"><strong>Routing:</strong> keyword match</div>';
      }
      var selected = String(routing.selected || routing.selectedAgentId || '').trim();
      if (selected) {
        var selScore = Number(routing.selectedScore);
        var selLine = escapeHtml(agentNameById(selected));
        if (isFinite(selScore)) selLine += ' — score ' + selScore;
        if (routing.selectedConfidence != null) selLine += ' (' + fmtMatchPct(routing.selectedConfidence) + ')';
        var skills = Array.isArray(routing.selectedMatchedSkills) ? routing.selectedMatchedSkills : [];
        var concepts = Array.isArray(routing.selectedMatchedConcepts) ? routing.selectedMatchedConcepts : [];
        if (skills.length) selLine += '<br>Skills: ' + escapeHtml(skills.join(', '));
        if (concepts.length) selLine += '<br>Topics: ' + escapeHtml(concepts.join(', '));
        html += '<div class="team-agent-inbox-block"><strong>Selected:</strong><br>' + selLine + '</div>';
      }
      var candidates = Array.isArray(routing.candidates) ? routing.candidates : [];
      if (candidates.length) {
        html += '<div class="team-agent-inbox-block"><strong>Contributing factors (team scores):</strong><ul class="team-agent-inbox-skills">';
        candidates.forEach(function (c) {
          var line = escapeHtml(agentNameById(c.agentId)) + ' — score ' + (Number(c.score) || 0) +
            ' (' + fmtMatchPct(c.confidence) + ')';
          if (c.matchedSkills && c.matchedSkills.length) {
            line += '<br>Skills: ' + escapeHtml(c.matchedSkills.join(', '));
          }
          if (c.matchedConcepts && c.matchedConcepts.length) {
            line += '<br>Topics: ' + escapeHtml(c.matchedConcepts.join(', '));
          }
          if (c.reasoning) {
            line += '<br><span style="color:var(--muted)">' + escapeHtml(c.reasoning) + '</span>';
          }
          html += '<li>' + line + '</li>';
        });
        html += '</ul></div>';
      }
      html += '</div>';
      return html;
    }

    function buildAgentInboxFlows(agentId, rangeOverride) {
      var id = String(agentId || '').trim();
      if (!id) return [];
      var rangeKey = String(rangeOverride || '').trim();
      if (!TEAM_AGENT_RANGE_LABELS[rangeKey]) rangeKey = teamAgentPanelRange;
      var events = teamActivityEventsForRange(rangeKey).slice().sort(function (a, b) {
        return (Number(a.ts) || 0) - (Number(b.ts) || 0);
      });
      var flows = [];
      var current = null;

      function pushDecision(event, forAssignee) {
        var d = event.details || {};
        var candidates = Array.isArray(d.candidates) ? d.candidates : [];
        flows.push({
          ts: event.ts,
          entries: [{
            type: 'delegation_decision',
            ts: event.ts,
            target: event.targetAgentId || d.selected || '',
            reason: d.reason || '',
            candidates: candidates,
            selected: d.selected || event.targetAgentId || '',
            selectedConfidence: d.selectedConfidence,
            selectedScore: d.selectedScore,
            routing: d,
            mailboxDirection: forAssignee ? 'inbox' : 'outbox',
            label: forAssignee ? ('Assigned to you from ' + agentNameById(event.agentId)) : ('Delegated to ' + agentNameById(event.targetAgentId || d.selected)),
          }],
        });
      }

      events.forEach(function (event) {
        var type = String(event.type || '');
        if (type === 'team_capability_evaluation' && event.agentId === id) {
          var evalDetails = event.details || {};
          flows.push({
            ts: event.ts,
            entries: [{
              type: 'capability_evaluation',
              ts: event.ts,
              action: evalDetails.action || '',
              reason: evalDetails.reason || event.message || '',
              routing: evalDetails,
              mailboxDirection: 'inbox',
              label: 'Routing evaluated (handled here)',
            }],
          });
          return;
        }
        if (type === 'delegation_decision' && event.agentId === id) {
          pushDecision(event, false);
          return;
        }
        if (type === 'delegation_decision' && (event.targetAgentId === id || (event.details && event.details.selected === id))) {
          pushDecision(event, true);
          return;
        }
        if (type === 'delegation_start' && event.agentId === id) {
          var dStart = event.details && event.details.inbox ? event.details.inbox : {};
          var routingOut = (event.details && event.details.routing) || dStart.routing || null;
          flows.push({
            ts: event.ts,
            entries: [{
              type: 'delegated_out',
              ts: event.ts,
              to: event.targetAgentId || dStart.toAgentId || '',
              task: dStart.task || '',
              context: dStart.context || '',
              routing: routingOut,
              mailboxDirection: 'outbox',
            }],
          });
          return;
        }
        if (type === 'delegation_start' && event.targetAgentId === id) {
          var dAssign = event.details && event.details.inbox ? event.details.inbox : {};
          var routingIn = (event.details && event.details.routing) || dAssign.routing || null;
          flows.push({
            ts: event.ts,
            entries: [{
              type: 'assigned_to_you',
              ts: event.ts,
              from: event.agentId || dAssign.fromAgentId || '',
              task: dAssign.task || '',
              context: dAssign.context || '',
              routing: routingIn,
              mailboxDirection: 'inbox',
            }],
          });
          return;
        }
        if (event.agentId !== id) return;

        if (type === 'turn_start') {
          if (current) flows.push(current);
          current = { ts: event.ts, skills: [], entries: [] };
          var inbox = event.details && event.details.inbox ? event.details.inbox : null;
          if (inbox && inbox.kind === 'received_from') {
            var routingRecv = inbox.routing || null;
            current.entries.push({
              type: 'received_from',
              ts: event.ts,
              from: inbox.fromAgentId || '',
              task: inbox.task || event.message || '',
              context: inbox.context || '',
              routing: routingRecv,
              mailboxDirection: 'inbox',
            });
          } else {
            current.entries.push({
              type: 'received',
              ts: event.ts,
              task: (inbox && inbox.task) || event.message || '',
              context: (inbox && inbox.context) || '',
              mailboxDirection: 'inbox',
            });
          }
          return;
        }
        if (type === 'skill_start' && current) {
          var sid = String(event.skillId || '').trim();
          if (sid && current.skills.indexOf(sid) === -1) current.skills.push(sid);
          return;
        }
        if (type === 'turn_done' && current) {
          var doneInbox = event.details && event.details.inbox ? event.details.inbox : null;
          var skills = (doneInbox && Array.isArray(doneInbox.skills) && doneInbox.skills.length)
            ? doneInbox.skills.slice()
            : current.skills.slice();
          if (skills.length) {
            var skillsLabel = (current.entries[0] && current.entries[0].type === 'received') ? 'Used:' : 'Using skills:';
            current.entries.push({ type: 'skills', ts: event.ts, skills: skills, label: skillsLabel, mailboxDirection: 'inbox' });
          }
          if (doneInbox && doneInbox.kind === 'returned_to') {
            current.entries.push({
              type: 'returned',
              ts: event.ts,
              to: doneInbox.toAgentId || '',
              result: doneInbox.result || '',
              mailboxDirection: 'outbox',
            });
          } else {
            current.entries.push({
              type: 'completed',
              ts: event.ts,
              result: (doneInbox && doneInbox.result) || '',
              mailboxDirection: 'inbox',
            });
          }
          flows.push(current);
          current = null;
        }
      });
      if (current) flows.push(current);
      return flows.reverse();
    }

    var OUTBOX_MAILBOX_TYPES = { delegated_out: 1, returned: 1 };

    function entryMailboxDirection(entry) {
      if (entry && entry.mailboxDirection) return entry.mailboxDirection;
      if (entry && entry.type === 'delegation_decision') {
        return String(entry.label || '').indexOf('Assigned to you') === 0 ? 'inbox' : 'outbox';
      }
      if (entry && OUTBOX_MAILBOX_TYPES[entry.type]) return 'outbox';
      return 'inbox';
    }

    function filterFlowsForMailbox(flows, direction) {
      return flows.map(function (flow) {
        var entries = (flow.entries || []).filter(function (entry) {
          return entryMailboxDirection(entry) === direction;
        });
        if (!entries.length) return null;
        return { ts: flow.ts, entries: entries };
      }).filter(Boolean);
    }

    function renderInboxEntry(entry) {
      var time = formatInboxTime(entry.ts);
      var ts = Number(entry && entry.ts) || 0;
      var html = '<div class="team-agent-inbox-entry" data-ts="' + escapeHtml(String(ts)) + '"><div class="team-agent-inbox-time">' + escapeHtml(time) + '</div>';
      if (entry.type === 'delegation_decision') {
        html += '<div class="team-agent-inbox-label">' + escapeHtml(entry.label || ('Delegated to ' + agentNameById(entry.target))) + '</div>';
        html += renderRoutingFactors(entry.routing || {
          reason: entry.reason,
          selected: entry.selected || entry.target,
          selectedScore: entry.selectedScore,
          selectedConfidence: entry.selectedConfidence,
          candidates: entry.candidates,
        });
        html += '</div>';
        return html;
      }
      if (entry.type === 'assigned_to_you') {
        html += '<div class="team-agent-inbox-label">Assigned from ' + escapeHtml(agentNameById(entry.from)) + '</div>';
        if (entry.task) html += '<div class="team-agent-inbox-block"><strong>Task:</strong><br>"' + escapeHtml(entry.task) + '"</div>';
        if (entry.context) html += '<div class="team-agent-inbox-block"><strong>Context:</strong><br>' + escapeHtml(entry.context) + '</div>';
        html += renderRoutingFactors(entry.routing);
        html += '</div>';
        return html;
      }
      if (entry.type === 'delegated_out') {
        html += '<div class="team-agent-inbox-label">Delegated to ' + escapeHtml(agentNameById(entry.to)) + '</div>';
        if (entry.task) html += '<div class="team-agent-inbox-block"><strong>Task:</strong><br>"' + escapeHtml(entry.task) + '"</div>';
        if (entry.context) html += '<div class="team-agent-inbox-block"><strong>Context:</strong><br>' + escapeHtml(entry.context) + '</div>';
        html += renderRoutingFactors(entry.routing);
        html += '</div>';
        return html;
      }
      if (entry.type === 'received_from') {
        html += '<div class="team-agent-inbox-label">Received from ' + escapeHtml(agentNameById(entry.from)) + '</div>';
        if (entry.task) html += '<div class="team-agent-inbox-block"><strong>Task:</strong><br>"' + escapeHtml(entry.task) + '"</div>';
        if (entry.context) html += '<div class="team-agent-inbox-block"><strong>Context:</strong><br>' + escapeHtml(entry.context) + '</div>';
        html += renderRoutingFactors(entry.routing);
        html += '</div>';
        return html;
      }
      if (entry.type === 'received') {
        html += '<div class="team-agent-inbox-label">Received:</div>';
        if (entry.task) html += '<div class="team-agent-inbox-block">' + escapeHtml(entry.task) + '</div>';
        if (entry.context) html += '<div class="team-agent-inbox-block"><strong>Context:</strong><br>' + escapeHtml(entry.context) + '</div>';
        html += '</div>';
        return html;
      }
      if (entry.type === 'skills') {
        html += '<div class="team-agent-inbox-label">' + escapeHtml(entry.label || 'Using skills:') + '</div><ul class="team-agent-inbox-skills">';
        entry.skills.forEach(function (s) {
          html += '<li>' + escapeHtml(s) + '</li>';
        });
        html += '</ul></div>';
        return html;
      }
      if (entry.type === 'returned') {
        html += '<div class="team-agent-inbox-label">Returned response to ' + escapeHtml(agentNameById(entry.to)) + '</div>';
        if (entry.result) html += '<div class="team-agent-inbox-block"><strong>Result:</strong><br>' + escapeHtml(entry.result) + '</div>';
        html += '</div>';
        return html;
      }
      if (entry.type === 'completed') {
        html += '<div class="team-agent-inbox-label">Completed</div>';
        if (entry.result) html += '<div class="team-agent-inbox-block"><strong>Result:</strong><br>' + escapeHtml(entry.result) + '</div>';
        html += '</div>';
        return html;
      }
      if (entry.type === 'capability_evaluation') {
        html += '<div class="team-agent-inbox-label">' + escapeHtml(entry.label || 'Routing evaluated') + '</div>';
        if (entry.action) {
          html += '<div class="team-agent-inbox-block"><strong>Action:</strong> ' + escapeHtml(entry.action) + '</div>';
        }
        html += renderRoutingFactors(entry.routing || { reason: entry.reason });
        html += '</div>';
        return html;
      }
      html += '</div>';
      return html;
    }

    function renderAgentMailboxList(opts) {
      var list = document.getElementById(opts.listId);
      var titleEl = document.getElementById(opts.titleId);
      var subEl = document.getElementById(opts.subtitleId);
      if (!list) return;
      if (!selectedTeamInboxAgentId) {
        if (titleEl) titleEl.textContent = opts.emptyTitle;
        if (subEl) subEl.textContent = opts.emptySubtitle;
        list.innerHTML = '<p class="team-agent-inbox-empty">' + escapeHtml(opts.selectPrompt) + '</p>';
        return;
      }
      var label = agentNameById(selectedTeamInboxAgentId);
      var rangeLabel = teamAgentRangeLabel(teamAgentPanelRange);
      if (titleEl) titleEl.textContent = label + ' — ' + opts.panelLabel;
      if (subEl) subEl.textContent = rangeLabel + ' — ' + opts.panelSubtitle;
      var flows = filterFlowsByTeamAgentRange(
        filterFlowsForMailbox(buildAgentInboxFlows(selectedTeamInboxAgentId), opts.direction),
        teamAgentPanelRange
      );
      if (!flows.length) {
        list.innerHTML = '<p class="team-agent-inbox-empty">' +
          escapeHtml(opts.noActivityText.replace('{agent}', label).replace('{range}', rangeLabel.toLowerCase())) + '</p>';
        return;
      }
      list.innerHTML = flows.map(function (flow) {
        return '<div class="team-agent-inbox-flow">' +
          flow.entries.map(renderInboxEntry).join('') +
        '</div>';
      }).join('');
    }

    function renderAgentInbox() {
      renderAgentMailboxList({
        listId: 'team-agent-inbox-list',
        titleId: 'team-agent-inbox-title',
        subtitleId: 'team-agent-inbox-subtitle',
        direction: 'inbox',
        emptyTitle: 'Agent Inbox',
        emptySubtitle: 'Tasks and assignments received',
        panelLabel: 'Inbox',
        panelSubtitle: 'Incoming tasks, assignments, and routing when chosen',
        selectPrompt: 'Select an agent to view incoming activity.',
        noActivityText: 'No inbox activity for {agent} in {range}.',
      });
    }

    function renderAgentOutbox() {
      renderAgentMailboxList({
        listId: 'team-agent-outbox-list',
        titleId: 'team-agent-outbox-title',
        subtitleId: 'team-agent-outbox-subtitle',
        direction: 'outbox',
        emptyTitle: 'Agent Outbox',
        emptySubtitle: 'Delegations and replies sent',
        panelLabel: 'Outbox',
        panelSubtitle: 'outgoing delegations, routing decisions, and replies',
        selectPrompt: 'Select an agent to view outgoing activity.',
        noActivityText: 'No outbox activity for {agent} in {range}.',
      });
    }

    function formatTeamActivityText(event) {
      var type = String(event && event.type || '');
      var agent = agentNameById(String(event && event.agentId || ''));
      var target = agentNameById(String(event && event.targetAgentId || ''));
      var skill = String(event && event.skillId || '');
      var action = String(event && event.action || '');
      var msg = String(event && event.message || '');
      var details = event && typeof event.details === 'object' ? event.details : null;
      function fmtConfidence(value) {
        var n = Number(value);
        if (!isFinite(n)) return '0.00';
        if (n < 0) n = 0;
        if (n > 1) n = 1;
        return n.toFixed(2);
      }
      function renderDecisionDetails() {
        if (!details) return '';
        var reason = String(details.reason || '').trim();
        var selected = details.selected ? agentNameById(String(details.selected)) : target;
        var selectedConf = Number(details.selectedConfidence);
        var candidates = Array.isArray(details.candidates) ? details.candidates : [];
        var candidateLines = candidates.map(function (c) {
          var label = agentNameById(String(c && c.agentId || ''));
          var conf = fmtConfidence(c && c.confidence);
          var score = Number(c && c.score);
          var scoreTxt = isFinite(score) ? (' score ' + score) : '';
          return '- ' + escapeHtml(label || 'agent') + scoreTxt + ' (' + conf + ')';
        });
        var out = '';
        if (reason) out += '<br><strong>Reason:</strong> ' + escapeHtml(reason);
        if (candidateLines.length) out += '<br><strong>Candidate Agents:</strong><br>' + candidateLines.join('<br>');
        if (selected) {
          out += '<br><strong>Selected:</strong> ' + escapeHtml(selected);
          if (isFinite(selectedConf)) out += ' (' + fmtConfidence(selectedConf) + ')';
        }
        return out;
      }
      if (type === 'delegation_decision') {
        return '<span class="accent">' + escapeHtml(agent || 'agent') + '</span> delegated to <span class="accent">' + escapeHtml(target || 'agent') + '</span>.' + renderDecisionDetails();
      }
      if (type === 'delegation_start') {
        var routeNote = msg ? ' ' + escapeHtml(msg) + '.' : '';
        return '<span class="accent">' + escapeHtml(agent || 'agent') + '</span> delegated to <span class="accent">' + escapeHtml(target || 'agent') + '</span>.' + routeNote;
      }
      if (type === 'delegation_done') {
        var doneNote = msg ? ' ' + escapeHtml(msg) + '.' : '';
        return '<span class="accent">' + escapeHtml(agent || 'agent') + '</span> received a reply from <span class="accent">' + escapeHtml(target || 'agent') + '</span>.' + doneNote;
      }
      if (type === 'delegation_error') {
        return '<span class="accent">' + escapeHtml(agent || 'agent') + '</span> failed delegating to <span class="accent">' + escapeHtml(target || 'agent') + '</span>: ' + escapeHtml(msg || 'Error');
      }
      if (type === 'skill_start') {
        var task = action ? (skill + ':' + action) : skill;
        return '<span class="accent">' + escapeHtml(agent || 'agent') + '</span> started <span class="accent">' + escapeHtml(task || 'task') + '</span>.';
      }
      if (type === 'skill_done') {
        return '<span class="accent">' + escapeHtml(agent || 'agent') + '</span> completed <span class="accent">' + escapeHtml(skill || 'task') + '</span>.';
      }
      if (type === 'skill_error') {
        return '<span class="accent">' + escapeHtml(agent || 'agent') + '</span> failed <span class="accent">' + escapeHtml(skill || 'task') + '</span>: ' + escapeHtml(msg || 'Error');
      }
      if (type === 'turn_start') {
        return '<span class="accent">' + escapeHtml(agent || 'agent') + '</span> took a new task: ' + escapeHtml(msg || 'request');
      }
      if (type === 'turn_done') {
        return '<span class="accent">' + escapeHtml(agent || 'agent') + '</span> finished the task. ' + escapeHtml(msg || '');
      }
      if (msg) return escapeHtml(msg);
      return escapeHtml(type || 'event');
    }

    function formatTeamActivitySubline(event) {
      var type = String(event && event.type || '');
      var agent = agentNameById(String(event && event.agentId || ''));
      var target = agentNameById(String(event && event.targetAgentId || ''));
      var skill = String(event && event.skillId || '');
      var action = String(event && event.action || '');
      var msg = String(event && event.message || '');
      if (type === 'skill_start') {
        var task = action ? (skill + ':' + action) : skill;
        return 'Started <span class="accent">' + escapeHtml(task || 'task') + '</span>.';
      }
      if (type === 'skill_done') {
        var doneLabel = action ? (skill + ':' + action) : skill;
        return 'Completed <span class="accent">' + escapeHtml(doneLabel || 'task') + '</span>.';
      }
      if (type === 'skill_error') {
        return 'Failed <span class="accent">' + escapeHtml(skill || 'task') + '</span>: ' + escapeHtml(msg || 'Error');
      }
      if (type === 'turn_start') {
        return 'New task: ' + escapeHtml(msg || 'request');
      }
      if (type === 'turn_done') {
        return 'Finished the task. ' + escapeHtml(msg || '');
      }
      if (type === 'delegation_decision') {
        return 'Delegated to <span class="accent">' + escapeHtml(target || 'agent') + '</span>.';
      }
      if (type === 'delegation_start') {
        var routeNote = msg ? (' — ' + escapeHtml(msg)) : '';
        return 'Delegated to <span class="accent">' + escapeHtml(target || 'agent') + '</span>.' + routeNote;
      }
      if (type === 'delegation_done') {
        var doneNote = msg ? (' — ' + escapeHtml(msg)) : '';
        return 'Reply from <span class="accent">' + escapeHtml(target || 'agent') + '</span>.' + doneNote;
      }
      if (type === 'delegation_error') {
        return 'Delegation to <span class="accent">' + escapeHtml(target || 'agent') + '</span> failed: ' + escapeHtml(msg || 'Error');
      }
      if (msg) return escapeHtml(msg);
      return escapeHtml(type || 'event');
    }

    function activityLineKey(line) {
      return String(line || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
    }

    function pushUniqueActivityLine(group, line) {
      if (!line) return;
      if (!group._keys) group._keys = {};
      var key = activityLineKey(line);
      if (!key || group._keys[key]) return;
      group._keys[key] = true;
      group.lines.push(line);
    }

    function compressTurnSkillEvents(events) {
      var out = [];
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        var type = String(ev && ev.type || '');
        if (type === 'skill_start') {
          var next = events[i + 1];
          if (next && String(next.type || '') === 'skill_done' && String(next.skillId || '') === String(ev.skillId || '')) {
            out.push({
              type: 'skill_done',
              agentId: next.agentId || ev.agentId,
              skillId: next.skillId || ev.skillId,
              action: ev.action || next.action || '',
              ts: next.ts || ev.ts,
              message: next.message || ev.message || '',
            });
            i++;
            continue;
          }
        }
        out.push(ev);
      }
      return out;
    }

    function groupTeamActivityEvents(events) {
      var sorted = (events || []).slice().sort(function (a, b) {
        return (Number(a && a.ts) || 0) - (Number(b && b.ts) || 0);
      });
      var groups = [];
      var openTurn = {}; // agentId -> group index

      function closeTurn(agentId) {
        delete openTurn[String(agentId || '')];
      }

      function startTurn(ev) {
        var aid = String(ev.agentId || '');
        closeTurn(aid);
        var group = {
          ts: Number(ev.ts) || 0,
          agentId: aid,
          events: [ev],
          lines: [],
          _keys: {},
        };
        pushUniqueActivityLine(group, formatTeamActivitySubline(ev));
        openTurn[aid] = groups.length;
        groups.push(group);
        return group;
      }

      function appendToTurn(ev, group) {
        group.events.push(ev);
        group.ts = Math.max(group.ts || 0, Number(ev.ts) || 0);
        pushUniqueActivityLine(group, formatTeamActivitySubline(ev));
      }

      function appendSkillToTurn(ev) {
        var aid = String(ev.agentId || '');
        var idx = openTurn[aid];
        if (idx === undefined) return false;
        var group = groups[idx];
        group.events.push(ev);
        group.ts = Math.max(group.ts || 0, Number(ev.ts) || 0);
        return true;
      }

      function flushSkillBuffer(buffer) {
        if (!buffer.length) return;
        var first = buffer[0];
        var aid = String(first.agentId || '');
        var group = {
          ts: Math.max.apply(null, buffer.map(function (e) { return Number(e.ts) || 0; })),
          agentId: aid,
          events: buffer.slice(),
          lines: [],
          _keys: {},
        };
        compressTurnSkillEvents(buffer).forEach(function (ev) {
          pushUniqueActivityLine(group, formatTeamActivitySubline(ev));
        });
        if (group.lines.length) groups.push(group);
      }

      var skillBuffer = [];
      var skillBufferAgent = '';
      var skillBufferBucket = -1;

      function skillBucket(ts) {
        return Math.floor((Number(ts) || 0) / 60000);
      }

      function flushSkillBufferIfNeeded(ev) {
        if (!skillBuffer.length) return;
        var aid = String(ev && ev.agentId || '');
        var bucket = skillBucket(ev && ev.ts);
        if (aid !== skillBufferAgent || bucket !== skillBufferBucket) {
          flushSkillBuffer(skillBuffer);
          skillBuffer = [];
          skillBufferAgent = '';
          skillBufferBucket = -1;
        }
      }

      sorted.forEach(function (ev) {
        var type = String(ev && ev.type || '');
        var aid = String(ev && ev.agentId || '');

        if (type === 'turn_start') {
          flushSkillBufferIfNeeded(ev);
          flushSkillBuffer(skillBuffer);
          skillBuffer = [];
          startTurn(ev);
          return;
        }

        if (type === 'turn_done') {
          flushSkillBufferIfNeeded(ev);
          flushSkillBuffer(skillBuffer);
          skillBuffer = [];
          var idx = openTurn[aid];
          if (idx !== undefined) {
            appendToTurn(ev, groups[idx]);
            closeTurn(aid);
          } else {
            var solo = {
              ts: Number(ev.ts) || 0,
              agentId: aid,
              events: [ev],
              lines: [],
              _keys: {},
            };
            pushUniqueActivityLine(solo, formatTeamActivitySubline(ev));
            groups.push(solo);
          }
          return;
        }

        if (type === 'skill_start' || type === 'skill_done' || type === 'skill_error') {
          if (appendSkillToTurn(ev)) return;
          flushSkillBufferIfNeeded(ev);
          var bucket = skillBucket(ev.ts);
          if (skillBuffer.length && (aid !== skillBufferAgent || bucket !== skillBufferBucket)) {
            flushSkillBuffer(skillBuffer);
            skillBuffer = [];
          }
          skillBuffer.push(ev);
          skillBufferAgent = aid;
          skillBufferBucket = bucket;
          return;
        }

        flushSkillBufferIfNeeded(ev);
        flushSkillBuffer(skillBuffer);
        skillBuffer = [];
        closeTurn(aid);
        var standalone = {
          ts: Number(ev.ts) || 0,
          agentId: aid,
          events: [ev],
          lines: [],
          _keys: {},
        };
        pushUniqueActivityLine(standalone, formatTeamActivityText(ev));
        groups.push(standalone);
      });

      flushSkillBuffer(skillBuffer);

      groups.forEach(function (group) {
        if (!group.events || group.events.length <= 1) {
          delete group._keys;
          delete group.events;
          return;
        }
        var compressed = compressTurnSkillEvents(group.events);
        group.lines = [];
        group._keys = {};
        compressed.forEach(function (ev) {
          var evType = String(ev.type || '');
          if (evType.indexOf('skill_') === 0 || evType === 'turn_start' || evType === 'turn_done') {
            pushUniqueActivityLine(group, formatTeamActivitySubline(ev));
          } else {
            pushUniqueActivityLine(group, formatTeamActivityText(ev));
          }
        });
        delete group._keys;
        delete group.events;
      });

      return groups.sort(function (a, b) {
        return (Number(b.ts) || 0) - (Number(a.ts) || 0);
      });
    }

    function renderTeamActivityGroupRow(group, opts) {
      opts = opts || {};
      var ts = Number(group && group.ts) || 0;
      var agentId = String(group && group.agentId || '');
      var lines = Array.isArray(group && group.lines) ? group.lines : [];
      if (!lines.length) return '';
      var timeHtml = opts.timeHtml;
      if (timeHtml === undefined) {
        timeHtml = escapeHtml(new Date(ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      }
      var agentLabel = escapeHtml(agentNameById(agentId) || 'agent');
      var linesHtml = lines.map(function (line) {
        return '<div class="mc-activity-line">' + line + '</div>';
      }).join('');
      if (opts.style === 'team') {
        return '<div class="team-activity-item" data-ts="' + escapeHtml(String(ts)) + '">' +
          '<div class="team-activity-time">' + timeHtml + '</div>' +
          '<div class="team-activity-text">' +
            '<div class="mc-activity-agent"><span class="accent">' + agentLabel + '</span></div>' +
            '<div class="mc-activity-lines">' + linesHtml + '</div>' +
          '</div>' +
        '</div>';
      }
      var a = (agentMapData || []).find(function (x) { return String(x.id) === agentId; }) || { id: agentId };
      var avatarHtml = typeof mc2AvatarHtml === 'function' ? mc2AvatarHtml(a) : '';
      return '<div class="mc-movement-item mc-activity-group" data-ts="' + escapeHtml(String(ts)) + '">' +
        '<span class="mc-movement-time">' + timeHtml + '</span>' +
        avatarHtml +
        '<div class="mc-activity-body">' +
          '<div class="mc-activity-agent"><span class="accent">' + agentLabel + '</span></div>' +
          '<div class="mc-activity-lines">' + linesHtml + '</div>' +
        '</div>' +
      '</div>';
    }

    function renderTeamActivity() {
      var list = document.getElementById('team-activity-list');
      var statusEl = document.getElementById('team-activity-status');
      if (!list) return;
      if (!teamActivityEvents.length) {
        list.innerHTML = '<p class="team-activity-empty">No activity yet.</p>';
        if (statusEl) statusEl.textContent = 'Idle';
        return;
      }
      var recentTs = teamActivityEvents[teamActivityEvents.length - 1].ts || 0;
      if (statusEl) {
        var ageMs = Math.max(0, Date.now() - recentTs);
        statusEl.textContent = ageMs < 6000 ? 'Live' : 'Waiting';
      }
      var groups = groupTeamActivityEvents(teamActivityEvents.slice(-120)).slice(0, 40);
      var rows = groups.map(function (group) {
        var time = new Date(group.ts || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        return renderTeamActivityGroupRow(group, { style: 'team', timeHtml: escapeHtml(time) });
      }).join('');
      list.innerHTML = rows || '<p class="team-activity-empty">No activity yet.</p>';
    }

    var teamRailExpanded = {
      activity: false,
      context: false,
      inbox: false,
      outbox: false,
      stats: false,
    };
    var TEAM_RAIL_LABELS = {
      activity: 'Activity',
      context: 'Context',
      inbox: 'Inbox',
      outbox: 'Outbox',
      stats: 'Stats',
    };

    function setTeamRailExpanded(key, nextExpanded) {
      if (!Object.prototype.hasOwnProperty.call(teamRailExpanded, key)) return;
      var opening = !!nextExpanded;
      if (opening) {
        Object.keys(teamRailExpanded).forEach(function (k) {
          teamRailExpanded[k] = k === key;
        });
      } else {
        teamRailExpanded[key] = false;
      }
      Object.keys(TEAM_RAIL_LABELS).forEach(function (k) {
        var wrap = document.getElementById('team-' + k + '-wrap');
        var toggle = document.getElementById('team-' + k + '-toggle');
        if (!wrap || !toggle) return;
        var expanded = !!teamRailExpanded[k];
        var label = TEAM_RAIL_LABELS[k] || k;
        wrap.classList.toggle('expanded', expanded);
        wrap.classList.toggle('collapsed', !expanded);
        toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        toggle.textContent = expanded ? 'Collapse' : label;
        toggle.title = expanded
          ? ('Collapse ' + label.toLowerCase() + ' panel')
          : ('Expand ' + label.toLowerCase() + ' panel');
      });
    }

    function setTeamActivityExpanded(nextExpanded) {
      setTeamRailExpanded('activity', nextExpanded);
    }

    async function fetchTeamActivityFeed() {
      try {
        var q = '?since=' + encodeURIComponent(String(teamActivityLastTs || 0)) + '&limit=100';
        var r = await fetch(API + '/api/team/activity' + q);
        if (!r.ok) return;
        var d = await r.json().catch(function () { return {}; });
        var events = Array.isArray(d.events) ? d.events : [];
        if (!events.length) {
          renderTeamActivity();
          return;
        }
        events.forEach(function (event) {
          var id = String(event && event.id || '');
          if (!id || teamActivityEventIds[id]) return;
          teamActivityEventIds[id] = true;
          teamActivityEvents.push(event);
          if (Number(event.ts) > teamActivityLastTs) teamActivityLastTs = Number(event.ts);
        });
        if (teamActivityEvents.length > TEAM_ACTIVITY_MAX_ITEMS) {
          teamActivityEvents = teamActivityEvents.slice(-TEAM_ACTIVITY_MAX_ITEMS);
          teamActivityEventIds = {};
          teamActivityEvents.forEach(function (event) {
            if (event && event.id) teamActivityEventIds[event.id] = true;
          });
        }
      } catch (_) {}
      renderTeamActivity();
      renderAgentInbox();
      renderAgentOutbox();
      renderAgentContext();
      renderTeamTaskSummary();
      if (document.getElementById('page-team2') && document.getElementById('page-team2').classList.contains('active') && typeof renderMissionControl === 'function') renderMissionControl();
    }

    async function fetchTeamContextFeed() {
      try {
        var r = await fetch(API + '/api/team/context');
        if (!r.ok) return;
        var d = await r.json().catch(function () { return {}; });
        teamAgentContextSnapshot = {
          agents: d.agents && typeof d.agents === 'object' ? d.agents : {},
          updatedAt: Number(d.updatedAt) || 0,
        };
      } catch (_) {}
      renderAgentContext();
      renderTeamAgentCards();
      renderCurrentMission();
      renderTeamTaskSummary();
      renderAgentMapForPrefix({ prefix: 'team-map', mode: 'edit-page' });
      if (document.getElementById('page-team2') && document.getElementById('page-team2').classList.contains('active') && typeof renderMissionControl === 'function') renderMissionControl();
    }

    async function fetchTeamMetricsFeed() {
      try {
        var q = '';
        var window = getTeamAgentRangeWindow(teamAgentPanelRange);
        if (window) {
          q = '?since=' + encodeURIComponent(String(window.since)) +
            '&until=' + encodeURIComponent(String(window.until));
        }
        var r = await fetch(API + '/api/team/metrics' + q);
        if (!r.ok) return;
        var d = await r.json().catch(function () { return {}; });
        teamAgentMetricsSnapshot = {
          agents: d.agents && typeof d.agents === 'object' ? d.agents : {},
          updatedAt: Number(d.updatedAt) || 0,
        };
      } catch (_) {}
      renderAgentMetrics();
      renderTeamAgentCards();
    }

    async function fetchGoalsSnapshot() {
      try {
        var r = await fetch(API + '/api/goals');
        if (!r.ok) return;
        var d = await r.json().catch(function () { return {}; });
        teamGoalsSnapshot = {
          goals: Array.isArray(d.goals) ? d.goals : [],
          updatedAt: Number(d.updatedAt) || 0,
        };
      } catch (_) {}
      renderGoalsList();
      renderAgentContext();
      renderTeamUserInputModal();
    }

    var teamUserInputGoalId = '';
    var teamUserInputDismissed = {};
    var teamUserInputModalWired = false;
    var teamUserInputSubmitBusy = false;
    var TEAM_USER_INPUT_DISMISSED_KEY = 'cowcode_team_user_input_dismissed_v1';

    function loadTeamUserInputDismissed() {
      try {
        var raw = sessionStorage.getItem(TEAM_USER_INPUT_DISMISSED_KEY);
        teamUserInputDismissed = raw ? JSON.parse(raw) : {};
      } catch (_) {
        teamUserInputDismissed = {};
      }
      if (!teamUserInputDismissed || typeof teamUserInputDismissed !== 'object') teamUserInputDismissed = {};
    }

    function saveTeamUserInputDismissed() {
      try {
        sessionStorage.setItem(TEAM_USER_INPUT_DISMISSED_KEY, JSON.stringify(teamUserInputDismissed || {}));
      } catch (_) {}
    }

    function teamUserInputDismissKey(goal) {
      return String(goal.id || '') + '::' + String(goal.needsUserInput || '').slice(0, 240);
    }

    function isTeamMainViewActive() {
      if (document.body.classList.contains('dashboard-team2-active')) {
        return typeof mc2ActiveView === 'undefined' || mc2ActiveView === 'mission';
      }
      if (document.body.classList.contains('dashboard-team-active')) {
        return teamTopTab === 'roster';
      }
      return false;
    }

    function getGoalsNeedingUserInput() {
      return (Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : []).filter(function (g) {
        return String(g.needsUserInput || '').trim().length > 0;
      }).sort(function (a, b) {
        return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0);
      });
    }

    function showTeamUserInputModalError(msg) {
      var el = document.getElementById('team-user-input-modal-error');
      if (!el) return;
      if (msg) {
        el.textContent = msg;
        el.classList.add('visible');
      } else {
        el.textContent = '';
        el.classList.remove('visible');
      }
    }

    function closeTeamUserInputModal() {
      var modal = document.getElementById('team-user-input-modal');
      if (!modal) return;
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      teamUserInputGoalId = '';
      showTeamUserInputModalError('');
    }

    function openTeamUserInputModal(goal) {
      var modal = document.getElementById('team-user-input-modal');
      var missionEl = document.getElementById('team-user-input-modal-mission');
      var questionEl = document.getElementById('team-user-input-modal-question');
      var quickEl = document.getElementById('team-user-input-modal-quick');
      var textEl = document.getElementById('team-user-input-modal-text');
      if (!modal || !goal) return;
      var id = String(goal.id || '');
      var ask = String(goal.needsUserInput || '').trim();
      if (!id || !ask) return;
      teamUserInputGoalId = id;
      if (missionEl) missionEl.textContent = String(goal.title || 'Untitled mission');
      if (questionEl) questionEl.textContent = ask;
      if (textEl) textEl.value = '';
      showTeamUserInputModalError('');
      if (quickEl) {
        var askLower = ask.toLowerCase();
        var options = [];
        if (/posthog|analytics|ga4|mixpanel|tracking|measurement/.test(askLower)) {
          options = ['PostHog', 'Google Analytics (GA4)', 'Mixpanel', 'No analytics yet — use defaults'];
        }
        quickEl.innerHTML = options.map(function (label) {
          return '<button type="button" class="secondary team-user-input-quick-btn" data-quick-response="' + escapeHtml(label) + '">' + escapeHtml(label) + '</button>';
        }).join('');
      }
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      if (textEl) setTimeout(function () { textEl.focus(); }, 0);
    }

    function renderTeamUserInputModal() {
      if (!isTeamMainViewActive()) {
        closeTeamUserInputModal();
        return;
      }
      var modal = document.getElementById('team-user-input-modal');
      if (!modal) return;
      var goals = getGoalsNeedingUserInput().filter(function (g) {
        return !teamUserInputDismissed[teamUserInputDismissKey(g)];
      });
      if (!goals.length) {
        closeTeamUserInputModal();
        return;
      }
      var next = goals[0];
      if (modal.classList.contains('open') && teamUserInputGoalId === String(next.id || '')) return;
      openTeamUserInputModal(next);
    }

    async function submitTeamUserInputResponse(responseText) {
      if (teamUserInputSubmitBusy || !teamUserInputGoalId) return;
      var text = String(responseText || '').trim();
      if (!text) {
        showTeamUserInputModalError('Enter a response or pick a quick option.');
        return;
      }
      var submitBtn = document.getElementById('team-user-input-modal-submit');
      teamUserInputSubmitBusy = true;
      if (submitBtn) submitBtn.disabled = true;
      showTeamUserInputModalError('');
      try {
        var r = await fetch(API + '/api/goals/' + encodeURIComponent(teamUserInputGoalId) + '/respond', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response: text }),
        });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok) {
          showTeamUserInputModalError(d.error || 'Could not submit response');
          return;
        }
        closeTeamUserInputModal();
        await fetchGoalsSnapshot();
        if (typeof renderMissionControl === 'function') renderMissionControl();
      } catch (err) {
        showTeamUserInputModalError(err && err.message ? err.message : String(err));
      } finally {
        teamUserInputSubmitBusy = false;
        if (submitBtn) submitBtn.disabled = false;
      }
    }

    function wireTeamUserInputModal() {
      if (teamUserInputModalWired) return;
      teamUserInputModalWired = true;
      loadTeamUserInputDismissed();
      wireClick('team-user-input-modal-dismiss', function () {
        var goals = getGoalsNeedingUserInput();
        var goal = goals.find(function (g) { return String(g.id || '') === teamUserInputGoalId; }) || goals[0];
        if (goal) teamUserInputDismissed[teamUserInputDismissKey(goal)] = true;
        saveTeamUserInputDismissed();
        closeTeamUserInputModal();
      });
      wireClick('team-user-input-modal-submit', function () {
        var textEl = document.getElementById('team-user-input-modal-text');
        submitTeamUserInputResponse(textEl ? textEl.value : '');
      });
      wireEl('team-user-input-modal-text', 'keydown', function (ev) {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
          ev.preventDefault();
          submitTeamUserInputResponse(ev.target.value);
        }
      });
      wireEl('team-user-input-modal', 'click', function (ev) {
        if (ev.target === ev.currentTarget) {
          var goals = getGoalsNeedingUserInput();
          var goal = goals.find(function (g) { return String(g.id || '') === teamUserInputGoalId; }) || goals[0];
          if (goal) teamUserInputDismissed[teamUserInputDismissKey(goal)] = true;
          saveTeamUserInputDismissed();
          closeTeamUserInputModal();
        }
      });
      document.addEventListener('click', function (ev) {
        var btn = ev.target && ev.target.closest ? ev.target.closest('.team-user-input-quick-btn') : null;
        if (!btn) return;
        var label = btn.getAttribute('data-quick-response') || btn.textContent || '';
        var textEl = document.getElementById('team-user-input-modal-text');
        if (textEl) textEl.value = label;
        submitTeamUserInputResponse(label);
      });
    }
    wireTeamUserInputModal();

    async function fetchInitiativesSnapshot() {
      try {
        var r = await fetch(API + '/api/initiatives');
        if (!r.ok) return;
        var d = await r.json().catch(function () { return {}; });
        teamInitiativesSnapshot = {
          initiatives: Array.isArray(d.initiatives) ? d.initiatives : [],
          updatedAt: Number(d.updatedAt) || 0,
        };
      } catch (_) {}
      renderInitiativesList();
      renderGoalsList();
    }

    function startTeamActivityFeed() {
      if (teamActivityPollTimer) return;
      fetchTeamActivityFeed();
      fetchTeamContextFeed();
      fetchTeamMetricsFeed();
      fetchGoalsSnapshot();
      fetchInitiativesSnapshot();
      if (typeof fetchMc2PendingApprovals === 'function') fetchMc2PendingApprovals();
      teamActivityPollTimer = setInterval(function () {
        fetchTeamActivityFeed();
        fetchTeamContextFeed();
        fetchTeamMetricsFeed();
        fetchGoalsSnapshot();
        fetchInitiativesSnapshot();
        if (typeof fetchMc2PendingApprovals === 'function') fetchMc2PendingApprovals();
      }, TEAM_ACTIVITY_POLL_MS);
    }

    Object.keys(TEAM_RAIL_LABELS).forEach(function (key) {
      var toggle = document.getElementById('team-' + key + '-toggle');
      if (!toggle) return;
      toggle.addEventListener('click', function () {
        setTeamRailExpanded(key, !teamRailExpanded[key]);
      });
    });
    document.querySelectorAll('.team-agent-panel-range').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (btn.closest('#page-team2')) return;
        setTeamAgentPanelRange(btn.getAttribute('data-range'));
      });
    });
    Object.keys(TEAM_RAIL_LABELS).forEach(function (key) {
      setTeamRailExpanded(key, false);
    });
    setTeamAgentPanelRange('today');

    var teamViewTabCardsEl = document.getElementById('team-view-tab-cards');
    var teamViewTabTreeEl = document.getElementById('team-view-tab-tree');
    if (teamViewTabCardsEl) {
      teamViewTabCardsEl.addEventListener('click', function () { setTeamViewTab('cards'); });
    }
    if (teamViewTabTreeEl) {
      teamViewTabTreeEl.addEventListener('click', function () { setTeamViewTab('tree'); });
    }
    setTeamViewTab('cards');

    var teamTopTabRosterEl = document.getElementById('team-top-tab-roster');
    var teamTopTabGoalsEl = document.getElementById('team-top-tab-goals');
    var teamTopTabInitiativesEl = document.getElementById('team-top-tab-initiatives');
    if (teamTopTabRosterEl) {
      teamTopTabRosterEl.addEventListener('click', function () { setTeamTopTab('roster'); });
    }
    if (teamTopTabGoalsEl) {
      teamTopTabGoalsEl.addEventListener('click', function () { setTeamTopTab('goals'); });
    }
    if (teamTopTabInitiativesEl) {
      teamTopTabInitiativesEl.addEventListener('click', function () { setTeamTopTab('initiatives'); });
    }
    setTeamTopTab('roster');

    var teamViewActiveOnlyEl = document.getElementById('team-view-active-only');
    if (teamViewActiveOnlyEl) {
      teamViewActiveOnlyEl.addEventListener('change', function () {
        setTeamViewActiveOnly(!!teamViewActiveOnlyEl.checked);
      });
    }

    var teamGoalsRefreshEl = document.getElementById('team-goals-refresh');
    if (teamGoalsRefreshEl) {
      teamGoalsRefreshEl.addEventListener('click', function () { fetchGoalsSnapshot(); });
    }
    var teamInitiativesRefreshEl = document.getElementById('team-initiatives-refresh');
    if (teamInitiativesRefreshEl) {
      teamInitiativesRefreshEl.addEventListener('click', function () { fetchInitiativesSnapshot(); });
    }
    var teamGoalCreateEl = document.getElementById('team-goal-create');
    if (teamGoalCreateEl) {
      teamGoalCreateEl.addEventListener('click', async function () {
        var titleEl = document.getElementById('team-goal-title');
        var objectiveEl = document.getElementById('team-goal-objective');
        var ownerEl = document.getElementById('team-goal-owner');
        var title = titleEl ? String(titleEl.value || '').trim() : '';
        var objective = objectiveEl ? String(objectiveEl.value || '').trim() : '';
        var ownerAgentId = ownerEl ? String(ownerEl.value || '').trim() : 'main';
        if (!objective) {
          if (objectiveEl) objectiveEl.focus();
          return;
        }
        teamGoalCreateEl.disabled = true;
        try {
          var resp = await fetch(API + '/api/goals', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title, objective: objective, ownerAgentId: ownerAgentId }),
          });
          if (resp.ok) {
            if (titleEl) titleEl.value = '';
            if (objectiveEl) objectiveEl.value = '';
            await fetchGoalsSnapshot();
            setTeamTopTab('goals');
          }
        } catch (_) {}
        teamGoalCreateEl.disabled = false;
      });
    }

    function stopTeamActivityFeed() {
      if (!teamActivityPollTimer) return;
      clearInterval(teamActivityPollTimer);
      teamActivityPollTimer = null;
    }

    function setChatAgent(agentId) {
      saveCurrentSession();
      selectedChatAgentId = agentId || 'main';
      if (chatMessagesByAgent[selectedChatAgentId]) {
        chatMessages = chatMessagesByAgent[selectedChatAgentId];
        // keep currentSessionId as-is if we already have in-memory messages for this agent
      } else {
        // try to restore the most recent session for this agent
        var recent = getSessionsForAgent(selectedChatAgentId);
        if (recent.length) {
          currentSessionId = recent[0].id;
          chatMessages = (recent[0].messages || []).slice();
        } else {
          currentSessionId = newSessionId();
          chatMessages = [];
        }
        chatMessagesByAgent[selectedChatAgentId] = chatMessages;
      }
      renderChatMessages();
      updateAgentMapSelection();
    }

    async function fetchChatAgents() {
      var select = document.getElementById('chat-agent-select');
      if (!select) return;
      var agents = await fetchAgentMapData();
      if (!agents.length) agents = [{ id: 'main' }];
      if (!agents.some(function (a) { return a.id === selectedChatAgentId; })) {
        selectedChatAgentId = agents[0].id;
      }
      select.innerHTML = agents.map(function (a) {
        var id = String(a.id || 'main');
        var selected = id === selectedChatAgentId ? ' selected' : '';
        return '<option value="' + escapeHtml(id) + '"' + selected + '>' + escapeHtml(agentDisplayLabel(a)) + '</option>';
      }).join('');
      setChatAgent(selectedChatAgentId);
    }

    function renderChatMessages() {
      var el = document.getElementById('chat-messages-inner');
      if (!el) return;
      el.innerHTML = chatMessages.map(function (m, idx) {
        var c = escapeHtml(m.content || '');
        var streamClass = (chatStreamActive && m.role === 'assistant' && idx === chatMessages.length - 1 && (m.content || '') === 'Thinking…') ? ' chat-streaming' : '';
        return '<div class="chat-msg ' + (m.role === 'user' ? 'user' : 'assistant') + streamClass + '">' + c + '</div>';
      }).join('');
      if (chatLoading && !chatStreamActive) {
        el.innerHTML += '<div class="chat-msg loading">Thinking…</div>';
      }
      scrollChatToBottom();
    }

    function scrollChatToBottom() {
      var el = document.getElementById('chat-messages');
      if (!el) return;
      var sync = function () {
        el.scrollTop = el.scrollHeight;
      };
      sync();
      requestAnimationFrame(function () {
        sync();
        requestAnimationFrame(sync);
      });
    }

    function applyStoppedAssistant(progressLines) {
      var st = (progressLines || []).map(function (s) { return '• ' + s; }).join('\n');
      return (st ? st + '\n\n' : '') + 'Stopped.';
    }

    async function sendChatMessage() {
      var input = document.getElementById('chat-input');
      if (!input) return;
      var text = (input.value || '').trim();
      if (!text || chatLoading) return;
      chatMessages.push({ role: 'user', content: text });
      var historyPayload = chatMessages.slice(0, -1).slice(-20).map(function (m) { return { role: m.role, content: m.content }; });
      chatMessages.push({ role: 'assistant', content: 'Thinking…' });
      var assistantIndex = chatMessages.length - 1;
      chatMessagesByAgent[selectedChatAgentId] = chatMessages;
      input.value = '';
      chatLoading = true;
      chatStreamActive = true;
      chatAbortController = new AbortController();
      syncChatSendButton();
      renderChatMessages();
      function setAssistantBody(body) {
        chatMessages[assistantIndex].content = body;
        chatMessagesByAgent[selectedChatAgentId] = chatMessages;
        renderChatMessages();
      }
      var progressLines = [];
      try {
        var r = await fetch(API + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, history: historyPayload, agentId: selectedChatAgentId }),
          signal: chatAbortController.signal
        });
        var ct = (r.headers.get('content-type') || '').toLowerCase();
        if (!r.ok) {
          var errJson = await r.json().catch(function () { return {}; });
          setAssistantBody('Error: ' + (errJson.error || r.status));
        } else if (ct.indexOf('ndjson') !== -1 || ct.indexOf('x-ndjson') !== -1) {
          var reader = r.body && r.body.getReader ? r.body.getReader() : null;
          if (!reader) {
            setAssistantBody('Error: streaming not supported in this browser');
          } else {
            var decoder = new TextDecoder();
            var lineBuf = '';
            var finalReply = '';
            var streamError = '';
            try {
              while (true) {
                var read;
                try {
                  read = await reader.read();
                } catch (re) {
                  if (re && re.name === 'AbortError') {
                    setAssistantBody(applyStoppedAssistant(progressLines));
                    throw re;
                  }
                  throw re;
                }
                if (read.done) break;
                lineBuf += decoder.decode(read.value, { stream: true });
                var nl;
                while ((nl = lineBuf.indexOf('\n')) >= 0) {
                  var line = lineBuf.slice(0, nl).trim();
                  lineBuf = lineBuf.slice(nl + 1);
                  if (!line) continue;
                  var obj;
                  try {
                    obj = JSON.parse(line);
                  } catch (e) {
                    continue;
                  }
                  if (obj.type === 'progress' && obj.message) {
                    progressLines.push(String(obj.message));
                    var stepsOnly = progressLines.map(function (s) { return '• ' + s; }).join('\n');
                    setAssistantBody(stepsOnly + (finalReply ? '\n\n' + finalReply : ''));
                  } else if (obj.type === 'done') {
                    finalReply = (obj.reply != null ? String(obj.reply) : '').trim() || '(No reply)';
                    var st = progressLines.map(function (s) { return '• ' + s; }).join('\n');
                    setAssistantBody((st ? st + '\n\n' : '') + finalReply);
                  } else if (obj.type === 'error') {
                    streamError = obj.error != null ? String(obj.error) : 'Error';
                    setAssistantBody('Error: ' + streamError);
                  }
                }
              }
              var tail = lineBuf.trim();
              if (tail) {
                try {
                  var last = JSON.parse(tail);
                  if (last.type === 'done') {
                    finalReply = (last.reply != null ? String(last.reply) : '').trim() || '(No reply)';
                  } else if (last.type === 'error') {
                    streamError = last.error != null ? String(last.error) : 'Error';
                  }
                } catch (e2) {}
              }
              if (streamError) {
                setAssistantBody('Error: ' + streamError);
              } else {
                var st2 = progressLines.map(function (s) { return '• ' + s; }).join('\n');
                setAssistantBody((st2 ? st2 + '\n\n' : '') + (finalReply || '(No reply)'));
              }
            } catch (streamEnd) {
              if (!streamEnd || streamEnd.name !== 'AbortError') {
                throw streamEnd;
              }
            }
          }
        } else {
          var d = await r.json().catch(function () { return {}; });
          setAssistantBody((d.reply || '').trim() || '(No reply)');
        }
        chatMessagesByAgent[selectedChatAgentId] = chatMessages;
      } catch (e) {
        if (e && e.name === 'AbortError') {
          if ((chatMessages[assistantIndex].content || '').indexOf('Stopped.') === -1) {
            setAssistantBody(applyStoppedAssistant(progressLines));
          }
        } else {
          setAssistantBody('Error: ' + (e.message || 'Network error'));
        }
        chatMessagesByAgent[selectedChatAgentId] = chatMessages;
      } finally {
        chatAbortController = null;
        chatStreamActive = false;
        chatLoading = false;
        syncChatSendButton();
        renderChatMessages();
        saveCurrentSession();
      }
    }

    // Chat toolbar bindings also live in 05-bind-init.js (loads after mission-control).
