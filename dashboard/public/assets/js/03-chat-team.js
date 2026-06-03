// ── Chat session persistence ──────────────────────────────────────────
    var SESSIONS_KEY = 'pasture_chat_sessions_v1';
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
      goals: 'Long-running missions your agents work on autonomously — create missions, track tasks, and run or pause work.',
      initiatives: 'Proactive suggestions from mission reflection and team activity — review and add to missions or create new ones.',
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
      if (s === 'blocked') return '⊘';
      return '○';
    }

    function missionSubgoalClass(status) {
      var s = normalizeSubgoalStatus(status);
      if (s === 'done') return 'mission-done';
      if (s === 'doing') return 'mission-doing';
      if (s === 'blocked') return 'mission-blocked';
      return 'mission-todo';
    }

    function dashboardSubgoalBlockedByWait(subgoal, waitCondition) {
      if (!subgoal || !isGoalPartialWait({ waitCondition: waitCondition })) return false;
      var w = waitCondition || {};
      var blockedIds = Array.isArray(w.blockedSubgoalIds) ? w.blockedSubgoalIds : (
        Array.isArray(w.appliesToSubgoalIds) ? w.appliesToSubgoalIds : []
      );
      var sgId = String(subgoal.id || '').trim();
      if (sgId && blockedIds.some(function (id) { return String(id || '').trim() === sgId; })) return true;
      var appliesTo = String(w.waitAppliesTo || w.scope || 'implementation').toLowerCase();
      var hay = (sgId + ' ' + String(subgoal.title || '') + ' ' + String(subgoal.description || '')).toLowerCase();
      var scope = /research|explore|benchmark|competitor|audit|interview|survey|discover/.test(hay) ? 'research'
        : /instrument|tracking|analytics|posthog|ga4|mixpanel|pixel|funnel/.test(hay) ? 'instrumentation'
        : /deploy|release|launch|production|prod|go-live|ship/.test(hay) ? 'deployment'
        : /implement|build|develop|integrate|setup|code|configure/.test(hay) ? 'implementation'
        : 'general';
      if (appliesTo === 'all') return true;
      if (appliesTo === scope) return true;
      if (appliesTo === 'implementation' && (scope === 'implementation' || scope === 'instrumentation' || scope === 'deployment')) {
        return true;
      }
      return false;
    }

    function walkGoalSubgoalsForBlocked(subgoals, goalId, goal, out) {
      var refs = out || [];
      var waitCondition = goal && goal.waitCondition;
      (subgoals || []).forEach(function (sg) {
        if (!sg || typeof sg !== 'object') return;
        var sgId = String(sg.id || '').trim();
        var title = String(sg.title || '').trim();
        var status = normalizeSubgoalStatus(sg.status);
        var blocked = status === 'blocked' ||
          (String(sg.status || '').toLowerCase() !== 'done' && dashboardSubgoalBlockedByWait(sg, waitCondition));
        if (blocked) {
          refs.push({ kind: 'subgoal', goalId: goalId, subgoalId: sgId, title: title });
        }
        walkGoalSubgoalsForBlocked(sg.subgoals, goalId, goal, refs);
      });
      return refs;
    }

    function findBlockedWorkRefs() {
      var refs = [];
      var agents = teamAgentContextSnapshot.agents || {};
      Object.keys(agents).forEach(function (id) {
        var ctx = agents[id] || {};
        if (String(ctx.state || 'idle').toLowerCase() === 'error') {
          refs.push({ kind: 'agent', goalId: '', subgoalId: '', agentId: id });
        }
      });
      (Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : []).forEach(function (g) {
        var goalId = String(g.id || '').trim();
        if (!goalId) return;
        if (String(g.status || '').toLowerCase() === 'blocked') {
          refs.push({ kind: 'goal', goalId: goalId, subgoalId: '', agentId: '' });
        } else if (isGoalPartialWait(g) || String(g.needsUserInput || '').trim()) {
          refs.push({ kind: 'goal', goalId: goalId, subgoalId: '', agentId: '', partial: true });
        }
        walkGoalSubgoalsForBlocked(g.subgoals, goalId, g, refs);
      });
      return refs;
    }

    function findFirstBlockedWorkRef() {
      var refs = findBlockedWorkRefs();
      var i;
      for (i = 0; i < refs.length; i++) {
        if (refs[i].kind === 'subgoal') return refs[i];
      }
      for (i = 0; i < refs.length; i++) {
        if (refs[i].kind === 'goal') return refs[i];
      }
      return refs[0] || null;
    }

    function effectiveSubgoalStatus(subgoal, goal) {
      var status = normalizeSubgoalStatus(subgoal && subgoal.status);
      if (status === 'done') return 'done';
      if (status === 'blocked') return 'blocked';
      if (goal && dashboardSubgoalBlockedByWait(subgoal, goal.waitCondition)) return 'blocked';
      return status;
    }

    function flattenMissionWorkItems() {
      var items = [];
      (Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : []).forEach(function (g) {
        var missionTitle = String(g.title || g.objective || 'Untitled mission').trim();
        var goalId = String(g.id || '').trim();
        if (!goalId) return;
        var goalStatus = String(g.status || 'active').toLowerCase();
        if (goalStatus === 'blocked') {
          items.push({
            kind: 'goal',
            status: 'blocked',
            title: missionTitle,
            missionTitle: missionTitle,
            goalId: goalId,
            subgoalId: '',
            path: missionTitle,
            assignee: String(g.ownerAgentId || '').trim(),
            progress: normalizeSubgoalProgress(g.progress && g.progress.pct),
            description: String(g.blockedReason || g.objective || '').trim(),
          });
        }
        function walk(subgoals, pathParts) {
          (subgoals || []).forEach(function (sg) {
            if (!sg || typeof sg !== 'object') return;
            var title = String(sg.title || '').trim() || 'Untitled task';
            var parts = pathParts.concat(title);
            var status = effectiveSubgoalStatus(sg, g);
            var subgoalId = String(sg.id || '').trim();
            items.push({
              kind: 'subgoal',
              status: status,
              title: title,
              missionTitle: missionTitle,
              goalId: goalId,
              subgoalId: subgoalId,
              fromInitiative: /^init-/.test(subgoalId),
              path: parts.join(' → '),
              assignee: String(sg.assignee || g.ownerAgentId || '').trim(),
              delegatedFrom: String(sg.delegatedFrom || '').trim(),
              delegatedAt: Number(sg.delegatedAt) || 0,
              source: String(sg.source || '').trim(),
              dueAt: Number(sg.dueAt) || 0,
              progress: normalizeSubgoalProgress(sg.progress),
              description: String(sg.description || '').trim(),
              updatedAt: Number(sg.updatedAt || g.updatedAt) || 0,
            });
            walk(sg.subgoals, parts);
          });
        }
        walk(g.subgoals, [missionTitle]);
      });
      var agents = teamAgentContextSnapshot.agents || {};
      Object.keys(agents).forEach(function (id) {
        var ctx = agents[id] || {};
        if (String(ctx.state || 'idle').toLowerCase() === 'error') {
          items.push({
            kind: 'agent',
            status: 'blocked',
            title: String(ctx.currentThought || ctx.lastAction || 'Agent blocked').trim(),
            missionTitle: '',
            goalId: '',
            subgoalId: '',
            agentId: id,
            path: agentNameById(id),
            assignee: id,
            progress: 0,
            description: String(ctx.lastAction || '').trim(),
          });
        }
      });
      return items;
    }

    function groupMissionWorkItems(items) {
      var groups = { blocked: [], doing: [], todo: [], done: [] };
      (items || []).forEach(function (it) {
        var bucket = groups[it.status] ? it.status : 'todo';
        if (!groups[bucket]) bucket = 'todo';
        groups[bucket].push(it);
      });
      return groups;
    }

    window.flattenMissionWorkItems = flattenMissionWorkItems;
    window.groupMissionWorkItems = groupMissionWorkItems;

    function highlightBlockedTarget(el) {
      if (!el || !el.classList) return;
      el.classList.add('team-blocked-highlight');
      setTimeout(function () {
        el.classList.remove('team-blocked-highlight');
      }, 2200);
    }

    function openSubgoalAncestors(el) {
      var node = el;
      while (node) {
        if (node.tagName === 'DETAILS' && node.classList && node.classList.contains('team-goal-subgoal-node')) {
          node.open = true;
        }
        node = node.parentElement;
      }
    }

    function scrollToFirstBlockedSubgoalTag() {
      var el = document.querySelector(
        '#mc2-goal-detail .team-goal-subgoal-status.blocked, #team-goal-detail .team-goal-subgoal-status.blocked, ' +
        '#team-current-mission .team-goal-subgoal-status.blocked, #team-current-mission li.mission-blocked'
      );
      if (!el) return false;
      openSubgoalAncestors(el);
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch (_) {}
      highlightBlockedTarget(el.classList && el.classList.contains('team-goal-subgoal-status') ? el : (el.closest('[data-subgoal-id]') || el));
      return true;
    }

    function scrollToBlockedSubgoalMarker(subgoalId, title) {
      var id = String(subgoalId || '').trim();
      var el = null;
      if (id) {
        el = document.querySelector('[data-subgoal-id="' + id + '"] .team-goal-subgoal-status.blocked') ||
          document.querySelector('[data-mission-subgoal-id="' + id + '"]');
      }
      if (!el && title) {
        var rows = document.querySelectorAll('.team-goal-subgoal-row[data-subgoal-id]');
        for (var i = 0; i < rows.length; i++) {
          var rowTitle = rows[i].querySelector('.team-goal-subgoal-title');
          if (rowTitle && String(rowTitle.textContent || '').trim() === String(title).trim()) {
            el = rows[i].querySelector('.team-goal-subgoal-status.blocked') || rows[i];
            break;
          }
        }
      }
      if (!el) return false;
      openSubgoalAncestors(el);
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch (_) {}
      highlightBlockedTarget(el.classList && el.classList.contains('team-goal-subgoal-status') ? el : (el.closest('[data-subgoal-id]') || el));
      return true;
    }

    function scheduleScrollToBlockedTarget(ref, attempt) {
      var tries = Number(attempt) || 0;
      var hit = false;
      if (ref && ref.kind === 'subgoal') {
        hit = scrollToBlockedSubgoalMarker(ref.subgoalId, ref.title) || scrollToFirstBlockedSubgoalTag();
      } else if (ref && ref.kind === 'goal') {
        var goalStatus = document.querySelector('#team-goal-detail .team-goal-status.blocked, #mc2-goal-detail .team-goal-status.blocked');
        if (goalStatus) {
          try { goalStatus.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch (_) {}
          highlightBlockedTarget(goalStatus);
          hit = true;
        } else {
          hit = scrollToFirstBlockedSubgoalTag();
        }
      } else {
        hit = scrollToFirstBlockedSubgoalTag();
      }
      if (hit || tries >= 20) return;
      setTimeout(function () { scheduleScrollToBlockedTarget(ref, tries + 1); }, 100);
    }

    function scrollMc2BlockedKanban() {
      var col = document.getElementById('mc2-col-attention');
      if (!col) return false;
      try { col.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' }); } catch (_) {}
      highlightBlockedTarget(col);
      return true;
    }

    function scrollToBlockedWork(ref) {
      ref = ref || findFirstBlockedWorkRef();
      if (!ref) return false;
      if (typeof mc2OpenTaskDetail === 'function') {
        if (ref.kind === 'agent' && ref.agentId) {
          mc2OpenTaskDetailForAgent(ref.agentId);
          return true;
        }
        var goalId = String(ref.goalId || '').trim();
        if (goalId) {
          var item = typeof findMissionTaskItem === 'function'
            ? findMissionTaskItem({
              goalId: goalId,
              subgoalId: ref.subgoalId,
              title: ref.title,
              agentId: ref.agentId,
            })
            : null;
          mc2OpenTaskDetail(item, {
            goalId: goalId,
            subgoalId: ref.subgoalId,
            filter: ref.kind === 'subgoal' ? 'blocked' : 'all',
          });
          return true;
        }
      }
      if (typeof mc2OpenTasksView === 'function') {
        mc2OpenTasksView('blocked');
        return true;
      }
      var mission = typeof getCurrentMissionGoal === 'function' ? getCurrentMissionGoal() : null;
      if (ref.kind === 'subgoal' && mission && String(mission.id || '') === String(ref.goalId || '')) {
        renderCurrentMission();
        if (scrollToBlockedSubgoalMarker(ref.subgoalId, ref.title)) return true;
      }
      selectedTeamGoalId = String(ref.goalId || '');
      if (typeof mc2SetView === 'function') {
        mc2SetView('tasks');
        if (typeof mc2RenderTasks === 'function') mc2RenderTasks();
        return true;
      } else if (typeof setTeamTopTab === 'function') {
        setTeamTopTab('goals');
        renderGoalsList();
        scheduleScrollToBlockedTarget(ref, 0);
      }
      return true;
    }

    function ensureMissionControlPage() {
      var mcPage = document.getElementById('page-team2');
      if (mcPage && mcPage.classList.contains('active')) return true;
      var route = (location.hash || '').slice(1).split('/')[0];
      if (route === 'team' || route === 'agents') return true;
      location.hash = '#team';
      return false;
    }

    function navigateToBlockedWork() {
      ensureMissionControlPage();
      if (typeof mc2OpenTasksView === 'function') {
        mc2OpenTasksView('blocked');
        return true;
      }
      var ref = findFirstBlockedWorkRef();
      if (ref && scrollToBlockedWork(ref)) return true;
      if (typeof mc2SetView === 'function') {
        mc2SetView('tasks');
        if (typeof mc2RenderTasks === 'function') mc2RenderTasks();
        return true;
      }
      if (typeof setTeamTopTab === 'function') {
        setTeamTopTab('goals');
        renderGoalsList();
        scheduleScrollToBlockedTarget(null, 0);
        return true;
      }
      return false;
    }

    window.navigateToBlockedWork = navigateToBlockedWork;

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
          var title = String(sg.title || '').trim() || 'Untitled task';
          var status = normalizeSubgoalStatus(sg.status);
          var icon = missionSubgoalIcon(status);
          var cls = missionSubgoalClass(status);
          var sgId = String(sg.id || '').trim();
          var statusTag = status === 'blocked'
            ? ' <span class="team-goal-subgoal-status blocked">blocked</span>'
            : '';
          return '<li class="' + cls + '" data-mission-subgoal-id="' + escapeHtml(sgId) + '" title="' + escapeHtml(title) + '">' +
            escapeHtml(icon + ' ' + title) + statusTag + '</li>';
        }).join('') + '</ul>'
        : '<p class="team-current-mission-empty" style="margin:0;">No tasks yet.</p>';
      var goalHeading = liveOnly ? 'Activity' : 'Mission';
      var noteHtml = liveOnly
        ? '<p class="team-current-mission-empty" style="margin:0.35rem 0 0;">No saved mission yet — this is live agent context from chat. Create a mission to track objectives and tasks.</p>'
        : '';
      panel.innerHTML = '' +
        '<h3 class="team-current-mission-title">Current Mission</h3>' +
        (liveOnly ? '<p class="team-current-mission-meta" style="margin:0 0 0.35rem;"><em>Live work (not a saved goal)</em></p>' : '') +
        '<p class="team-current-mission-meta"><strong>' + goalHeading + ':</strong> ' + escapeHtml(goalLabel) + '</p>' +
        '<p class="team-current-mission-meta"><strong>Progress:</strong> ' + escapeHtml(progressText) + '</p>' +
        '<p class="team-current-mission-meta"><strong>Owner:</strong> ' + escapeHtml(owner) + '</p>' +
        '<div class="team-current-mission-subgoals">' +
          '<h4>' + (liveOnly ? 'Steps' : 'Tasks') + '</h4>' +
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
      if (window.pastureCompletedTasks && typeof window.pastureCompletedTasks.consolidateCompletedTasks === 'function') {
        out = window.pastureCompletedTasks.consolidateCompletedTasks(out);
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
      var blockedDisabled = summary.blocked <= 0 ? ' disabled' : '';
      badgesEl.innerHTML = '' +
        '<span class="team-task-badge active">[' + escapeHtml(String(summary.active)) + ' Active]</span>' +
        '<span class="team-task-badge waiting">[' + escapeHtml(String(summary.waiting)) + ' Waiting]</span>' +
        '<button type="button" class="team-task-badge blocked team-task-badge-action"' + blockedDisabled +
          ' aria-label="View blocked tasks and subtasks">[' + escapeHtml(String(summary.blocked)) + ' Blocked]</button>' +
        '<span class="team-task-badge completed">[' + escapeHtml(String(summary.completedToday)) + ' Completed Today]</span>';
      if (summary.blocked > 0 && summary.blockedLabel) {
        blockedEl.innerHTML = '<button type="button" class="team-task-blocked-link">' +
          '<strong>' + (summary.blockedLabel.indexOf('Research continues') >= 0 ? 'Implementation blocked:' : 'Blocked:') + '</strong> ' +
          escapeHtml(summary.blockedLabel) + '</button>';
        blockedEl.classList.remove('empty');
      } else {
        blockedEl.innerHTML = '<strong>Blocked:</strong> <span class="empty">None</span>';
        blockedEl.classList.add('empty');
      }
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

    function initiativeIdFromSubgoalId(subgoalId) {
      var m = String(subgoalId || '').match(/^init-(.+)$/);
      return m ? m[1] : '';
    }

    function findInitiativeForSubgoalId(subgoalId) {
      var initId = initiativeIdFromSubgoalId(subgoalId);
      if (!initId) return null;
      return (Array.isArray(teamInitiativesSnapshot.initiatives) ? teamInitiativesSnapshot.initiatives : []).find(function (it) {
        return String(it.id || '') === initId;
      }) || null;
    }

    function openInitiativeForSubgoal(subgoalId) {
      var sid = String(subgoalId || '').trim();
      if (!sid) return false;
      if (typeof mc2OpenTaskDetail === 'function' && typeof findMissionTaskItem === 'function') {
        var item = findMissionTaskItem({ subgoalId: sid });
        if (item) {
          mc2OpenTaskDetail(item, { filter: 'all' });
          return true;
        }
      }
      var initId = initiativeIdFromSubgoalId(sid);
      if (!initId) return false;
      if (typeof mc2OpenTaskForInitiative === 'function') {
        mc2OpenTaskForInitiative(initId);
        return true;
      }
      selectedTeamInitiativeId = initId;
      if (typeof mc2SetView === 'function') mc2SetView('initiatives');
      if (typeof renderInitiativesPanels === 'function') renderInitiativesPanels();
      return true;
    }

    function missionTaskActionButtonsHtml(goalId, subgoalId, status, opts) {
      opts = opts || {};
      var gid = String(goalId || '').trim();
      var sid = String(subgoalId || '').trim();
      if (!gid || !sid) return '';
      var st = normalizeSubgoalStatus(status);
      var fromInit = !!opts.fromInitiative || /^init-/.test(sid);
      var btnClass = opts.compact ? 'team-goal-task-btn secondary' : 'mc-task-card-btn';
      var primaryClass = opts.compact ? 'team-goal-task-btn secondary' : 'mc-task-card-btn primary';
      var parts = [];
      function btn(action, label, primary) {
        return '<button type="button" class="' + (primary ? primaryClass : btnClass) + '" data-mc-task-action="' + escapeHtml(action) + '"' +
          ' data-goal-id="' + escapeHtml(gid) + '" data-subgoal-id="' + escapeHtml(sid) + '">' + escapeHtml(label) + '</button>';
      }
      if (st === 'blocked') {
        parts.push(btn('respond', 'Respond', true));
        parts.push(btn('unblock', 'Mark open', false));
      } else if (st !== 'done') {
        parts.push(btn('mark-done', 'Mark done', false));
      } else {
        parts.push(btn('mark-open', 'Reopen', false));
      }
      parts.push(btn('remove', 'Remove', false));
      if (fromInit) parts.push(btn('review-initiative', 'Review initiative', false));
      if (!opts.inDetailPanel) parts.push(btn('in-mission', 'Mission tree', false));
      var wrapClass = opts.compact ? 'team-goal-task-actions' : 'mc-task-card-actions';
      return '<div class="' + wrapClass + '">' + parts.join('') + '</div>';
    }

    async function removeMissionTask(goalId, subgoalId) {
      var gid = String(goalId || '').trim();
      var sid = String(subgoalId || '').trim();
      if (!gid || !sid) return false;
      if (!window.confirm('Remove this task from the mission? Agents will stop tracking it here.')) return false;
      var initiative = findInitiativeForSubgoalId(sid);
      if (initiative) return undoInitiativePromotion(initiative);
      var goal = (Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : []).find(function (g) {
        return String(g.id || '') === gid;
      });
      if (!goal) return false;
      try {
        var r = await fetch(API + '/api/goals/' + encodeURIComponent(gid), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subgoals: removeSubgoalFromTree(goal.subgoals, sid) }),
        });
        if (!r.ok) return false;
        await fetchGoalsSnapshot();
        if (typeof renderMissionControl === 'function') renderMissionControl();
        return true;
      } catch (_) {
        return false;
      }
    }

    function wireMissionTaskActions(root) {
      if (!root) return;
      root.querySelectorAll('[data-mc-task-action]').forEach(function (btn) {
        if (btn._wiredMissionTask) return;
        btn._wiredMissionTask = true;
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          var action = String(btn.getAttribute('data-mc-task-action') || '');
          var goalId = btn.getAttribute('data-goal-id');
          var subgoalId = btn.getAttribute('data-subgoal-id');
          var card = btn.closest('.mc-mission-task-card');
          var item = card && typeof mc2MissionTaskItemFromEl === 'function'
            ? mc2MissionTaskItemFromEl(card)
            : {
              kind: 'subgoal',
              goalId: goalId,
              subgoalId: subgoalId,
              title: card ? card.getAttribute('data-title') : '',
              status: card ? card.getAttribute('data-status') : 'todo',
            };
          if (action === 'respond') {
            if (typeof openMissionWorkInputModal === 'function') openMissionWorkInputModal(item);
            return;
          }
          if (action === 'unblock' || action === 'mark-open') {
            if (typeof patchMissionSubgoalStatus === 'function') {
              patchMissionSubgoalStatus(goalId, subgoalId, 'todo');
            }
            return;
          }
          if (action === 'mark-done') {
            if (typeof patchMissionSubgoalStatus === 'function') {
              patchMissionSubgoalStatus(goalId, subgoalId, 'done');
            }
            return;
          }
          if (action === 'remove') {
            removeMissionTask(goalId, subgoalId);
            return;
          }
          if (action === 'review-initiative') {
            openInitiativeForSubgoal(subgoalId);
            return;
          }
          if ((action === 'in-mission' || action === 'details') && card && typeof mc2ShowMissionTaskDetails === 'function') {
            mc2ShowMissionTaskDetails(card);
          } else if ((action === 'in-mission' || action === 'details') && goalId && typeof mc2OpenTaskDetail === 'function') {
            mc2OpenTaskDetail(null, { goalId: goalId, subgoalId: subgoalId, filter: 'all' });
          } else if ((action === 'in-mission' || action === 'details') && goalId) {
            selectedTeamGoalId = goalId;
            if (typeof mc2SetView === 'function') mc2SetView('goals');
            if (typeof mc2RenderGoals === 'function') {
              Promise.resolve(mc2RenderGoals()).then(function () {
                if (subgoalId && typeof scheduleScrollToBlockedTarget === 'function') {
                  scheduleScrollToBlockedTarget({
                    kind: 'subgoal',
                    goalId: goalId,
                    subgoalId: subgoalId,
                    title: '',
                  }, 0);
                }
              });
            }
          }
        });
      });
    }

    async function runMissionGoalAction(goalId, action) {
      var gid = String(goalId || '').trim();
      if (!gid) return;
      var goal = (Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : []).find(function (g) {
        return String(g.id || '') === gid;
      });
      if (!goal) return;
      if (action === 'run') {
        try {
          await fetch(API + '/api/goals/' + encodeURIComponent(gid) + '/run', { method: 'POST' });
        } catch (_) {}
        fetchGoalsSnapshot();
        return;
      }
      if (action === 'toggle') {
        var status = String(goal.status || 'active').toLowerCase();
        var nextStatus = status === 'active' ? 'paused' : 'active';
        try {
          await fetch(API + '/api/goals/' + encodeURIComponent(gid), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: nextStatus }),
          });
        } catch (_) {}
        fetchGoalsSnapshot();
        return;
      }
      if (action === 'respond' && typeof openTeamUserInputModal === 'function') {
        openTeamUserInputModal(goal, { ask: goalAttentionPrompt(goal) });
      }
    }

    function wireMissionGoalDetailActions(detailEl, goal) {
      if (!detailEl || !goal) return;
      var goalId = String(goal.id || '');
      detailEl.querySelectorAll('[data-mc-goal-action]').forEach(function (btn) {
        if (btn._wiredMissionGoal) return;
        btn._wiredMissionGoal = true;
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          runMissionGoalAction(goalId, btn.getAttribute('data-mc-goal-action'));
        });
      });
      wireMissionTaskActions(detailEl);
    }

    function renderGoalSubgoalTree(subgoals, lookup, depth, goalId) {
      var list = Array.isArray(subgoals) ? subgoals : [];
      if (!list.length) return '';
      var level = Number(depth) || 0;
      var gid = String(goalId || '').trim();
      return list.map(function (sg) {
        if (!sg || typeof sg !== 'object') return '';
        var title = String(sg.title || '').trim() || 'Untitled task';
        var status = normalizeSubgoalStatus(sg.status);
        var progress = normalizeSubgoalProgress(sg.progress);
        var assignee = String(sg.assignee || '').trim();
        var deps = Array.isArray(sg.depends_on) ? sg.depends_on.slice(0, 8) : [];
        var depsLabel = deps.map(function (depId) {
          var key = String(depId || '').trim();
          var dep = lookup[key];
          return dep && dep.title ? dep.title : key;
        }).filter(Boolean).join(', ');
        var sgKey = String(sg.id || '').trim();
        var children = renderGoalSubgoalTree(sg.subgoals, lookup, level + 1, gid);
        var initBadge = /^init-/.test(sgKey) ? '<span class="team-initiative-auto-badge">From initiative</span> ' : '';
        var actionsHtml = gid && sgKey
          ? missionTaskActionButtonsHtml(gid, sgKey, status, { compact: true, fromInitiative: /^init-/.test(sgKey) })
          : '';
        var summary = '<span class="team-goal-subgoal-row" data-subgoal-id="' + escapeHtml(sgKey) + '">' +
          initBadge +
          '<span class="team-goal-subgoal-title">' + escapeHtml(title) + '</span>' +
          '<span class="team-goal-subgoal-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' +
          '<span class="team-goal-subgoal-meta">' + escapeHtml(String(progress)) + '%</span>' +
          (assignee ? '<span class="team-goal-subgoal-meta">assignee: ' + escapeHtml(agentNameById(assignee)) + '</span>' : '') +
          (depsLabel ? '<span class="team-goal-subgoal-meta">depends on: ' + escapeHtml(depsLabel) + '</span>' : '') +
        '</span>' + actionsHtml;
        return '<details class="team-goal-subgoal-node" ' + (level < 1 ? 'open' : '') + '>' +
          '<summary>' + summary + '</summary>' +
          (children || '') +
        '</details>';
      }).join('');
    }

    function renderGoalDetail(goal, detailEl) {
      var detail = detailEl || document.getElementById('team-goal-detail');
      if (!detail) return;
      if (!goal || typeof goal !== 'object') {
        detail.innerHTML = '<p class="team-agent-inbox-empty" style="margin:0;padding:0;">Select a mission to view details and tasks.</p>';
        return;
      }
      var status = String(goal.status || 'active').toLowerCase();
      var pct = normalizeSubgoalProgress(goal.progress && goal.progress.pct);
      var goalId = String(goal.id || '');
      var subgoals = Array.isArray(goal.subgoals) ? goal.subgoals : [];
      var subgoalLookup = indexGoalSubgoals(subgoals, {});
      var subgoalTree = renderGoalSubgoalTree(subgoals, subgoalLookup, 0, goalId);
      var needsInput = typeof goalNeedsAttention === 'function' ? goalNeedsAttention(goal) : false;
      var toggleLabel = status === 'active' ? 'Pause mission' : (status === 'paused' ? 'Resume mission' : 'Activate mission');
      detail.innerHTML = '' +
        '<h4>' + escapeHtml(goal.title || 'Untitled mission') + ' <span class="team-goal-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span></h4>' +
        '<div class="team-goal-detail-row"><strong>Owner:</strong> ' + escapeHtml(goalOwnerLabel(goal)) + '</div>' +
        '<div class="team-goal-detail-row"><strong>Objective:</strong> ' + escapeHtml(String(goal.objective || '')) + '</div>' +
        '<div class="team-goal-detail-row"><strong>Progress:</strong> ' + escapeHtml(String(pct)) + '%</div>' +
        (goal.lastActivity ? '<div class="team-goal-detail-row"><strong>Latest activity:</strong> ' + escapeHtml(String(goal.lastActivity)) + '</div>' : '') +
        '<div class="team-initiative-actions team-goal-detail-actions">' +
          '<button type="button" class="secondary" data-mc-goal-action="run" data-goal-id="' + escapeHtml(goalId) + '">Run now</button>' +
          '<button type="button" class="secondary" data-mc-goal-action="toggle" data-goal-id="' + escapeHtml(goalId) + '">' + escapeHtml(toggleLabel) + '</button>' +
          (needsInput
            ? '<button type="button" class="secondary" data-mc-goal-action="respond" data-goal-id="' + escapeHtml(goalId) + '">Give input</button>'
            : '') +
        '</div>' +
        '<div class="team-goal-subgoals">' +
          '<h5>Tasks — you can change or remove any task below</h5>' +
          (subgoalTree || '<p class="team-agent-inbox-empty" style="margin:0;padding:0;">No tasks yet.</p>') +
        '</div>';
      wireMissionGoalDetailActions(detail, goal);
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
          '<div class="team-goal-meta"><strong>Tasks:</strong> ' + escapeHtml(String(subgoalCount)) + '</div>' +
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

    function missionTitleForGoalId(goalId) {
      var gid = String(goalId || '').trim();
      if (!gid) return '';
      var goal = (teamGoalsSnapshot.goals || []).find(function (g) { return String(g.id || '') === gid; });
      return goal ? String(goal.title || goal.objective || gid).trim() : gid;
    }

    function humanizeInitiativeActivityLine(line) {
      var s = String(line || '');
      return s.replace(/(?:Auto-promoted|Promoted) to subgoal in (goal-[a-z0-9-]+)/gi, function (_m, gid) {
        var name = missionTitleForGoalId(gid);
        return 'Added to mission: ' + (name || gid);
      });
    }

    function initiativeSubgoalId(initiative) {
      var id = String(initiative && initiative.id || '').trim();
      return id ? 'init-' + id : '';
    }

    function initiativeActivityLines(initiative) {
      var raw = initiative && initiative.activity;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw.map(function (line) { return String(line || ''); });
      return [String(raw)];
    }

    function initiativeWasAutoPromoted(initiative) {
      return initiativeActivityLines(initiative).some(function (line) {
        return line.indexOf('Auto-promoted to subgoal in ') >= 0;
      });
    }

    function goalTreeHasSubgoalId(subgoals, subgoalId) {
      var sid = String(subgoalId || '').trim();
      if (!sid) return false;
      var stack = Array.isArray(subgoals) ? subgoals.slice() : [];
      while (stack.length) {
        var sg = stack.pop();
        if (!sg || typeof sg !== 'object') continue;
        if (String(sg.id || '') === sid) return true;
        if (Array.isArray(sg.subgoals) && sg.subgoals.length) stack.push.apply(stack, sg.subgoals);
      }
      return false;
    }

    function initiativePromotedGoalId(initiative) {
      if (!initiative || typeof initiative !== 'object') return '';
      var lines = initiativeActivityLines(initiative);
      var i;
      for (i = 0; i < lines.length; i++) {
        var m = lines[i].match(/(?:Auto-)?[Pp]romoted to subgoal in (goal-[a-z0-9-]+)/i);
        if (m) return m[1];
      }
      var subId = initiativeSubgoalId(initiative);
      var goals = Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : [];
      for (i = 0; i < goals.length; i++) {
        if (goalTreeHasSubgoalId(goals[i].subgoals, subId)) return String(goals[i].id || '');
      }
      var related = Array.isArray(initiative.relatedGoalIds) ? initiative.relatedGoalIds : [];
      return String(related[0] || '').trim();
    }

    function initiativeIsOnMission(initiative) {
      var subId = initiativeSubgoalId(initiative);
      if (!subId) return false;
      return (teamGoalsSnapshot.goals || []).some(function (g) {
        return goalTreeHasSubgoalId(g.subgoals, subId);
      });
    }

    function activeGoalsForInitiativePicker() {
      return (Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : []).filter(function (g) {
        return String(g.status || '').toLowerCase() === 'active';
      });
    }

    function removeSubgoalFromTree(subgoals, subgoalId) {
      var sid = String(subgoalId || '').trim();
      var out = [];
      (subgoals || []).forEach(function (sg) {
        if (!sg || typeof sg !== 'object') return;
        if (String(sg.id || '') === sid) return;
        var next = Object.assign({}, sg);
        if (Array.isArray(next.subgoals) && next.subgoals.length) {
          next.subgoals = removeSubgoalFromTree(next.subgoals, sid);
        }
        out.push(next);
      });
      return out;
    }

    async function undoInitiativePromotion(initiative) {
      if (!initiative || !initiative.id) return false;
      var goalId = initiativePromotedGoalId(initiative);
      var subId = initiativeSubgoalId(initiative);
      if (!goalId || !subId) return false;
      var goal = (Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : []).find(function (g) {
        return String(g.id || '') === goalId;
      });
      if (!goal) return false;
      try {
        var gr = await fetch(API + '/api/goals/' + encodeURIComponent(goalId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subgoals: removeSubgoalFromTree(goal.subgoals, subId) }),
        });
        if (!gr.ok) return false;
        await fetch(API + '/api/initiatives/' + encodeURIComponent(initiative.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'open',
            activity: ['Promotion removed by user — review again before promoting'],
          }),
        }).catch(function () {});
        await fetchGoalsSnapshot();
        await fetchInitiativesSnapshot();
        if (typeof renderMissionControl === 'function') renderMissionControl();
        return true;
      } catch (_) {
        return false;
      }
    }

    function viewInitiativeOnMission(initiative) {
      var goalId = initiativePromotedGoalId(initiative);
      var subId = initiativeSubgoalId(initiative);
      if (subId && typeof mc2OpenTaskDetail === 'function' && typeof findMissionTaskItem === 'function') {
        var item = findMissionTaskItem({ goalId: goalId, subgoalId: subId, title: initiative && initiative.title });
        if (item) {
          mc2OpenTaskDetail(item, { filter: 'all' });
          return;
        }
      }
      if (typeof mc2OpenTaskForInitiative === 'function' && initiative && initiative.id) {
        mc2OpenTaskForInitiative(initiative.id);
        return;
      }
      if (!goalId) return;
      if (typeof mc2OpenTaskDetail === 'function') {
        mc2OpenTaskDetail(null, { goalId: goalId, subgoalId: subId, filter: 'all' });
        return;
      }
      selectedTeamGoalId = goalId;
      if (typeof mc2SetView === 'function') mc2SetView('goals');
      Promise.resolve(typeof mc2RenderGoals === 'function' ? mc2RenderGoals() : null).then(function () {
        if (typeof scheduleScrollToBlockedTarget === 'function') {
          scheduleScrollToBlockedTarget({
            kind: subId ? 'subgoal' : 'goal',
            goalId: goalId,
            subgoalId: subId,
            title: initiative.title || '',
          }, 0);
        }
      });
      renderGoalsList();
    }

    function renderInitiativeDetail(initiative, detailEl) {
      var detail = detailEl || document.getElementById('team-initiative-detail');
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
      var status = String(initiative.status || 'open').toLowerCase();
      var autoPromoted = initiativeWasAutoPromoted(initiative);
      var onMission = initiativeIsOnMission(initiative);
      var activeGoals = activeGoalsForInitiativePicker();
      var defaultGoalId = initiativePromotedGoalId(initiative) ||
        relatedGoals[0] ||
        (activeGoals[0] && activeGoals[0].id) ||
        '';
      var goalPickerHtml = activeGoals.length
        ? '<div class="team-initiative-row"><label><strong>Target mission:</strong> ' +
            '<select class="team-init-goal-picker" data-init-goal-picker="1">' +
            activeGoals.map(function (g) {
              var gid = String(g.id || '');
              var selected = gid === String(defaultGoalId) ? ' selected' : '';
              return '<option value="' + escapeHtml(gid) + '"' + selected + '>' +
                escapeHtml(String(g.title || g.objective || gid)) + '</option>';
            }).join('') +
            '</select></label></div>'
        : '<div class="team-initiative-row"><strong>Target mission:</strong> No active missions</div>';
      var badgeHtml = autoPromoted
        ? '<span class="team-initiative-auto-badge">Auto-promoted</span> '
        : (onMission ? '<span class="team-initiative-auto-badge">On mission</span> ' : '');
      var reviseHtml = onMission
        ? '<button type="button" class="secondary" data-init-action="view-mission">View on mission</button>' +
          '<button type="button" class="secondary" data-init-action="undo-promotion">Undo promotion</button>'
        : '';
      var reviewHtml = status !== 'rejected'
        ? '<button type="button" class="secondary" data-init-action="accept">Accept</button>' +
          '<button type="button" class="secondary" data-init-action="reject">Reject</button>' +
          (onMission ? '' : (
            '<button type="button" class="secondary" data-init-action="promote-goal">Create new mission</button>' +
            '<button type="button" class="secondary" data-init-action="promote-subgoal">Add to mission</button>'
          ))
        : '';
      detail.innerHTML = '' +
        '<h4>' + badgeHtml + escapeHtml(initiative.title || 'Untitled initiative') + '</h4>' +
        '<div class="team-initiative-row"><strong>Type:</strong> <span class="team-initiative-type">' + escapeHtml(initiative.type || 'observation') + '</span></div>' +
        '<div class="team-initiative-row"><strong>Status:</strong> <span class="team-initiative-status ' + escapeHtml(status) + '">' + escapeHtml(initiative.status || 'open') + '</span></div>' +
        '<div class="team-initiative-row"><strong>Confidence:</strong> ' + escapeHtml(String(Math.round((Number(initiative.confidence) || 0) * 100))) + '%</div>' +
        '<div class="team-initiative-row"><strong>Description:</strong> ' + escapeHtml(initiative.description || '') + '</div>' +
        '<div class="team-initiative-row"><strong>Source:</strong> ' + escapeHtml(initiative.source || '') + '</div>' +
        '<div class="team-initiative-row"><strong>Created by:</strong> ' + escapeHtml(agentNameById(initiative.createdBy || 'main')) + '</div>' +
        '<div class="team-initiative-row"><strong>Related goals:</strong> ' + escapeHtml(relatedLabel) + '</div>' +
        goalPickerHtml +
        '<div class="team-initiative-row"><strong>Activity:</strong> ' + escapeHtml(
          initiativeActivityLines(initiative).map(humanizeInitiativeActivityLine).join(' | ') || '—'
        ) + '</div>' +
        '<div class="team-initiative-row"><strong>Specialist reviews:</strong> ' + escapeHtml((initiative.specialistReviews || []).join(' | ') || '—') + '</div>' +
        '<div class="team-initiative-actions">' + reviseHtml + reviewHtml + '</div>';
      wireInitiativeDetailActions(detail, initiative);
    }

    function wireInitiativeDetailActions(detailEl, initiative) {
      if (!detailEl || !initiative || !initiative.id) return;
      function goalIdFromPicker() {
        var picker = detailEl.querySelector('[data-init-goal-picker]');
        if (picker && picker.value) return String(picker.value).trim();
        return initiativePromotedGoalId(initiative) ||
          ((Array.isArray(initiative.relatedGoalIds) ? initiative.relatedGoalIds : [])[0] || '');
      }
      detailEl.querySelectorAll('[data-init-action]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var action = btn.getAttribute('data-init-action') || '';
          btn.disabled = true;
          try {
            if (action === 'accept') {
              await fetch(API + '/api/initiatives/' + encodeURIComponent(initiative.id), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'accepted' }),
              }).catch(function () {});
              await fetchInitiativesSnapshot();
            } else if (action === 'reject') {
              await fetch(API + '/api/initiatives/' + encodeURIComponent(initiative.id), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'rejected' }),
              }).catch(function () {});
              await fetchInitiativesSnapshot();
            } else if (action === 'promote-goal') {
              await fetch(API + '/api/initiatives/' + encodeURIComponent(initiative.id) + '/promote', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'goal' }),
              }).catch(function () {});
              await fetchGoalsSnapshot();
              await fetchInitiativesSnapshot();
            } else if (action === 'promote-subgoal') {
              var goalId = goalIdFromPicker();
              if (!goalId) return;
              await fetch(API + '/api/initiatives/' + encodeURIComponent(initiative.id) + '/promote', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'subgoal', goalId: goalId }),
              }).catch(function () {});
              await fetchGoalsSnapshot();
              await fetchInitiativesSnapshot();
            } else if (action === 'view-mission') {
              viewInitiativeOnMission(initiative);
            } else if (action === 'undo-promotion') {
              if (!window.confirm('Remove this initiative from the mission and reopen it for review?')) return;
              await undoInitiativePromotion(initiative);
            }
          } finally {
            btn.disabled = false;
          }
        });
      });
    }

    function renderInitiativesPanel(opts) {
      opts = opts || {};
      var wrap = document.getElementById(opts.listId || 'team-initiatives-list');
      var detailEl = document.getElementById(opts.detailId || 'team-initiative-detail');
      if (!wrap) return;
      var initiatives = Array.isArray(teamInitiativesSnapshot.initiatives) ? teamInitiativesSnapshot.initiatives.slice() : [];
      initiatives.sort(function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); });
      if (!initiatives.length) {
        if (!selectedTeamInitiativeId) selectedTeamInitiativeId = '';
        wrap.innerHTML = '<p class="team-agent-inbox-empty" style="margin:0;padding:0.5rem 0;">No initiatives yet.</p>';
        if (detailEl) renderInitiativeDetail(null, detailEl);
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
        var badge = initiativeWasAutoPromoted(it)
          ? '<span class="team-initiative-auto-badge">Auto-promoted</span> '
          : (initiativeIsOnMission(it) ? '<span class="team-initiative-auto-badge">On mission</span> ' : '');
        return '<div class="team-initiative-card' + selected + '" data-initiative-id="' + escapeHtml(id) + '">' +
          '<div class="team-goal-card-head">' +
            '<h4 class="team-goal-card-title">' + badge + escapeHtml(it.title || 'Untitled initiative') + '</h4>' +
            '<span class="team-initiative-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' +
          '</div>' +
          '<div class="team-goal-meta"><span class="team-initiative-type">' + escapeHtml(it.type || 'observation') + '</span></div>' +
          '<div class="team-goal-meta"><strong>Confidence:</strong> ' + escapeHtml(String(confidence)) + '%</div>' +
          '<div class="team-goal-meta"><strong>Source:</strong> ' + escapeHtml(it.source || '') + '</div>' +
          '<div class="team-goal-meta">' + escapeHtml(String(it.description || '').slice(0, 180)) + '</div>' +
        '</div>';
      }).join('');
      var selectedInitiative = initiatives.find(function (i) { return String(i.id || '') === selectedTeamInitiativeId; }) || initiatives[0];
      if (detailEl) renderInitiativeDetail(selectedInitiative, detailEl);
      wrap.querySelectorAll('.team-initiative-card').forEach(function (card) {
        card.addEventListener('click', function () {
          var id = String(card.getAttribute('data-initiative-id') || '').trim();
          if (!id) return;
          selectedTeamInitiativeId = id;
          renderInitiativesPanels();
        });
      });
    }

    function renderInitiativesPanels() {
      renderInitiativesPanel({ listId: 'team-initiatives-list', detailId: 'team-initiative-detail' });
      renderInitiativesPanel({ listId: 'mc2-initiatives-list', detailId: 'mc2-initiative-detail' });
    }

    function renderInitiativesList() {
      renderInitiativesPanels();
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

    function humanizeTeamActivityMessage(msg) {
      return String(msg || '')
        .replace(/Auto-promoted initiative to subgoal:/gi, 'Added initiative to mission:')
        .replace(/Auto-promoted to subgoal in/gi, 'Added to mission')
        .replace(/Promoted to subgoal in/gi, 'Added to mission')
        .replace(/\bsubgoal\b/gi, 'task')
        .replace(/\bsubgoals\b/gi, 'tasks');
    }

    function activityNavFromEvent(ev) {
      if (!ev || typeof ev !== 'object') return null;
      var type = String(ev.type || '');
      var details = ev.details && typeof ev.details === 'object' ? ev.details : {};
      var agentId = String(ev.agentId || ev.ownerAgentId || '');
      var goalId = String(ev.goalId || details.goalId || '');
      var subgoalId = String(ev.subgoalId || details.subgoalId || '');
      var initiativeId = String(details.initiativeId || '');
      if (type === 'initiative_auto_promoted') {
        return {
          view: 'tasks',
          goalId: goalId,
          subgoalId: subgoalId,
          initiativeId: initiativeId,
          agentId: agentId,
        };
      }
      if (type === 'delegation_task_assigned') {
        return { view: 'tasks', goalId: goalId, subgoalId: subgoalId, agentId: agentId };
      }
      if (type === 'goal_subgoal_created') {
        return { view: 'tasks', goalId: goalId, subgoalId: subgoalId, agentId: agentId };
      }
      if (type === 'goal_tick_done' || type === 'goal_tick_error' || type === 'goal_tick_start') {
        return { view: 'tasks', goalId: goalId, agentId: agentId };
      }
      if (type === 'turn_start' || type === 'turn_done') {
        return { view: 'tasks', agentId: agentId };
      }
      if (type.indexOf('delegation_') === 0) {
        return { view: 'tasks', agentId: agentId, goalId: goalId, subgoalId: subgoalId };
      }
      if (type.indexOf('skill_') === 0) {
        return { view: 'tasks', agentId: agentId };
      }
      if (agentId) return { view: 'tasks', agentId: agentId };
      return null;
    }

    function mergeActivityNav(group, ev) {
      var nav = activityNavFromEvent(ev);
      if (nav) group.nav = nav;
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
      if (type === 'initiative_auto_promoted') {
        var initTitle = String(event.title || (details && details.title) || '').trim();
        if (!initTitle && msg) {
          var titleFromMsg = msg.match(/(?:Auto-promoted initiative to subgoal:|Added initiative to mission:)\s*(.+?)\s*\(\d+%/i);
          if (titleFromMsg) initTitle = String(titleFromMsg[1] || '').trim();
        }
        var missionName = missionTitleForGoalId(String(event.goalId || (details && details.goalId) || ''));
        var confMatch = msg.match(/\((\d+)%\s*confidence\)/i);
        var confPct = confMatch ? confMatch[1] : '';
        var line = 'Added <span class="accent">' + escapeHtml(initTitle || 'initiative') + '</span> to mission';
        if (missionName) line += ' <span class="accent">' + escapeHtml(missionName) + '</span>';
        if (confPct) line += ' (' + escapeHtml(confPct) + '% confidence)';
        line += ' — tap to open <span class="accent">Tasks</span>';
        return line;
      }
      if (msg) return escapeHtml(humanizeTeamActivityMessage(msg));
      return escapeHtml(type || 'event');
    }

    function formatTeamActivitySubline(event) {
      var type = String(event && event.type || '');
      var agent = agentNameById(String(event && event.agentId || ''));
      var target = agentNameById(String(event && event.targetAgentId || ''));
      var skill = String(event && event.skillId || '');
      var action = String(event && event.action || '');
      var msg = String(event && event.message || '');
      var details = event && typeof event.details === 'object' ? event.details : null;
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
      if (type === 'initiative_auto_promoted') {
        var initTitleSub = String(event.title || (details && details.title) || '').trim();
        var missionNameSub = missionTitleForGoalId(String(event.goalId || (details && details.goalId) || ''));
        var lineSub = 'Added <span class="accent">' + escapeHtml(initTitleSub || 'initiative') + '</span> to mission';
        if (missionNameSub) lineSub += ' <span class="accent">' + escapeHtml(missionNameSub) + '</span>';
        lineSub += ' — tap for Tasks';
        return lineSub;
      }
      if (msg) return escapeHtml(humanizeTeamActivityMessage(msg));
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
        mergeActivityNav(group, ev);
        openTurn[aid] = groups.length;
        groups.push(group);
        return group;
      }

      function appendToTurn(ev, group) {
        group.events.push(ev);
        group.ts = Math.max(group.ts || 0, Number(ev.ts) || 0);
        pushUniqueActivityLine(group, formatTeamActivitySubline(ev));
        mergeActivityNav(group, ev);
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
            mergeActivityNav(solo, ev);
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
        mergeActivityNav(standalone, ev);
        groups.push(standalone);
      });

      flushSkillBuffer(skillBuffer);

      groups.forEach(function (group) {
        if (group.events && group.events.length) {
          group.events.forEach(function (ev) { mergeActivityNav(group, ev); });
        }
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

    var MC2_PINNED_MOVEMENT_TYPES = {
      initiative_auto_promoted: true,
      initiative_scan_done: true,
    };

    function buildMissionControlMovementGroups(maxGroups) {
      maxGroups = Math.max(6, Number(maxGroups) || 10);
      var all = Array.isArray(teamActivityEvents) ? teamActivityEvents.slice() : [];
      var pinnedEvents = all.filter(function (ev) {
        return ev && MC2_PINNED_MOVEMENT_TYPES[String(ev.type || '')];
      }).slice(-6);
      var pinnedIds = {};
      pinnedEvents.forEach(function (ev) {
        if (ev && ev.id) pinnedIds[String(ev.id)] = true;
      });
      var pinnedGroups = pinnedEvents.map(function (ev) {
        var g = {
          ts: Number(ev.ts) || 0,
          agentId: String(ev.agentId || ''),
          lines: [],
          _keys: {},
        };
        mergeActivityNav(g, ev);
        pushUniqueActivityLine(g, formatTeamActivityText(ev));
        delete g._keys;
        return g;
      }).filter(function (g) { return g.lines && g.lines.length; });
      pinnedGroups.sort(function (a, b) { return (Number(b.ts) || 0) - (Number(a.ts) || 0); });
      var rest = all.filter(function (ev) { return !ev || !pinnedIds[String(ev.id || '')]; });
      var regular = groupTeamActivityEvents(rest.slice(-100));
      var seen = {};
      var out = [];
      function appendGroup(g) {
        if (!g || !g.lines || !g.lines.length) return;
        var key = activityLineKey(g.lines[0]);
        if (key && seen[key]) return;
        if (key) seen[key] = true;
        out.push(g);
      }
      pinnedGroups.forEach(appendGroup);
      regular.forEach(function (g) {
        if (out.length >= maxGroups) return;
        appendGroup(g);
      });
      return out.slice(0, maxGroups);
    }

    window.buildMissionControlMovementGroups = buildMissionControlMovementGroups;

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
      var nav = group && group.nav;
      if (!nav || !nav.view) {
        nav = agentId ? { view: 'tasks', agentId: agentId } : null;
      }
      var navClass = nav && nav.view ? ' mc-movement-clickable' : '';
      var navAttrs = '';
      if (nav && nav.view) {
        navAttrs = ' data-mc-movement-nav="' + escapeHtml(nav.view) + '"';
        if (nav.goalId) navAttrs += ' data-goal-id="' + escapeHtml(nav.goalId) + '"';
        if (nav.subgoalId) navAttrs += ' data-subgoal-id="' + escapeHtml(nav.subgoalId) + '"';
        if (nav.initiativeId) navAttrs += ' data-initiative-id="' + escapeHtml(nav.initiativeId) + '"';
        if (nav.agentId) navAttrs += ' data-agent-id="' + escapeHtml(nav.agentId) + '"';
      }
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
      return '<div class="mc-movement-item mc-activity-group' + navClass + '" data-ts="' + escapeHtml(String(ts)) + '"' + navAttrs + '>' +
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
      if (document.getElementById('page-team2') && document.getElementById('page-team2').classList.contains('active') &&
        typeof renderMissionControl === 'function' && !shouldPauseTeamDashboardRefresh()) {
        renderMissionControl();
      }
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
      if (document.getElementById('page-team2') && document.getElementById('page-team2').classList.contains('active') &&
        typeof renderMissionControl === 'function' && !shouldPauseTeamDashboardRefresh()) {
        renderMissionControl();
      }
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
      renderCurrentMission();
      renderTeamTaskSummary();
      if (typeof renderMissionControl === 'function' && !shouldPauseTeamDashboardRefresh()) {
        renderMissionControl();
      }
      if (!shouldPauseTeamDashboardRefresh()) renderTeamUserInputModal();
    }

    var teamUserInputGoalId = '';
    var teamUserInputDismissed = {};
    var teamUserInputModalWired = false;
    var teamUserInputSubmitBusy = false;
    var TEAM_USER_INPUT_DISMISSED_KEY = 'pasture_team_user_input_dismissed_v1';

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

    function countBlockedSubgoalsForGoal(goal) {
      if (!goal) return 0;
      var count = 0;
      function walk(subgoals) {
        (subgoals || []).forEach(function (sg) {
          if (!sg || typeof sg !== 'object') return;
          if (effectiveSubgoalStatus(sg, goal) === 'blocked') count++;
          walk(sg.subgoals);
        });
      }
      walk(goal.subgoals);
      return count;
    }

    function goalAttentionPrompt(goal) {
      if (!goal) return '';
      var ask = String(goal.needsUserInput || '').trim();
      if (ask) return ask;
      var blockedN = countBlockedSubgoalsForGoal(goal);
      if (blockedN > 0) {
        return 'This mission has ' + blockedN + ' blocked task(s). Tell the team what to do next — e.g. your analytics choice, "use default", or step-by-step instructions to unblock.';
      }
      if (isGoalPartialWait(goal)) {
        return goalImplementationBlockedLabel(goal) || 'Implementation is paused until you confirm the next step. Reply with your choice or "use default".';
      }
      if (String(goal.status || '').toLowerCase() === 'blocked') {
        return String(goal.blockedReason || '').trim() || 'This mission is blocked. What should the team do next?';
      }
      return '';
    }

    function goalNeedsAttention(goal) {
      if (!goal) return false;
      if (String(goal.needsUserInput || '').trim()) return true;
      if (countBlockedSubgoalsForGoal(goal) > 0) return true;
      if (isGoalPartialWait(goal)) return true;
      if (String(goal.status || '').toLowerCase() === 'blocked') return true;
      return false;
    }

    function teamUserInputDismissKey(goal) {
      return String(goal.id || '') + '::' + goalAttentionPrompt(goal).slice(0, 240);
    }

    function isTeamUserInputModalOpen() {
      var modal = document.getElementById('team-user-input-modal');
      return !!(modal && modal.classList.contains('open'));
    }

    function shouldPauseTeamDashboardRefresh() {
      return isTeamUserInputModalOpen();
    }

    function isTeamMainViewActive() {
      if (document.body.classList.contains('dashboard-team2-active')) {
        return true;
      }
      if (document.body.classList.contains('dashboard-team-active')) {
        return teamTopTab === 'roster';
      }
      return false;
    }

    function getGoalsNeedingUserInput() {
      return (Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : []).filter(function (g) {
        return goalNeedsAttention(g);
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

    function openTeamUserInputModal(goal, opts) {
      opts = opts || {};
      var modal = document.getElementById('team-user-input-modal');
      var missionEl = document.getElementById('team-user-input-modal-mission');
      var questionEl = document.getElementById('team-user-input-modal-question');
      var quickEl = document.getElementById('team-user-input-modal-quick');
      var textEl = document.getElementById('team-user-input-modal-text');
      if (!modal || !goal) return;
      var id = String(goal.id || '');
      var ask = String(opts.ask || goal.needsUserInput || '').trim();
      if (!ask) ask = goalAttentionPrompt(goal);
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

    function openMissionWorkInputModal(item) {
      if (!item || !item.goalId) return false;
      var goal = (Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : []).find(function (g) {
        return String(g.id || '') === String(item.goalId || '');
      });
      if (!goal) return false;
      var ask = goalAttentionPrompt(goal);
      if (item.title && item.kind === 'subgoal') {
        ask = 'Blocked task: "' + String(item.title) + '". ' + ask;
      }
      openTeamUserInputModal(goal, { ask: ask });
      return true;
    }

    async function patchMissionSubgoalStatus(goalId, subgoalId, nextStatus) {
      var gid = String(goalId || '').trim();
      var sid = String(subgoalId || '').trim();
      if (!gid || !sid) return false;
      var goal = (Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : []).find(function (g) {
        return String(g.id || '') === gid;
      });
      if (!goal) return false;
      function patchTree(subgoals) {
        return (subgoals || []).map(function (sg) {
          if (!sg || typeof sg !== 'object') return sg;
          var next = Object.assign({}, sg);
          if (String(next.id || '') === sid) {
            next.status = nextStatus;
          }
          if (Array.isArray(next.subgoals) && next.subgoals.length) {
            next.subgoals = patchTree(next.subgoals);
          }
          return next;
        });
      }
      try {
        var r = await fetch(API + '/api/goals/' + encodeURIComponent(gid), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subgoals: patchTree(goal.subgoals) }),
        });
        if (!r.ok) return false;
        await fetchGoalsSnapshot();
        if (typeof renderMissionControl === 'function') renderMissionControl();
        return true;
      } catch (_) {
        return false;
      }
    }

    function findGoalById(goalId) {
      var gid = String(goalId || '').trim();
      if (!gid) return null;
      var goals = Array.isArray(teamGoalsSnapshot.goals) ? teamGoalsSnapshot.goals : [];
      for (var i = 0; i < goals.length; i++) {
        if (String(goals[i].id || '') === gid) return goals[i];
      }
      return null;
    }

    function findMissionTaskItemByTitle(title) {
      var needle = String(title || '').trim().toLowerCase();
      if (!needle) return null;
      var items = typeof flattenMissionWorkItems === 'function' ? flattenMissionWorkItems() : [];
      var i;
      for (i = 0; i < items.length; i++) {
        if (String(items[i].title || '').trim().toLowerCase() === needle) return items[i];
      }
      for (i = 0; i < items.length; i++) {
        var t = String(items[i].title || '').toLowerCase();
        if (t && (t.indexOf(needle.slice(0, 48)) >= 0 || needle.indexOf(t.slice(0, 48)) >= 0)) return items[i];
      }
      return null;
    }

    function extractSkillsFromTurnEvents(agentId, turnDoneTs) {
      var aid = String(agentId || '').trim();
      var doneTs = Number(turnDoneTs) || 0;
      if (!aid || !doneTs) return [];
      var events = teamActivityEvents || [];
      var startTs = 0;
      var skills = [];
      var seen = {};
      for (var i = events.length - 1; i >= 0; i--) {
        var ev = events[i];
        if (!ev || String(ev.agentId || '') !== aid) continue;
        if (String(ev.type || '') === 'turn_done' && Number(ev.ts) === doneTs) {
          for (var j = i - 1; j >= 0; j--) {
            var prev = events[j];
            if (String(prev.agentId || '') !== aid) continue;
            if (String(prev.type || '') === 'turn_start') {
              startTs = Number(prev.ts) || 0;
              break;
            }
            if (String(prev.type || '') === 'turn_done') break;
          }
          break;
        }
      }
      events.forEach(function (ev) {
        if (!ev || String(ev.agentId || '') !== aid) return;
        var ts = Number(ev.ts) || 0;
        if (startTs && ts < startTs) return;
        if (doneTs && ts > doneTs + 5000) return;
        var type = String(ev.type || '');
        if (type !== 'skill_start' && type !== 'skill_done') return;
        var skillId = String(ev.skillId || '').trim();
        if (!skillId || seen[skillId]) return;
        seen[skillId] = true;
        skills.push(skillId);
      });
      return skills;
    }

    function missionTaskDisplayTitle(task) {
      var prompt = String(task && task.prompt || '').trim();
      if (prompt && !/^Handled in \d+/i.test(prompt) && !/^Completed turn/i.test(prompt)) {
        return prompt.slice(0, 160);
      }
      var summary = String(task && task.summary || '').trim();
      if (summary && !/^Handled in \d+/i.test(summary)) return summary.slice(0, 160);
      return 'Completed task';
    }

    function buildMissionTaskFromTurn(opts) {
      opts = opts || {};
      var agentId = String(opts.agentId || '').trim();
      var ts = Number(opts.ts) || 0;
      if (!agentId || !ts) return null;
      var task = null;
      if (typeof listCompletedTasks === 'function') {
        ['today', 'yesterday', 'last7', 'last30'].some(function (range) {
          var list = listCompletedTasks({ range: range, agentId: agentId });
          for (var i = 0; i < list.length; i++) {
            if (Number(list[i].ts) === ts) {
              task = list[i];
              return true;
            }
          }
          return false;
        });
      }
      if (!task) return null;
      var title = missionTaskDisplayTitle(task);
      var matched = findMissionTaskItemByTitle(title);
      if (matched) {
        return enrichMissionTaskItem(Object.assign({}, matched, {
          prompt: task.prompt,
          summary: task.summary,
          turnTs: ts,
        }));
      }
      return enrichMissionTaskItem({
        kind: 'turn',
        title: title,
        status: 'done',
        assignee: agentId,
        agentId: agentId,
        completedAt: ts,
        createdAt: ts,
        prompt: task.prompt,
        summary: task.summary,
        reason: String(task.prompt || task.summary || '').trim(),
        skillsUsed: extractSkillsFromTurnEvents(agentId, ts),
      });
    }

    function initiativeWasAutoPromoted(initiative) {
      var lines = Array.isArray(initiative && initiative.activity) ? initiative.activity : [];
      return lines.some(function (line) {
        return String(line || '').indexOf('Auto-promoted to subgoal in ') >= 0;
      });
    }

    function countGoalTicksBefore(goalId, beforeTs) {
      var gid = String(goalId || '').trim();
      if (!gid) return 0;
      var cutoff = Number(beforeTs) || Date.now();
      var ticks = (teamActivityEvents || []).filter(function (ev) {
        return ev &&
          String(ev.type || '') === 'goal_tick_start' &&
          String(ev.goalId || '') === gid &&
          Number(ev.ts) <= cutoff;
      }).sort(function (a, b) { return (Number(a.ts) || 0) - (Number(b.ts) || 0); });
      return ticks.length;
    }

    function formatMissionSourceLabel(kind) {
      var labels = {
        initiative_auto_promotion: 'Initiative Auto Promotion',
        initiative_promotion: 'Initiative Promotion',
        goal_tick: 'Goal Tick',
        curiosity_momentum: 'Curiosity Momentum',
        agent_delegation: 'Agent Delegation',
        user_request: 'User Request',
        agent_turn: 'Agent Task',
        mission_planning: 'Mission Planning',
      };
      return labels[kind] || labels.mission_planning;
    }

    function findTaskOriginEvents(item) {
      var subgoalId = String(item && item.subgoalId || '');
      var goalId = String(item && item.goalId || '');
      var titleNeedle = String(item && item.title || '').trim().toLowerCase().slice(0, 40);
      var out = { promoteEv: null, createEv: null, assignEv: null };
      (teamActivityEvents || []).forEach(function (ev) {
        if (!ev) return;
        var type = String(ev.type || '');
        var details = ev.details && typeof ev.details === 'object' ? ev.details : {};
        var evSubId = String(details.subgoalId || ev.subgoalId || '');
        var evGoalId = String(details.goalId || ev.goalId || '');
        var matchSub = subgoalId && evSubId === subgoalId;
        var matchGoalTitle = !matchSub && goalId && evGoalId === goalId && titleNeedle &&
          (String(ev.title || details.title || ev.message || '').toLowerCase().indexOf(titleNeedle.slice(0, 24)) >= 0);
        if (!matchSub && !matchGoalTitle) return;
        if (type === 'initiative_auto_promoted' && !out.promoteEv) out.promoteEv = ev;
        if (type === 'goal_subgoal_created' && !out.createEv) out.createEv = ev;
        if (type === 'delegation_task_assigned' && !out.assignEv) out.assignEv = ev;
      });
      return out;
    }

    function buildMissionTaskSourceChain(item) {
      if (!item) return null;
      var chain = {
        createdBy: '',
        agent: '',
        agentId: '',
        source: '',
        sourceKind: 'mission_planning',
        confidence: null,
        initiativeTitle: '',
        initiativeId: '',
      };
      var goalId = String(item.goalId || '');
      var subgoalId = String(item.subgoalId || '');
      var initiative = typeof findInitiativeForSubgoalId === 'function'
        ? findInitiativeForSubgoalId(subgoalId)
        : null;
      var origin = findTaskOriginEvents(item);
      var promoteEv = origin.promoteEv;
      var createEv = origin.createEv;
      var assignEv = origin.assignEv;

      if (initiative || promoteEv || /^init-/.test(subgoalId)) {
        var auto = (initiative && initiativeWasAutoPromoted(initiative)) || !!promoteEv;
        chain.sourceKind = auto ? 'initiative_auto_promotion' : 'initiative_promotion';
        chain.source = formatMissionSourceLabel(chain.sourceKind);
        chain.initiativeId = initiative
          ? String(initiative.id || '')
          : initiativeIdFromSubgoalId(subgoalId);
        chain.initiativeTitle = initiative ? String(initiative.title || '') : String(item.title || '');
        var conf = initiative ? Number(initiative.confidence) : NaN;
        if (!isFinite(conf) && promoteEv) {
          var confMatch = String(promoteEv.message || '').match(/\((\d+)%\s*confidence\)/i);
          if (confMatch) conf = Number(confMatch[1]) / 100;
        }
        if (isFinite(conf) && conf > 0) {
          chain.confidence = Math.round(conf <= 1 ? conf * 100 : conf);
        }
        var originTs = (initiative && Number(initiative.createdAt)) ||
          (promoteEv && Number(promoteEv.ts)) ||
          Number(item.createdAt) || Date.now();
        var tickGoalId = goalId ||
          (initiative && Array.isArray(initiative.relatedGoalIds) && initiative.relatedGoalIds[0]) ||
          String(promoteEv && promoteEv.goalId || '');
        var tickNum = countGoalTicksBefore(tickGoalId, originTs);
        chain.createdBy = tickNum ? ('Goal Tick #' + tickNum) : 'Initiative Scan';
        chain.agentId = (initiative && String(initiative.createdBy || '')) ||
          String(promoteEv && (promoteEv.agentId || promoteEv.ownerAgentId) || '') ||
          String(item.assignee || item.agentId || '');
        chain.agent = agentNameById(chain.agentId) || chain.agentId || '—';
        return chain;
      }

      if (String(item.source || '') === 'delegation' || assignEv || item.delegatedFrom) {
        chain.sourceKind = 'agent_delegation';
        chain.source = formatMissionSourceLabel(chain.sourceKind);
        chain.agentId = String(item.assignee || item.agentId || (assignEv && assignEv.targetAgentId) || '');
        chain.agent = agentNameById(chain.agentId) || '—';
        var delegator = String(item.delegatedFrom || (assignEv && assignEv.agentId) || '').trim();
        chain.createdBy = delegator ? agentNameById(delegator) : 'Agent Delegation';
        if (assignEv && goalId) {
          var dTick = countGoalTicksBefore(goalId, assignEv.ts);
          if (dTick) chain.createdBy = 'Goal Tick #' + dTick;
        }
        return chain;
      }

      if (createEv) {
        var createMsg = String(createEv.message || '');
        var isCuriosity = /curiosity subgoal/i.test(createMsg);
        chain.sourceKind = isCuriosity ? 'curiosity_momentum' : 'goal_tick';
        chain.source = formatMissionSourceLabel(chain.sourceKind);
        var cGoalId = goalId || String(createEv.goalId || '');
        var cTick = countGoalTicksBefore(cGoalId, createEv.ts);
        chain.createdBy = cTick ? ('Goal Tick #' + cTick) : (isCuriosity ? 'Curiosity Cycle' : 'Goal Tick');
        chain.agentId = String(createEv.agentId || createEv.ownerAgentId || item.assignee || item.agentId || '');
        chain.agent = agentNameById(chain.agentId) || '—';
        return chain;
      }

      if (item.kind === 'turn' || item.turnTs) {
        chain.sourceKind = 'agent_turn';
        chain.source = formatMissionSourceLabel(chain.sourceKind);
        chain.createdBy = 'Agent Turn';
        chain.agentId = String(item.assignee || item.agentId || '');
        chain.agent = agentNameById(chain.agentId) || '—';
        return chain;
      }

      var goal = goalId ? findGoalById(goalId) : null;
      if (goal && String(goal.needsUserInput || '').trim()) {
        chain.sourceKind = 'user_request';
        chain.source = formatMissionSourceLabel(chain.sourceKind);
        chain.createdBy = 'User';
        chain.agentId = String(item.assignee || goal.ownerAgentId || '');
        chain.agent = agentNameById(chain.agentId) || '—';
        return chain;
      }

      chain.source = formatMissionSourceLabel('mission_planning');
      var fallbackTick = countGoalTicksBefore(goalId, item.createdAt || Date.now());
      chain.createdBy = fallbackTick ? ('Goal Tick #' + fallbackTick) : 'Mission Planning';
      chain.agentId = String(item.assignee || (goal && goal.ownerAgentId) || item.agentId || '');
      chain.agent = agentNameById(chain.agentId) || '—';
      return chain;
    }

    var MISSION_TASK_INITIATIVE_ARCHIVE_DAYS = 3;
    var MISSION_TASK_MANUAL_INIT_ARCHIVE_DAYS = 7;

    function formatInactionDaysRemaining(deadlineTs) {
      var ms = Number(deadlineTs) - Date.now();
      if (!Number(deadlineTs)) return null;
      if (ms <= 0) return 'Soon';
      var days = Math.ceil(ms / 86400000);
      if (days === 1) return '1 day';
      return days + ' days';
    }

    function missionTaskImpactFromInitiative(initiative) {
      if (!initiative) return 'Medium';
      var initType = String(initiative.type || 'observation').toLowerCase();
      if (initType === 'risk' || initType === 'gap' || initType === 'warning') return 'High';
      var conf = Number(initiative.confidence);
      if (!isFinite(conf)) return 'Medium';
      var pct = conf <= 1 ? conf * 100 : conf;
      if (pct >= 80) return 'High';
      if (pct >= 55) return 'Medium';
      return 'Low';
    }

    function buildMissionTaskInactionImpact(item) {
      if (!item) return null;
      var status = String(item.status || '').toLowerCase();
      if (status === 'done') {
        return {
          required: false,
          requiredLabel: 'No',
          autoArchiveIn: null,
          impact: 'None',
          impactKind: 'none',
          summary: 'Task is complete — no action needed.',
          lines: [
            { label: 'Required?', value: 'No' },
            { label: 'Impact', value: 'None' },
          ],
        };
      }

      var goal = item.goalId ? findGoalById(item.goalId) : null;
      var initiative = (item.fromInitiative || /^init-/.test(String(item.subgoalId || '')))
        ? findInitiativeForSubgoalId(item.subgoalId)
        : null;
      var autoPromoted = initiative && initiativeWasAutoPromoted(initiative);

      function pack(required, impact, summary, autoArchiveIn, extraLines) {
        var lines = [
          { label: 'Required?', value: required ? 'Yes' : 'No' },
        ];
        if (autoArchiveIn) lines.push({ label: 'Auto archive in', value: autoArchiveIn });
        lines.push({ label: 'Impact', value: impact });
        if (summary) lines.push({ label: 'Consequence', value: summary });
        if (extraLines && extraLines.length) lines = lines.concat(extraLines);
        return {
          required: required,
          requiredLabel: required ? 'Yes' : 'No',
          autoArchiveIn: autoArchiveIn,
          impact: impact,
          impactKind: String(impact || 'low').toLowerCase(),
          summary: summary,
          lines: lines,
        };
      }

      if (item.kind === 'agent' || status === 'blocked') {
        var blockedMsg = status === 'blocked'
          ? 'Mission progress blocked until you respond to this task.'
          : 'Agent remains blocked until the underlying issue is resolved.';
        if (goal && String(goal.needsUserInput || '').trim()) {
          blockedMsg = 'Mission progress blocked until reviewed.';
        }
        return pack(true, 'High', blockedMsg, null);
      }

      if (goal) {
        var needsInput = String(goal.needsUserInput || '').trim();
        var partialWait = typeof isGoalPartialWait === 'function' && isGoalPartialWait(goal);
        if (needsInput) {
          return pack(true, 'High', 'Mission progress blocked until you respond.', null);
        }
        if (partialWait) {
          return pack(true, 'High', 'Implementation blocked — mission continues research only until resolved.', null);
        }
        if (String(goal.status || '').toLowerCase() === 'blocked') {
          return pack(true, 'High', 'Mission progress blocked until reviewed.', null);
        }
      }

      if (autoPromoted && initiative) {
        var promotedTs = Number(initiative.updatedAt || initiative.createdAt || item.createdAt) || Date.now();
        var archiveDeadline = promotedTs + (MISSION_TASK_INITIATIVE_ARCHIVE_DAYS * 86400000);
        var impact = missionTaskImpactFromInitiative(initiative);
        var archiveIn = formatInactionDaysRemaining(archiveDeadline);
        var advisory = 'Agents keep working on other tasks. Unreviewed auto-promoted tasks archive and leave the mission after ' +
          MISSION_TASK_INITIATIVE_ARCHIVE_DAYS + ' days.';
        return pack(false, impact, advisory, archiveIn);
      }

      if (initiative && typeof initiativeIsOnMission === 'function' && initiativeIsOnMission(initiative)) {
        var manualTs = Number(initiative.updatedAt || item.createdAt) || Date.now();
        var manualArchive = formatInactionDaysRemaining(manualTs + (MISSION_TASK_MANUAL_INIT_ARCHIVE_DAYS * 86400000));
        return pack(
          false,
          missionTaskImpactFromInitiative(initiative),
          'Task stays on the mission board. Review or undo promotion when convenient.',
          manualArchive
        );
      }

      var dueAt = Number(item.dueAt) || 0;
      if (dueAt > 0 && dueAt < Date.now()) {
        return pack(
          true,
          'High',
          'Delegated task is overdue — downstream work may be waiting on this.',
          null
        );
      }
      if (dueAt > 0) {
        var dueIn = formatInactionDaysRemaining(dueAt);
        return pack(
          false,
          'Medium',
          'Task stays active until completed or reassigned.',
          null,
          dueIn ? [{ label: 'Due in', value: dueIn }] : []
        );
      }

      if (String(item.source || '') === 'delegation') {
        return pack(
          false,
          'Medium',
          'Assignee continues work. Re-delegate or mark done if this stalls.',
          null
        );
      }

      return pack(
        false,
        'Low',
        'Agents continue other mission work. This task stays open on the board.',
        null
      );
    }

    function enrichMissionTaskItem(item) {
      if (!item) return null;
      var out = Object.assign({}, item);
      var goal = out.goalId ? findGoalById(out.goalId) : null;
      var events = typeof buildMissionTaskTimeline === 'function' ? buildMissionTaskTimeline(out, 40) : [];
      var createdEv = null;
      var assignedEv = null;
      var delegatedEv = null;
      var completedEv = null;
      events.forEach(function (ev) {
        var type = String(ev && ev.type || '');
        if (type === 'goal_subgoal_created' && !createdEv) createdEv = ev;
        if (type === 'delegation_task_assigned' && !assignedEv) assignedEv = ev;
        if (type === 'delegation_start' && !delegatedEv) delegatedEv = ev;
        if (type === 'turn_done' && !completedEv) completedEv = ev;
      });

      if (!out.createdAt) {
        if (createdEv) out.createdAt = Number(createdEv.ts) || 0;
        else if (out.delegatedAt) out.createdAt = Number(out.delegatedAt) || 0;
        else if (goal && goal.createdAt) out.createdAt = Number(goal.createdAt) || 0;
        else if (out.turnTs) out.createdAt = Number(out.turnTs) || 0;
      }
      if (!out.completedAt && String(out.status || '').toLowerCase() === 'done') {
        out.completedAt = Number(out.updatedAt) || 0;
        if (completedEv) out.completedAt = Number(completedEv.ts) || out.completedAt;
        else if (out.turnTs) out.completedAt = Number(out.turnTs) || 0;
      }
      if (!out.createdByLabel) {
        if (out.delegatedFrom) {
          out.createdByLabel = agentNameById(out.delegatedFrom) || out.delegatedFrom;
        } else if (createdEv && String(createdEv.agentId || '').trim()) {
          out.createdByLabel = agentNameById(createdEv.agentId);
        } else if (out.fromInitiative) {
          out.createdByLabel = createdEv && createdEv.agentId ? agentNameById(createdEv.agentId) : 'Agent';
        } else if (goal && String(goal.needsUserInput || '').trim()) {
          out.createdByLabel = 'User';
        } else {
          out.createdByLabel = 'User';
        }
      }
      if (!out.reason) {
        out.reason = String(out.description || '').trim();
        if (!out.reason && goal) {
          out.reason = String(goal.needsUserInput || goal.objective || '').trim();
        }
        if (!out.reason && out.prompt) out.reason = String(out.prompt).trim();
        if (!out.reason && out.summary) out.reason = String(out.summary).trim();
      }
      if (!out.skillsUsed || !out.skillsUsed.length) {
        var skills = [];
        var seenSkills = {};
        events.forEach(function (ev) {
          var type = String(ev && ev.type || '');
          if (type !== 'skill_start' && type !== 'skill_done') return;
          var skillId = String(ev.skillId || '').trim();
          if (!skillId || seenSkills[skillId]) return;
          seenSkills[skillId] = true;
          skills.push(skillId);
        });
        if (!skills.length && out.turnTs && out.assignee) {
          skills = extractSkillsFromTurnEvents(out.assignee || out.agentId, out.turnTs || out.completedAt);
        }
        if (!skills.length && goal && String(goal.source || '').indexOf('workflow') >= 0) {
          skills.push('project-workflow');
        }
        out.skillsUsed = skills;
      }
      if (!out.missionTitle && goal) {
        out.missionTitle = String(goal.title || goal.objective || '').trim();
      }
      if (!out.assignee && out.agentId) out.assignee = out.agentId;
      out.sourceChain = buildMissionTaskSourceChain(out);
      if (out.sourceChain && out.sourceChain.createdBy) {
        out.createdByLabel = out.sourceChain.createdBy;
      }
      out.inactionImpact = buildMissionTaskInactionImpact(out);
      return out;
    }

    function buildStructuredMissionTaskTimeline(item, limit) {
      limit = Math.max(6, Number(limit) || 20);
      if (!item) return [];
      var raw = typeof buildMissionTaskTimeline === 'function' ? buildMissionTaskTimeline(item, limit * 2) : [];
      var structured = [];
      var seen = {};
      function push(ts, label) {
        var t = Number(ts) || 0;
        var key = String(t) + '|' + String(label || '');
        if (!label || seen[key]) return;
        seen[key] = true;
        structured.push({ ts: t, label: label });
      }

      raw.forEach(function (ev) {
        var type = String(ev && ev.type || '');
        var ts = Number(ev.ts) || 0;
        if (type === 'goal_subgoal_created') push(ts, 'Created');
        else if (type === 'delegation_task_assigned') push(ts, 'Assigned');
        else if (type === 'delegation_start') push(ts, 'Delegated');
        else if (type === 'turn_start') push(ts, 'Started');
        else if (type === 'turn_done') push(ts, 'Completed');
        else if (type === 'initiative_auto_promoted') push(ts, 'Added to mission');
        else if (type === 'skill_start' || type === 'skill_done') {
          var skill = String(ev.skillId || 'work').replace(/[-_]/g, ' ');
          push(ts, (type === 'skill_done' ? 'Finished ' : 'Started ') + skill);
        } else if (typeof formatMissionTaskTimelineLine === 'function') {
          var line = formatMissionTaskTimelineLine(ev);
          var text = stripActivityHtml(line).replace(/^\d{1,2}:\d{2}\s*/, '').trim();
          if (text) push(ts, text);
        }
      });

      if (!structured.length) {
        if (item.createdAt) push(item.createdAt, 'Created');
        if (item.delegatedFrom && item.delegatedAt) push(item.delegatedAt, 'Assigned');
        if (item.completedAt && String(item.status || '') === 'done') push(item.completedAt, 'Completed');
      }

      structured.sort(function (a, b) { return (Number(a.ts) || 0) - (Number(b.ts) || 0); });
      return structured.slice(-limit);
    }

    function formatStructuredMissionTaskTimelineLine(entry) {
      if (!entry) return '';
      var ts = Number(entry.ts) || Date.now();
      var time = new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      return '<li class="mc-task-timeline-item"><span class="mc-task-timeline-time">' + escapeHtml(time) + '</span>' +
        '<span class="mc-task-timeline-text">' + escapeHtml(String(entry.label || '')) + '</span></li>';
    }

    function findMissionTaskItem(opts) {
      opts = opts || {};
      var items = typeof flattenMissionWorkItems === 'function' ? flattenMissionWorkItems() : [];
      var goalId = String(opts.goalId || '').trim();
      var subgoalId = String(opts.subgoalId || '').trim();
      var agentId = String(opts.agentId || '').trim();
      var title = String(opts.title || '').trim().toLowerCase();
      var i;
      if (subgoalId) {
        for (i = 0; i < items.length; i++) {
          if (String(items[i].subgoalId || '') === subgoalId) {
            if (!goalId || String(items[i].goalId || '') === goalId) return items[i];
          }
        }
      }
      if (agentId) {
        var agentItems = items.filter(function (it) {
          return it.kind === 'subgoal' &&
            String(it.assignee || it.agentId || '') === agentId &&
            String(it.status || '') !== 'done';
        });
        if (title) {
          for (i = 0; i < agentItems.length; i++) {
            if (String(agentItems[i].title || '').toLowerCase().indexOf(title.slice(0, 40)) >= 0) return agentItems[i];
          }
        }
        if (agentItems.length) return agentItems[0];
      }
      if (title && !subgoalId && !goalId) {
        var byTitleOnly = findMissionTaskItemByTitle(title);
        if (byTitleOnly) return byTitleOnly;
      }
      if (title && goalId) {
        for (i = 0; i < items.length; i++) {
          if (String(items[i].goalId || '') === goalId &&
            String(items[i].title || '').toLowerCase().indexOf(title.slice(0, 40)) >= 0) {
            return items[i];
          }
        }
      }
      return null;
    }

    function findMissionTaskForAgent(agentId, ctx) {
      var aid = String(agentId || '').trim();
      if (!aid) return null;
      var items = typeof flattenMissionWorkItems === 'function' ? flattenMissionWorkItems() : [];
      var active = items.filter(function (it) {
        return it.kind === 'subgoal' &&
          String(it.assignee || it.agentId || '') === aid &&
          (it.status === 'blocked' || it.status === 'doing' || it.status === 'todo');
      });
      if (active.length === 1) return active[0];
      ctx = ctx || (teamAgentContextSnapshot.agents || {})[aid] || {};
      var needle = String(ctx.currentStep || ctx.currentGoal || ctx.currentThought || ctx.lastAction || '').trim().toLowerCase();
      if (needle) {
        for (var i = 0; i < active.length; i++) {
          var t = String(active[i].title || '').toLowerCase();
          if (t && (t.indexOf(needle.slice(0, 32)) >= 0 || needle.indexOf(t.slice(0, 32)) >= 0)) return active[i];
        }
      }
      return active[0] || null;
    }

    function buildMissionTaskTimeline(item, limit) {
      limit = Math.max(4, Number(limit) || 14);
      if (!item) return [];
      var goalId = String(item.goalId || '');
      var subgoalId = String(item.subgoalId || '');
      var assignee = String(item.assignee || item.agentId || '');
      var titleNeedle = String(item.title || '').trim().toLowerCase().slice(0, 48);
      var matched = [];
      (teamActivityEvents || []).forEach(function (ev) {
        if (!ev) return;
        var details = ev.details && typeof ev.details === 'object' ? ev.details : {};
        var evGoalId = String(details.goalId || ev.goalId || '');
        var evSubId = String(details.subgoalId || '');
        var hit = false;
        if (subgoalId && evSubId === subgoalId) hit = true;
        if (!hit && subgoalId && String(ev.type || '') === 'initiative_auto_promoted' &&
          String(ev.title || details.title || '').toLowerCase().indexOf(titleNeedle.slice(0, 24)) >= 0) {
          hit = true;
        }
        if (!hit && goalId && evGoalId === goalId) {
          if (!subgoalId || !titleNeedle) hit = true;
          else {
            var blob = (String(ev.message || '') + ' ' + String(ev.title || details.title || '')).toLowerCase();
            if (blob.indexOf(titleNeedle.slice(0, 24)) >= 0) hit = true;
          }
        }
        if (!hit && assignee && (String(ev.agentId || '') === assignee || String(ev.targetAgentId || '') === assignee)) {
          if (!titleNeedle) hit = true;
          else {
            var msg = (String(ev.message || '') + ' ' + String(ev.title || '')).toLowerCase();
            if (msg.indexOf(titleNeedle.slice(0, 24)) >= 0) hit = true;
          }
        }
        if (hit) matched.push(ev);
      });
      matched.sort(function (a, b) { return (Number(b.ts) || 0) - (Number(a.ts) || 0); });
      return matched.slice(0, limit);
    }

    function formatMissionTaskTimelineLine(ev) {
      if (!ev) return '';
      var ts = Number(ev.ts) || Date.now();
      var time = new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      var agent = agentNameById(String(ev.agentId || ''));
      var target = agentNameById(String(ev.targetAgentId || ''));
      var type = String(ev.type || '');
      var msg = String(ev.message || '');
      var line = '';
      if (type === 'delegation_start') {
        line = agent + ' handed off to ' + target;
        if (msg) line += ' — ' + msg;
      } else if (type === 'delegation_done') {
        line = target + ' replied to ' + agent;
      } else if (type === 'initiative_auto_promoted') {
        line = 'Added to mission' + (msg ? ': ' + humanizeTeamActivityMessage(msg).replace(/^Added initiative to mission:\s*/i, '') : '');
      } else if (type === 'skill_start' || type === 'skill_done') {
        line = agent + ' ' + (type === 'skill_done' ? 'finished' : 'started') + ' ' + String(ev.skillId || 'work');
      } else if (type === 'turn_start') {
        line = agent + ' picked up: ' + (msg || 'task');
      } else if (type === 'turn_done') {
        line = agent + ' finished turn';
      } else if (msg) {
        line = humanizeTeamActivityMessage(msg);
      } else {
        line = type || 'activity';
      }
      return '<li class="mc-task-timeline-item"><span class="mc-task-timeline-time">' + escapeHtml(time) + '</span>' +
        '<span class="mc-task-timeline-text">' + escapeHtml(line) + '</span></li>';
    }

    function stripActivityHtml(html) {
      return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    function humanizeAgentSkillLabel(skillId, action, message) {
      var msg = String(message || '').trim();
      if (msg && !/^Skill /i.test(msg) && !/^Running /i.test(msg)) {
        return humanizeTeamActivityMessage(msg).replace(/\.$/, '');
      }
      var skill = String(skillId || '').trim();
      var act = String(action || '').trim();
      if (skill === 'agent-send') return 'Delegated task';
      if (skill === 'go-read' || skill === 'go-write') return 'Analyzed codebase';
      if (skill === 'search') return act ? ('Searched ' + act) : 'Searched';
      if (skill === 'browse') return act ? ('Reviewed ' + act) : 'Reviewed site';
      if (act) return act.charAt(0).toUpperCase() + act.slice(1);
      if (skill) return skill.replace(/[-_]/g, ' ');
      return '';
    }

    function parseGoalTickActivityLines(message) {
      var msg = humanizeTeamActivityMessage(String(message || '')).trim();
      if (!msg) return [];
      var lines = [];
      var initMatch = msg.match(/initiatives created=(\d+)/i);
      if (initMatch && Number(initMatch[1]) > 0) {
        var n = Number(initMatch[1]);
        lines.push('Created ' + n + ' initiative' + (n === 1 ? '' : 's'));
      }
      var mergedMatch = msg.match(/merged=(\d+)/i);
      if (mergedMatch && Number(mergedMatch[1]) > 0 && !initMatch) {
        var m = Number(mergedMatch[1]);
        lines.push('Merged ' + m + ' initiative' + (m === 1 ? '' : 's'));
      }
      var parts = msg.split(/\s*\|\s*/).map(function (part) { return part.trim(); }).filter(Boolean);
      parts.forEach(function (part) {
        if (/^initiatives created=/i.test(part) || /^merged=/i.test(part)) return;
        if (/^New subgoals:/i.test(part)) {
          lines.push(part.replace(/^New subgoals:\s*/i, 'Added tasks: '));
          return;
        }
        if (/^Summary:/i.test(part)) {
          lines.push(part.replace(/^Summary:\s*/i, ''));
          return;
        }
        if (/^Blocked reason:/i.test(part) || /^Needs user input:/i.test(part)) return;
        if (part.length > 6) lines.push(part);
      });
      return lines;
    }

    function isGenericAgentLastTaskLine(line) {
      var s = String(line || '').trim();
      if (!s) return true;
      if (/^none$/i.test(s)) return true;
      if (/^finished the task\b/i.test(s)) return true;
      if (/^handled in \d+ms/i.test(s)) return true;
      if (/^skill \S+ finished in \d+ms/i.test(s)) return true;
      if (/^new task:\s*(request|new request)$/i.test(s)) return true;
      if (/^idle$/i.test(s)) return true;
      if (/^standing by$/i.test(s)) return true;
      if (/^delegating to \S+$/i.test(s)) return true;
      if (/^completed (agent-send|search|memory|browse|go-read)\.?$/i.test(s)) return true;
      if (/^started (agent-send|search|memory|browse|go-read)\.?$/i.test(s)) return true;
      return false;
    }

    function formatAgentLastTaskPlainLine(event) {
      if (!event) return '';
      var type = String(event.type || '');
      var msg = String(event.message || '').trim();
      var title = String(event.title || '').trim();
      var details = event.details && typeof event.details === 'object' ? event.details : {};
      var target = agentNameById(String(event.targetAgentId || ''));

      if (type === 'delegation_task_assigned') {
        var assigned = msg.match(/Assigned "(.+?)" to /i);
        if (assigned) return 'Delegated ' + assigned[1];
        return msg ? humanizeTeamActivityMessage(msg) : 'Delegated task';
      }
      if (type === 'delegation_start' || type === 'delegation_decision') {
        if (msg && !/^(Delegating to|Auto-routed by skills)/i.test(msg)) {
          return humanizeTeamActivityMessage(msg).replace(/\.$/, '');
        }
        return target ? ('Delegated to ' + target) : 'Delegated task';
      }
      if (type === 'delegation_done') return '';
      if (type === 'turn_start') {
        if (!msg || /^new request$/i.test(msg)) return '';
        return humanizeTeamActivityMessage(msg).replace(/^New task:\s*/i, '');
      }
      if (type === 'turn_done') {
        if (/^handled in \d+ms/i.test(msg)) return '';
        return humanizeTeamActivityMessage(msg);
      }
      if (type === 'skill_start' || type === 'skill_done') {
        if (type === 'skill_done' && /^Skill /i.test(msg)) {
          return humanizeAgentSkillLabel(event.skillId, event.action, '');
        }
        return humanizeAgentSkillLabel(event.skillId, event.action, msg);
      }
      if (type === 'goal_tick_done' || type === 'goal_tick_start') {
        return parseGoalTickActivityLines(msg || title).join('\n');
      }
      if (type === 'initiative_scan_done') {
        var created = msg.match(/created=(\d+)/i);
        if (created && Number(created[1]) > 0) {
          var n = Number(created[1]);
          return 'Created ' + n + ' initiative' + (n === 1 ? '' : 's');
        }
      }
      if (type === 'initiative_auto_promoted') {
        var initTitle = title || String(details.title || '').trim();
        return initTitle ? ('Added initiative: ' + initTitle) : 'Added initiative to mission';
      }
      if (type === 'goal_subgoal_created') {
        return title ? ('Added task: ' + title) : humanizeTeamActivityMessage(msg);
      }
      if (type === 'curiosity_momentum_done') {
        return humanizeTeamActivityMessage(msg || title);
      }
      if (msg) return humanizeTeamActivityMessage(msg);
      if (title) return title;
      return '';
    }

    function normalizeAgentLastTaskLine(line) {
      var s = String(line || '').replace(/\s+/g, ' ').trim();
      if (!s) return '';
      s = s.replace(/^New task:\s*/i, '');
      s = s.replace(/^Finished the task\.\s*/i, '');
      s = s.replace(/^Completed\s+/i, function (m) { return m; });
      if (isGenericAgentLastTaskLine(s)) return '';
      return s.slice(0, 120);
    }

    function pushUniqueAgentLastTaskLine(out, line) {
      var normalized = normalizeAgentLastTaskLine(line);
      if (!normalized) return;
      var key = normalized.toLowerCase();
      for (var i = 0; i < out.length; i++) {
        if (out[i].toLowerCase() === key) return;
      }
      out.push(normalized);
    }

    function buildAgentLastTaskSummary(agentId) {
      var aid = String(agentId || '').trim();
      if (!aid) return { lines: ['None'], ts: 0 };
      var events = (teamActivityEvents || []).filter(function (ev) {
        if (!ev) return false;
        return String(ev.agentId || '') === aid;
      });
      if (!events.length) return { lines: ['None'], ts: 0 };

      var groups = groupTeamActivityEvents(events);
      var lines = [];
      var ts = 0;

      if (groups.length) {
        var latest = groups[0];
        ts = Number(latest.ts) || 0;
        (latest.lines || []).forEach(function (htmlLine) {
          pushUniqueAgentLastTaskLine(lines, stripActivityHtml(htmlLine));
        });
      }

      if (!lines.length) {
        var recent = events.slice().sort(function (a, b) { return (Number(b.ts) || 0) - (Number(a.ts) || 0); });
        for (var i = 0; i < recent.length && lines.length < 4; i++) {
          var ev = recent[i];
          ts = Math.max(ts, Number(ev.ts) || 0);
          var formatted = formatAgentLastTaskPlainLine(ev);
          if (formatted.indexOf('\n') >= 0) {
            formatted.split('\n').forEach(function (part) { pushUniqueAgentLastTaskLine(lines, part); });
          } else {
            pushUniqueAgentLastTaskLine(lines, formatted);
          }
        }
      }

      if (!lines.length) return { lines: ['None'], ts: ts };
      return { lines: lines.slice(0, 4), ts: ts };
    }

    window.buildAgentLastTaskSummary = buildAgentLastTaskSummary;

    window.openMissionWorkInputModal = openMissionWorkInputModal;
    window.patchMissionSubgoalStatus = patchMissionSubgoalStatus;
    window.findMissionTaskItem = findMissionTaskItem;
    window.findMissionTaskItemByTitle = findMissionTaskItemByTitle;
    window.findMissionTaskForAgent = findMissionTaskForAgent;
    window.enrichMissionTaskItem = enrichMissionTaskItem;
    window.buildMissionTaskFromTurn = buildMissionTaskFromTurn;
    window.buildMissionTaskTimeline = buildMissionTaskTimeline;
    window.buildMissionTaskSourceChain = buildMissionTaskSourceChain;
    window.buildMissionTaskInactionImpact = buildMissionTaskInactionImpact;
    window.buildStructuredMissionTaskTimeline = buildStructuredMissionTaskTimeline;
    window.formatMissionTaskTimelineLine = formatMissionTaskTimelineLine;
    window.formatStructuredMissionTaskTimelineLine = formatStructuredMissionTaskTimelineLine;
    window.missionTaskDisplayTitle = missionTaskDisplayTitle;
    window.wireMissionTaskActions = wireMissionTaskActions;
    window.missionTaskActionButtonsHtml = missionTaskActionButtonsHtml;
    window.runMissionGoalAction = runMissionGoalAction;
    window.removeMissionTask = removeMissionTask;
    window.openInitiativeForSubgoal = openInitiativeForSubgoal;
    window.goalNeedsAttention = goalNeedsAttention;
    window.countBlockedSubgoalsForGoal = countBlockedSubgoalsForGoal;

    function renderTeamUserInputModal() {
      var modal = document.getElementById('team-user-input-modal');
      var modalOpen = isTeamUserInputModalOpen();
      if (!isTeamMainViewActive()) {
        if (!modalOpen) closeTeamUserInputModal();
        return;
      }
      if (!modal) return;
      var goals = getGoalsNeedingUserInput().filter(function (g) {
        return !teamUserInputDismissed[teamUserInputDismissKey(g)];
      });
      if (modalOpen) {
        if (teamUserInputGoalId) {
          var current = goals.find(function (g) { return String(g.id || '') === teamUserInputGoalId; });
          if (current) return;
        }
        if (!goals.length) return;
        var queued = goals[0];
        if (teamUserInputGoalId === String(queued.id || '')) return;
        openTeamUserInputModal(queued);
        return;
      }
      if (!goals.length) {
        closeTeamUserInputModal();
        return;
      }
      openTeamUserInputModal(goals[0]);
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

    var teamPageRoot = document.getElementById('page-team');
    if (teamPageRoot && !teamPageRoot._blockedWired) {
      teamPageRoot._blockedWired = true;
      teamPageRoot.addEventListener('click', function (e) {
        var badgeBtn = e.target && e.target.closest ? e.target.closest('.team-task-badge-action.blocked') : null;
        var lineBtn = e.target && e.target.closest ? e.target.closest('.team-task-blocked-link') : null;
        if (!badgeBtn && !lineBtn) return;
        if (badgeBtn && badgeBtn.disabled) return;
        e.preventDefault();
        if (typeof navigateToBlockedWork === 'function') navigateToBlockedWork();
      });
    }

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
    var mc2InitiativesRefreshEl = document.getElementById('mc2-initiatives-refresh');
    if (mc2InitiativesRefreshEl) {
      mc2InitiativesRefreshEl.addEventListener('click', function () { fetchInitiativesSnapshot(); });
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
      closeTeamUserInputModal();
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
