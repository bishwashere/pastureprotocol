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
        renderMissionsOwnerOptions();
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
        renderMissionsOwnerOptions();
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
      roster: 'Browse your agent team — click a card for Active Context, Inbox, Outbox, or Stats; use ⋮ on a card to edit, or switch to Tree for hierarchy.',
      missions: 'Long-running missions your agents work on autonomously — create missions, track tasks, and run or pause work.',
    };

    function isMissionPartialWait(mission) {
      var w = mission && mission.waitCondition;
      if (!w || typeof w !== 'object') return false;
      return String(w.kind || '').toLowerCase() === 'partial';
    }

    function missionImplementationBlockedLabel(mission) {
      if (!mission) return '';
      var w = mission.waitCondition;
      var reason = String((w && (w.reason || w.condition)) || mission.blockedReason || '').trim();
      if (isMissionPartialWait(mission)) {
        var appliesTo = (w && (w.waitAppliesTo || w.scope)) || 'implementation';
        return reason || ('Implementation blocked (' + appliesTo + ') — research continues');
      }
      return reason;
    }

    function formatMissionImplementationAttention(mission) {
      var title = escapeHtml(String(mission.title || mission.objective || 'Mission').slice(0, 48));
      var ask = String(mission.needsUserInput || '').trim();
      var reason = missionImplementationBlockedLabel(mission);
      var text = title + ': Implementation blocked — research continues';
      if (reason && reason !== 'Implementation blocked — research continues') {
        text += ' (' + escapeHtml(reason.slice(0, 56)) + ')';
      }
      if (ask) text += ' · ' + escapeHtml(ask.slice(0, 72));
      return text;
    }

    function setTeamTopTab(tab) {
      teamTopTab = tab === 'missions' ? 'missions' : 'roster';
      var rosterTab = document.getElementById('team-top-tab-roster');
      var missionsTab = document.getElementById('team-top-tab-missions');
      var tabDesc = document.getElementById('team-top-tab-desc');
      var rosterView = document.getElementById('team-roster-view');
      var missionsView = document.getElementById('team-missions-view');
      if (tabDesc) tabDesc.textContent = TEAM_TOP_TAB_DESC[teamTopTab] || TEAM_TOP_TAB_DESC.roster;
      if (rosterTab) {
        rosterTab.classList.toggle('active', teamTopTab === 'roster');
        rosterTab.setAttribute('aria-selected', teamTopTab === 'roster' ? 'true' : 'false');
      }
      if (missionsTab) {
        missionsTab.classList.toggle('active', teamTopTab === 'missions');
        missionsTab.setAttribute('aria-selected', teamTopTab === 'missions' ? 'true' : 'false');
      }
      if (rosterView) rosterView.hidden = teamTopTab !== 'roster';
      if (missionsView) missionsView.hidden = teamTopTab !== 'missions';
      if (teamTopTab === 'missions' && (!teamMissionsSnapshot.missions || !teamMissionsSnapshot.missions.length)) {
        fetchMissionsSnapshot();
      }
      if (typeof renderTeamUserInputModal === 'function') renderTeamUserInputModal();
    }

    function formatMissionTs(ts) {
      var n = Number(ts);
      if (!isFinite(n) || n <= 0) return 'never';
      return new Date(n).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function missionOwnerLabel(mission) {
      return agentNameById(mission && mission.ownerAgentId ? mission.ownerAgentId : 'main');
    }

    function activeMissionLabelForAgent(agentId) {
      var missions = Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : [];
      var owned = missions.filter(function (g) {
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

    var EPHEMERAL_MISSION_LABELS = {
      'Answer user question': 1,
      'Handle delegated task': 1,
      'Improve onboarding conversion': 1,
      'Analyze product metrics': 1,
      'Fix nginx issue': 1,
      'Fix technical issue': 1,
      'Generate marketing ideas': 1,
    };

    function isEphemeralMissionLabel(label) {
      var g = String(label || '').trim();
      return !g || !!EPHEMERAL_MISSION_LABELS[g];
    }

    function missionLabelForAgent(agentId, ctx) {
      var row = ctx || {};
      var state = String(row.state || 'idle').toLowerCase();
      var stored = String(row.currentMission || '').trim();
      if (state === 'idle') {
        return activeMissionLabelForAgent(agentId) || '';
      }
      if (stored && !isEphemeralMissionLabel(stored)) return stored;
      var fromMissions = activeMissionLabelForAgent(agentId);
      return fromMissions || stored || '';
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
      var missionLabel = missionLabelForAgent(agentId, ctx);
      var thought = String(ctx.currentThought || ctx.currentStep || '').trim();
      var waitingFor = String(ctx.waitingFor || '').trim();
      var lastAction = String(ctx.lastAction || '').trim();
      if (!missionLabel && !thought && !waitingFor && !lastAction) return null;
      if (!missionLabel && thought) missionLabel = thought.length > 120 ? thought.slice(0, 119) + '…' : thought;
      if (!missionLabel) missionLabel = 'Active team work';
      var tasks = [];
      if (thought) tasks.push({ title: thought, status: 'doing' });
      if (waitingFor) {
        tasks.push({
          title: 'Waiting on ' + agentNameById(waitingFor),
          status: 'todo',
        });
      }
      if (lastAction) tasks.push({ title: lastAction, status: 'done' });
      return {
        live: true,
        title: missionLabel,
        objective: thought,
        ownerAgentId: agentId,
        progressLabel: 'In progress',
        tasks: tasks,
      };
    }

    function getCurrentMissionMission() {
      var missions = Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions.slice() : [];
      if (!missions.length) return null;
      var isActive = function (g) {
        return String(g && g.status || 'active').toLowerCase() === 'active';
      };
      if (selectedTeamMissionId) {
        var selected = missions.find(function (g) { return String(g.id || '') === selectedTeamMissionId; });
        if (selected && isActive(selected)) return selected;
      }
      var running = missions.find(function (g) { return !!g.running && isActive(g); });
      if (running) return running;
      var active = missions.filter(isActive);
      active.sort(function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); });
      if (active.length) return active[0];
      if (selectedTeamMissionId) {
        var anySelected = missions.find(function (g) { return String(g.id || '') === selectedTeamMissionId; });
        if (anySelected) return anySelected;
      }
      missions.sort(function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); });
      return missions[0] || null;
    }

    function teamHasSavedMissions() {
      return Array.isArray(teamMissionsSnapshot.missions) && teamMissionsSnapshot.missions.length > 0;
    }

    function getCurrentMission() {
      var stored = getCurrentMissionMission();
      if (stored) return { kind: 'stored', mission: stored };
      var live = getLiveMissionFromTeamContext();
      if (live) return { kind: 'live', mission: live, noSavedMission: !teamHasSavedMissions() };
      return null;
    }

    function missionTaskIcon(status) {
      var s = normalizeTaskStatus(status);
      if (s === 'done') return '✓';
      if (s === 'doing') return '→';
      if (s === 'blocked') return '⊘';
      return '○';
    }

    function missionTaskClass(status) {
      var s = normalizeTaskStatus(status);
      if (s === 'done') return 'mission-done';
      if (s === 'doing') return 'mission-doing';
      if (s === 'blocked') return 'mission-blocked';
      return 'mission-todo';
    }

    var BLOCKER_TYPE_PREFIX_MAP = {
      need_direction: 'Need direction',
      need_access: 'Need access',
      need_content: 'Need content',
      need_approval: 'Need approval',
      system_error: 'System error',
    };

    function inferBlockerTypeFromText(title, description) {
      var hay = (String(title || '') + ' ' + String(description || '')).toLowerCase();
      if (/\b(rate.?limit|quota|llm.?limit|daily.?limit|resets at|try again in|api.?limit|request.?limit|enoent|spawn|segfault|binary|not installed|runtime.?broken|cannot find module|playwright|chromium)\b/.test(hay)) {
        return 'system_error';
      }
      if (/\b(access|credential|api.?key|token|oauth|secret|password|uri|url|database|warehouse|crm|analytics|billing|stripe|hubspot|salesforce|posthog|ga4|mixpanel|shopify|export|share.*data|read.?only|permission)\b/.test(hay)) {
        return 'need_access';
      }
      if (/\b(provide|supply|upload|send.*file|brand|logo|copy|asset|content|archive|feedback|transcript|recording|export|notes|interview|survey|media)\b/.test(hay)) {
        return 'need_content';
      }
      if (/\b(approve|approval|review|sign.?off|confirm.*plan|confirm.*draft|verify.*draft|proceed after|before.*launch)\b/.test(hay)) {
        return 'need_approval';
      }
      return 'need_direction';
    }

    function resolveBlockerTypeForTask(task) {
      var bt = String(task && task.blockerType || '').toLowerCase().trim();
      if (BLOCKER_TYPE_PREFIX_MAP[bt]) return bt;
      return inferBlockerTypeFromText(
        task && task.title,
        (task && task.description) || (task && task.expectedOutput) || ''
      );
    }

    function blockerTypeLabel(task) {
      var bt = resolveBlockerTypeForTask(task);
      return BLOCKER_TYPE_PREFIX_MAP[bt] || 'Need direction';
    }

    function isSystemErrorTask(task) {
      return resolveBlockerTypeForTask(task) === 'system_error';
    }

    function dashboardTaskBlockedByWait(task, waitCondition) {
      if (!task || !isMissionPartialWait({ waitCondition: waitCondition })) return false;
      var w = waitCondition || {};
      var blockedIds = Array.isArray(w.blockedTaskIds) ? w.blockedTaskIds : (
        Array.isArray(w.appliesToTaskIds) ? w.appliesToTaskIds : []
      );
      var sgId = String(task.id || '').trim();
      if (sgId && blockedIds.some(function (id) { return String(id || '').trim() === sgId; })) return true;
      var appliesTo = String(w.waitAppliesTo || w.scope || 'implementation').toLowerCase();
      var hay = (sgId + ' ' + String(task.title || '') + ' ' + String(task.description || '')).toLowerCase();
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

    function walkMissionTasksForBlocked(tasks, missionId, mission, out) {
      var refs = out || [];
      (tasks || []).forEach(function (sg) {
        if (!sg || typeof sg !== 'object') return;
        var sgId = String(sg.id || '').trim();
        var title = String(sg.title || '').trim();
        var status = normalizeTaskStatus(sg.status);
        // Only surface tasks that are genuinely blocked (need user input or error).
        // wait-dependency tasks are open work; they are not user-action required.
        if (status === 'blocked') {
          refs.push({ kind: 'task', missionId: missionId, taskId: sgId, title: title });
        }
        walkMissionTasksForBlocked(sg.tasks, missionId, mission, refs);
      });
      return refs;
    }

    function findBlockedWorkRefs() {
      var refs = [];
      var agents = teamAgentContextSnapshot.agents || {};
      Object.keys(agents).forEach(function (id) {
        var ctx = agents[id] || {};
        if (String(ctx.state || 'idle').toLowerCase() === 'error') {
          refs.push({ kind: 'agent', missionId: '', taskId: '', agentId: id });
        }
      });
      (Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : []).forEach(function (g) {
        var missionId = String(g.id || '').trim();
        if (!missionId) return;
        if (String(g.status || '').toLowerCase() === 'blocked') {
          refs.push({ kind: 'mission', missionId: missionId, taskId: '', agentId: '' });
        } else if (isMissionPartialWait(g) || String(g.needsUserInput || '').trim()) {
          refs.push({ kind: 'mission', missionId: missionId, taskId: '', agentId: '', partial: true });
        }
        walkMissionTasksForBlocked(g.tasks, missionId, g, refs);
      });
      return refs;
    }

    function findFirstBlockedWorkRef() {
      var refs = findBlockedWorkRefs();
      var i;
      for (i = 0; i < refs.length; i++) {
        if (refs[i].kind === 'task') return refs[i];
      }
      for (i = 0; i < refs.length; i++) {
        if (refs[i].kind === 'mission') return refs[i];
      }
      return refs[0] || null;
    }

    function effectiveTaskStatus(task, mission) {
      var status = normalizeTaskStatus(task && task.status);
      if (status === 'done') return 'done';
      if (status === 'blocked') return 'blocked';
      // wait-conditioned tasks are dependencies, not user-input blockers — keep them as todo/open.
      return status;
    }

    function mc2LooksLikeProjectMetaTaskText(text) {
      var normalized = String(text || '').toLowerCase()
        .replace(/[^a-z0-9\s_-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (!normalized) return false;
      if (!/\b(tasks?|todos?|items?|goals?|missions?|initiatives?|logs?|history|updates?|counts?|duplicates?)\b/.test(normalized)) return false;
      if (/\b(create|draft|write|build|implement|investigate|audit|research|review|prepare|design|ship|fix|analyze|plan|improve|increase|launch|instrument|validate)\b/.test(normalized) &&
        !/\b(remove|dedupe|de-duplicate|clean up)\b.*\bduplicates?\b/.test(normalized)) {
        return false;
      }
      return /\b(how many|count|total|list|show|which|what are|what is|status|done|pending|open|to do|todo)\b/.test(normalized) ||
        /\b(you said|you re saying|are you saying|which one is correct|correct|wrong|is that right)\b/.test(normalized) ||
        /\b(remove|dedupe|de-duplicate|clean up)\b.*\bduplicates?\b/.test(normalized);
    }

    function mc2IsChatDerivedDelegatedTask(task) {
      if (!task || String(task.source || '').trim() !== 'delegation') return false;
      return mc2LooksLikeProjectMetaTaskText(task.description) ||
        mc2LooksLikeProjectMetaTaskText(task.expectedOutput) ||
        mc2LooksLikeProjectMetaTaskText(task.title);
    }

    function flattenMissionWorkItems() {
      var items = [];
      (Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : []).forEach(function (g) {
        var missionTitle = String(g.title || g.objective || 'Untitled mission').trim();
        var missionId = String(g.id || '').trim();
        if (!missionId) return;
        var missionStatus = String(g.status || 'active').toLowerCase();
        if (missionStatus === 'blocked') {
          items.push({
            kind: 'mission',
            status: 'blocked',
            title: missionTitle,
            missionTitle: missionTitle,
            missionId: missionId,
            taskId: '',
            path: missionTitle,
            assignee: String(g.ownerAgentId || '').trim(),
            progress: normalizeTaskProgress(g.progress && g.progress.pct),
            description: String(g.blockedReason || g.objective || '').trim(),
          });
        }
        // Build a set of task IDs that have a delegated successor so we can
        // skip the original when the delegated version already represents the work.
        var delegatedFromIds = {};
        (function collectDelegatedFrom(tasks) {
          (tasks || []).forEach(function (sg) {
            if (!sg || typeof sg !== 'object') return;
            var from = String(sg.delegatedFrom || '').trim();
            if (from) delegatedFromIds[from] = true;
            collectDelegatedFrom(sg.tasks);
          });
        }(g.tasks));

        var missionTitleNorm = missionTitle.trim().toLowerCase();
        function walk(tasks, pathParts) {
          (tasks || []).forEach(function (sg) {
            if (!sg || typeof sg !== 'object') return;
            if (mc2IsChatDerivedDelegatedTask(sg)) return;
            var taskId = String(sg.id || '').trim();
            // Skip the original task when a delegated version already tracks this work.
            if (taskId && delegatedFromIds[taskId]) return;
            var title = String(sg.title || '').trim() || 'Untitled task';
            // Skip tasks whose title matches the mission title — they duplicate the mission itself.
            if (title.toLowerCase() === missionTitleNorm) return;
            var parts = pathParts.concat(title);
            var status = effectiveTaskStatus(sg, g);
            items.push({
              kind: 'task',
              status: status,
              title: title,
              missionTitle: missionTitle,
              missionId: missionId,
              missionObjective: String(g.objective || '').trim(),
              taskId: taskId,
              slug: String(sg.slug || '').trim(),
              fromSuggestedTask: /^init-/.test(taskId),
              labels: Array.isArray(sg.labels) ? sg.labels.slice() : [],
              path: parts.join(' → '),
              assignee: String(sg.assignee || g.ownerAgentId || '').trim(),
              delegatedFrom: String(sg.delegatedFrom || '').trim(),
              delegatedAt: Number(sg.delegatedAt) || 0,
              source: String(sg.source || '').trim(),
              dueAt: Number(sg.dueAt) || 0,
              progress: normalizeTaskProgress(sg.progress),
              description: String(sg.description || '').trim(),
              expectedOutput: String(sg.expectedOutput || '').trim(),
              blockerType: String(sg.blockerType || '').trim(),
              type: String(sg.type || '').trim(),
              priority: Number(sg.priority) || 0,
              routeReason: String(sg.routeReason || '').trim(),
              reviewNotes: String(sg.reviewNotes || '').trim(),
              dependsOn: Array.isArray(sg.dependsOn) ? sg.dependsOn.slice() : [],
              missionHistory: Array.isArray(g.history) ? g.history.slice(-5) : [],
              missionProgress: g.progress || null,
              missionContextSnapshot: String(g.contextSnapshot || '').trim(),
              updatedAt: Number(sg.updatedAt || g.updatedAt) || 0,
              createdAt: Number(sg.createdAt) || 0,
              startedAt: Number(sg.startedAt) || 0,
              completedAt: Number(sg.completedAt) || 0,
              waitingSince: Number(sg.waitingSince) || 0,
            });
            walk(sg.tasks, parts);
          });
        }
        walk(g.tasks, [missionTitle]);
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
            missionId: '',
            taskId: '',
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
      var groups = { blocked: [], doing: [], todo: [], done: [], waiting: [] };
      (items || []).forEach(function (it) {
        var bucket = groups[it.status] !== undefined ? it.status : 'todo';
        groups[bucket].push(it);
      });
      return groups;
    }

    window.flattenMissionWorkItems = flattenMissionWorkItems;
    window.groupMissionWorkItems = groupMissionWorkItems;
    window.listCanonicalWorkItems = listCanonicalWorkItems;

    function highlightBlockedTarget(el) {
      if (!el || !el.classList) return;
      el.classList.add('team-blocked-highlight');
      setTimeout(function () {
        el.classList.remove('team-blocked-highlight');
      }, 2200);
    }

    function openTaskAncestors(el) {
      var node = el;
      while (node) {
        if (node.tagName === 'DETAILS' && node.classList && node.classList.contains('team-mission-task-node')) {
          node.open = true;
        }
        node = node.parentElement;
      }
    }

    function scrollToFirstBlockedTaskTag() {
      var el = document.querySelector(
        '#mc2-mission-detail .team-mission-task-status.blocked, #team-mission-detail .team-mission-task-status.blocked, ' +
        '#team-current-mission .team-mission-task-status.blocked, #team-current-mission li.mission-blocked'
      );
      if (!el) return false;
      openTaskAncestors(el);
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch (_) {}
      highlightBlockedTarget(el.classList && el.classList.contains('team-mission-task-status') ? el : (el.closest('[data-task-id]') || el));
      return true;
    }

    function scrollToBlockedTaskMarker(taskId, title) {
      var id = String(taskId || '').trim();
      var el = null;
      if (id) {
        el = document.querySelector('[data-task-id="' + id + '"] .team-mission-task-status.blocked') ||
          document.querySelector('[data-mission-task-id="' + id + '"]');
      }
      if (!el && title) {
        var rows = document.querySelectorAll('.team-mission-task-row[data-task-id]');
        for (var i = 0; i < rows.length; i++) {
          var rowTitle = rows[i].querySelector('.team-mission-task-title');
          if (rowTitle && String(rowTitle.textContent || '').trim() === String(title).trim()) {
            el = rows[i].querySelector('.team-mission-task-status.blocked') || rows[i];
            break;
          }
        }
      }
      if (!el) return false;
      openTaskAncestors(el);
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch (_) {}
      highlightBlockedTarget(el.classList && el.classList.contains('team-mission-task-status') ? el : (el.closest('[data-task-id]') || el));
      return true;
    }

    function scheduleScrollToBlockedTarget(ref, attempt) {
      var tries = Number(attempt) || 0;
      var hit = false;
      if (ref && ref.kind === 'task') {
        hit = scrollToBlockedTaskMarker(ref.taskId, ref.title) || scrollToFirstBlockedTaskTag();
      } else if (ref && ref.kind === 'mission') {
        var missionStatus = document.querySelector('#team-mission-detail .team-mission-status.blocked, #mc2-mission-detail .team-mission-status.blocked');
        if (missionStatus) {
          try { missionStatus.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' }); } catch (_) {}
          highlightBlockedTarget(missionStatus);
          hit = true;
        } else {
          hit = scrollToFirstBlockedTaskTag();
        }
      } else {
        hit = scrollToFirstBlockedTaskTag();
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
        var missionId = String(ref.missionId || '').trim();
        if (missionId) {
          var item = typeof findMissionTaskItem === 'function'
            ? findMissionTaskItem({
              missionId: missionId,
              taskId: ref.taskId,
              title: ref.title,
              agentId: ref.agentId,
            })
            : null;
          mc2OpenTaskDetail(item, {
            missionId: missionId,
            taskId: ref.taskId,
            filter: ref.kind === 'task' ? 'blocked' : 'all',
          });
          return true;
        }
      }
      if (typeof mc2OpenTasksView === 'function') {
        mc2OpenTasksView('blocked');
        return true;
      }
      var mission = typeof getCurrentMissionMission === 'function' ? getCurrentMissionMission() : null;
      if (ref.kind === 'task' && mission && String(mission.id || '') === String(ref.missionId || '')) {
        renderCurrentMission();
        if (scrollToBlockedTaskMarker(ref.taskId, ref.title)) return true;
      }
      selectedTeamMissionId = String(ref.missionId || '');
      if (typeof mc2SetView === 'function') {
        mc2SetView('tasks');
        if (typeof mc2RenderTasks === 'function') mc2RenderTasks();
        return true;
      } else if (typeof setTeamTopTab === 'function') {
        setTeamTopTab('missions');
        renderMissionsList();
        scheduleScrollToBlockedTarget(ref, 0);
      }
      return true;
    }

    function ensureMissionControlPage() {
      var mcPage = document.getElementById('page-team');
      if (mcPage && mcPage.classList.contains('active')) return true;
      var route = (location.pathname || '/').replace(/^\//, '').split('/')[0];
      if (route === 'team' || route === 'agents') return true;
      history.pushState(null, '', '/team');
      if (typeof dashboardRouteFromPath === 'function') dashboardRouteFromPath();
      else if (typeof dashboardRouteFromHash === 'function') dashboardRouteFromHash();
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
        setTeamTopTab('missions');
        renderMissionsList();
        scheduleScrollToBlockedTarget(null, 0);
        return true;
      }
      return false;
    }

    window.navigateToBlockedWork = navigateToBlockedWork;

    function flattenMissionTasks(tasks, out, depth) {
      var list = Array.isArray(tasks) ? tasks : [];
      var acc = out || [];
      var level = Number(depth) || 0;
      if (level > 4 || acc.length >= 12) return acc;
      list.forEach(function (sg) {
        if (!sg || typeof sg !== 'object' || acc.length >= 12) return;
        acc.push(sg);
        flattenMissionTasks(sg.tasks, acc, level + 1);
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
      var mission = current.kind === 'live' ? current.mission : current.mission;
      var liveOnly = current.kind === 'live' && !!current.noSavedMission;
      var missionLabel = String(mission.title || '').trim() || String(mission.objective || '').trim() || 'Untitled mission';
      var progressText = mission.progressLabel
        ? String(mission.progressLabel)
        : (normalizeTaskProgress(mission.progress && mission.progress.pct) + '%');
      var owner = missionOwnerLabel(mission);
      var tasks = current.kind === 'live'
        ? (Array.isArray(mission.tasks) ? mission.tasks : [])
        : flattenMissionTasks(Array.isArray(mission.tasks) ? mission.tasks : [], [], 0);
      var tasksHtml = tasks.length
        ? '<ul class="team-current-mission-task-list">' + tasks.map(function (sg) {
          var title = String(sg.title || '').trim() || 'Untitled task';
          var status = normalizeTaskStatus(sg.status);
          var icon = missionTaskIcon(status);
          var cls = missionTaskClass(status);
          var sgId = String(sg.id || '').trim();
          var statusTag = (status === 'blocked' && !isSystemErrorTask(sg))
            ? ' <span class="team-mission-task-status blocked">' + escapeHtml(blockerTypeLabel(sg)) + '</span>'
            : '';
          return '<li class="' + cls + '" data-mission-task-id="' + escapeHtml(sgId) + '" title="' + escapeHtml(title) + '">' +
            '<span class="team-current-mission-task-text">' + escapeHtml(icon + ' ' + title) + '</span>' + statusTag + '</li>';
        }).join('') + '</ul>'
        : '<p class="team-current-mission-empty" style="margin:0;">No tasks yet.</p>';
      var missionHeading = liveOnly ? 'Activity' : 'Mission';
      var noteHtml = liveOnly
        ? '<p class="team-current-mission-empty" style="margin:0.35rem 0 0;">No saved mission yet — this is live agent context from chat. Create a mission to track objectives and tasks.</p>'
        : '';
      panel.innerHTML = '' +
        '<h3 class="team-current-mission-title">Current Mission</h3>' +
        (liveOnly ? '<p class="team-current-mission-meta" style="margin:0 0 0.35rem;"><em>Live work (not a saved mission)</em></p>' : '') +
        '<p class="team-current-mission-meta"><strong>' + missionHeading + ':</strong> ' + escapeHtml(missionLabel) + '</p>' +
        '<p class="team-current-mission-meta"><strong>Progress:</strong> ' + escapeHtml(progressText) + '</p>' +
        '<p class="team-current-mission-meta"><strong>Owner:</strong> ' + escapeHtml(owner) + '</p>' +
        '<div class="team-current-mission-tasks">' +
          '<h4>' + (liveOnly ? 'Steps' : 'Tasks') + '</h4>' +
          tasksHtml +
        '</div>' +
        noteHtml;
    }

    function collectTasksByStatus(tasks, acc) {
      var out = acc || { todo: [], doing: [], blocked: [] };
      (tasks || []).forEach(function (sg) {
        if (!sg || typeof sg !== 'object') return;
        var title = String(sg.title || '').trim();
        var status = normalizeTaskStatus(sg.status);
        if (title) {
          if (status === 'todo') out.todo.push(title);
          else if (status === 'doing') out.doing.push(title);
          else if (status === 'blocked') out.blocked.push(title);
        }
        collectTasksByStatus(sg.tasks, out);
      });
      return out;
    }

    function countCompletedTasksToday() {
      return listCanonicalWorkItems({ range: 'today', status: 'done' }).length;
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

    function listCanonicalWorkItems(opts) {
      opts = opts || {};
      var range = String(opts.range || teamAgentPanelRange || 'today').trim();
      var agentFilter = String(opts.agentId || '').trim();
      var statusFilter = String(opts.status || '').trim().toLowerCase();
      var includeTurns = opts.includeTurns === true;
      var items = typeof flattenMissionWorkItems === 'function' ? flattenMissionWorkItems() : [];
      items = items.map(function (it) {
        return Object.assign({ sourceKind: it.kind || 'task' }, it);
      });

      if (includeTurns) {
        var doneMissionTitles = {};
        items.forEach(function (it) {
          if (String(it.status || '').toLowerCase() !== 'done') return;
          var title = String(it.title || '').trim().toLowerCase();
          if (title) doneMissionTitles[title] = true;
        });

        listCompletedTasks({ range: range, agentId: agentFilter }).forEach(function (task) {
          var title = missionTaskDisplayTitle(task);
          if (doneMissionTitles[String(title || '').trim().toLowerCase()]) return;
          items.push({
            kind: 'turn',
            sourceKind: 'turn',
            status: 'done',
            title: title,
            path: title,
            assignee: String(task.agentId || '').trim(),
            agentId: String(task.agentId || '').trim(),
            completedAt: Number(task.ts) || 0,
            updatedAt: Number(task.ts) || 0,
            createdAt: Number(task.ts) || 0,
            turnTs: Number(task.ts) || 0,
            prompt: String(task.prompt || ''),
            summary: String(task.summary || ''),
            skillCount: Number(task.skillCount) || 0,
          });
        });
      }

      if (agentFilter) {
        items = items.filter(function (it) {
          return String(it.assignee || it.agentId || '').trim() === agentFilter;
        });
      }
      if (statusFilter) {
        items = items.filter(function (it) {
          return String(it.status || '').toLowerCase() === statusFilter;
        });
      }
      return items.sort(function (a, b) {
        var bt = Number(b.updatedAt || b.completedAt || b.delegatedAt || 0);
        var at = Number(a.updatedAt || a.completedAt || a.delegatedAt || 0);
        return bt - at;
      });
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

      var tasks = { todo: [], doing: [], blocked: [] };
      var blockedReasons = [];
      var implementationBlockedLabels = [];
      (Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : []).forEach(function (g) {
        var status = String(g.status || '').toLowerCase();
        if (status === 'blocked') {
          blocked++;
          var reason = String(g.blockedReason || g.title || g.objective || '').trim();
          if (reason) blockedReasons.push(reason);
        } else if (isMissionPartialWait(g) || String(g.needsUserInput || '').trim()) {
          implementationBlockedLabels.push(missionImplementationBlockedLabel(g) || String(g.needsUserInput || '').trim());
        }
        collectTasksByStatus(g.tasks, tasks);
      });
      blocked += tasks.blocked.length;

      var blockedLabel = '';
      if (tasks.blocked.length) blockedLabel = tasks.blocked[0];
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
        else blockedLabel = String(w.currentThought || w.currentStep || w.currentMission || '').trim();
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
        var attentionText = '';
        if (typeof missionAttentionPrompt === 'function') {
          var _missions = Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : [];
          for (var _mi = 0; _mi < _missions.length; _mi++) {
            var _prompt = missionAttentionPrompt(_missions[_mi]);
            if (_prompt) { attentionText = _prompt.split('\n')[0]; break; }
          }
        }
        var displayLabel = attentionText || summary.blockedLabel;
        blockedEl.innerHTML = '<button type="button" class="team-task-blocked-link">' +
          escapeHtml(displayLabel) + '</button>';
        blockedEl.classList.remove('empty');
      } else {
        blockedEl.innerHTML = '<strong>Blocked:</strong> <span class="empty">None</span>';
        blockedEl.classList.add('empty');
      }
    }

    function normalizeTaskStatus(status) {
      var s = String(status || '').toLowerCase();
      if (s === 'done' || s === 'doing' || s === 'blocked' || s === 'todo') return s;
      // waiting_user means the task requires user action — surface as blocked.
      if (s === 'waiting_user') return 'blocked';
      // system errors are not user-actionable — treat as stalled, not blocked.
      if (s === 'error') return 'error';
      // review_ready / in_progress are active agent work — treat as doing.
      if (s === 'review_ready' || s === 'in_progress') return 'doing';
      // waiting_dependency tasks are paused on internal deps, not open work.
      if (s === 'waiting_dependency') return 'waiting';
      // Everything else (open, assigned, etc.) is open/todo work.
      return 'todo';
    }

    function normalizeTaskProgress(value) {
      var n = Number(value);
      if (!isFinite(n)) return 0;
      return Math.max(0, Math.min(100, Math.round(n)));
    }

    function countMissionTasks(tasks) {
      if (!Array.isArray(tasks) || !tasks.length) return 0;
      var total = 0;
      tasks.forEach(function (sg) {
        total += 1 + countMissionTasks(sg && sg.tasks);
      });
      return total;
    }

    function indexMissionTasks(tasks, out) {
      if (!Array.isArray(tasks)) return out;
      var index = out || {};
      tasks.forEach(function (sg) {
        if (!sg || typeof sg !== 'object') return;
        var id = String(sg.id || '').trim();
        if (id) index[id] = sg;
        indexMissionTasks(sg.tasks, index);
      });
      return index;
    }

    function suggestedTaskIdFromTaskId(taskId) {
      var m = String(taskId || '').match(/^init-(.+)$/);
      return m ? m[1] : '';
    }

    function findSuggestedTaskForTaskId(taskId) {
      var initId = suggestedTaskIdFromTaskId(taskId);
      if (!initId) return null;
      return (Array.isArray(teamSuggestedTasksSnapshot.suggestedTasks) ? teamSuggestedTasksSnapshot.suggestedTasks : []).find(function (it) {
        return String(it.id || '') === initId;
      }) || null;
    }

    function openSuggestedTaskForTask(taskId) {
      var sid = String(taskId || '').trim();
      if (!sid) return false;
      if (typeof mc2OpenTaskDetail === 'function' && typeof findMissionTaskItem === 'function') {
        var item = findMissionTaskItem({ taskId: sid });
        if (item) {
          mc2OpenTaskDetail(item, { filter: 'all' });
          return true;
        }
      }
      var initId = suggestedTaskIdFromTaskId(sid);
      if (!initId) return false;
      if (typeof mc2OpenTaskForSuggestedTask === 'function') {
        mc2OpenTaskForSuggestedTask(initId);
        return true;
      }
      selectedTeamSuggestedTaskId = initId;
      if (typeof mc2SetView === 'function') mc2SetView('suggestedTasks');
      if (typeof renderSuggestedTasksPanels === 'function') renderSuggestedTasksPanels();
      return true;
    }

    function missionTaskActionButtonsHtml(missionId, taskId, status, opts) {
      opts = opts || {};
      var gid = String(missionId || '').trim();
      var sid = String(taskId || '').trim();
      if (!gid || !sid) return '';
      var st = normalizeTaskStatus(status);
      var fromInit = !!opts.fromSuggestedTask || /^init-/.test(sid);
      var btnClass = opts.compact ? 'team-mission-task-btn secondary' : 'mc-task-card-btn';
      var primaryClass = opts.compact ? 'team-mission-task-btn secondary' : 'mc-task-card-btn primary';
      var parts = [];
      function btn(action, label, primary) {
        return '<button type="button" class="' + (primary ? primaryClass : btnClass) + '" data-mc-task-action="' + escapeHtml(action) + '"' +
          ' data-mission-id="' + escapeHtml(gid) + '" data-task-id="' + escapeHtml(sid) + '">' + escapeHtml(label) + '</button>';
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
      if (fromInit) parts.push(btn('review-suggestedTask', 'Review suggestedTask', false));
      if (!opts.inDetailPanel) parts.push(btn('in-mission', 'Mission tree', false));
      var wrapClass = opts.compact ? 'team-mission-task-actions' : 'mc-task-card-actions';
      return '<div class="' + wrapClass + '">' + parts.join('') + '</div>';
    }

    async function removeMissionTask(missionId, taskId) {
      var gid = String(missionId || '').trim();
      var sid = String(taskId || '').trim();
      if (!gid || !sid) return false;
      if (!window.confirm('Remove this task from the mission? Agents will stop tracking it here.')) return false;
      var suggestedTask = findSuggestedTaskForTaskId(sid);
      if (suggestedTask) return undoSuggestedTaskPromotion(suggestedTask);
      var mission = (Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : []).find(function (g) {
        return String(g.id || '') === gid;
      });
      if (!mission) return false;
      try {
        var r = await fetch(API + '/api/missions/' + encodeURIComponent(gid), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tasks: removeTaskFromTree(mission.tasks, sid) }),
        });
        if (!r.ok) return false;
        await fetchMissionsSnapshot();
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
          var missionId = btn.getAttribute('data-mission-id');
          var taskId = btn.getAttribute('data-task-id');
          var card = btn.closest('.mc-mission-task-card');
          var item = card && typeof mc2MissionTaskItemFromEl === 'function'
            ? mc2MissionTaskItemFromEl(card)
            : {
              kind: 'task',
              missionId: missionId,
              taskId: taskId,
              title: card ? card.getAttribute('data-title') : '',
              status: card ? card.getAttribute('data-status') : 'todo',
            };
          if (action === 'respond') {
            var inDetailPopup = !!(btn.closest && btn.closest('#mc2-task-drawer-body'));
            if (!inDetailPopup && card && typeof mc2ShowMissionTaskDetails === 'function') {
              mc2ShowMissionTaskDetails(card);
              return;
            }
            if (typeof openMissionWorkInputModal === 'function') openMissionWorkInputModal(item);
            return;
          }
          if (action === 'unblock' || action === 'mark-open') {
            if (typeof patchMissionTaskStatus === 'function') {
              patchMissionTaskStatus(missionId, taskId, 'todo');
            }
            return;
          }
          if (action === 'mark-done') {
            if (typeof patchMissionTaskStatus === 'function') {
              patchMissionTaskStatus(missionId, taskId, 'done');
            }
            return;
          }
          if (action === 'remove') {
            removeMissionTask(missionId, taskId);
            return;
          }
          if (action === 'review-suggestedTask') {
            openSuggestedTaskForTask(taskId);
            return;
          }
          if ((action === 'in-mission' || action === 'details') && card && typeof mc2ShowMissionTaskDetails === 'function') {
            mc2ShowMissionTaskDetails(card);
          } else if ((action === 'in-mission' || action === 'details') && missionId && typeof mc2OpenTaskDetail === 'function') {
            mc2OpenTaskDetail(null, { missionId: missionId, taskId: taskId, filter: 'all' });
          } else if ((action === 'in-mission' || action === 'details') && missionId) {
            selectedTeamMissionId = missionId;
            if (typeof mc2SetView === 'function') mc2SetView('missions');
            if (typeof mc2RenderMissions === 'function') {
              Promise.resolve(mc2RenderMissions()).then(function () {
                if (taskId && typeof scheduleScrollToBlockedTarget === 'function') {
                  scheduleScrollToBlockedTarget({
                    kind: 'task',
                    missionId: missionId,
                    taskId: taskId,
                    title: '',
                  }, 0);
                }
              });
            }
          }
        });
      });
    }

    async function runMissionMissionAction(missionId, action) {
      var gid = String(missionId || '').trim();
      if (!gid) return;
      var mission = (Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : []).find(function (g) {
        return String(g.id || '') === gid;
      });
      if (!mission) return;
      if (action === 'run') {
        try {
          await fetch(API + '/api/missions/' + encodeURIComponent(gid) + '/run', { method: 'POST' });
        } catch (_) {}
        fetchMissionsSnapshot();
        return;
      }
      if (action === 'toggle') {
        var status = String(mission.status || 'active').toLowerCase();
        var nextStatus = status === 'active' ? 'paused' : 'active';
        try {
          await fetch(API + '/api/missions/' + encodeURIComponent(gid), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: nextStatus }),
          });
        } catch (_) {}
        fetchMissionsSnapshot();
        return;
      }
      if (action === 'respond' && typeof openTeamUserInputModal === 'function') {
        openTeamUserInputModal(mission, { ask: missionAttentionPrompt(mission) });
      }
    }

    function wireMissionMissionDetailActions(detailEl, mission) {
      if (!detailEl || !mission) return;
      var missionId = String(mission.id || '');
      detailEl.querySelectorAll('[data-mc-mission-action]').forEach(function (btn) {
        if (btn._wiredMissionMission) return;
        btn._wiredMissionMission = true;
        btn.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          runMissionMissionAction(missionId, btn.getAttribute('data-mc-mission-action'));
        });
      });
      wireMissionTaskActions(detailEl);
    }

    function renderMissionTaskTree(tasks, lookup, depth, missionId) {
      var list = Array.isArray(tasks) ? tasks : [];
      if (!list.length) return '';
      var level = Number(depth) || 0;
      var gid = String(missionId || '').trim();
      return list.map(function (sg) {
        if (!sg || typeof sg !== 'object') return '';
        var title = String(sg.title || '').trim() || 'Untitled task';
        var status = normalizeTaskStatus(sg.status);
        var progress = normalizeTaskProgress(sg.progress);
        var assignee = String(sg.assignee || '').trim();
        var deps = Array.isArray(sg.dependsOn) ? sg.dependsOn.slice(0, 8) : [];
        var depsLabel = deps.map(function (depId) {
          var key = String(depId || '').trim();
          var dep = lookup[key];
          return dep && dep.title ? dep.title : key;
        }).filter(Boolean).join(', ');
        var sgKey = String(sg.id || '').trim();
        var children = renderMissionTaskTree(sg.tasks, lookup, level + 1, gid);
        var initBadge = /^init-/.test(sgKey) ? '<span class="team-suggestedTask-auto-badge">From suggestedTask</span> ' : '';
        var actionsHtml = gid && sgKey
          ? missionTaskActionButtonsHtml(gid, sgKey, status, { compact: true, fromSuggestedTask: /^init-/.test(sgKey) })
          : '';
        var blockerBadge = (status === 'blocked' && !isSystemErrorTask(sg))
          ? '<span class="team-mission-blocker-type-badge ' + escapeHtml(resolveBlockerTypeForTask(sg)) + '">' + escapeHtml(blockerTypeLabel(sg) + ':') + '</span> '
          : '';
        var summary = '<span class="team-mission-task-row" data-task-id="' + escapeHtml(sgKey) + '">' +
          initBadge + blockerBadge +
          '<span class="team-mission-task-title">' + escapeHtml(title) + '</span>' +
          '<span class="team-mission-task-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' +
          '<span class="team-mission-task-meta">' + escapeHtml(String(progress)) + '%</span>' +
          (assignee ? '<span class="team-mission-task-meta">assignee: ' + escapeHtml(agentNameById(assignee)) + '</span>' : '') +
          (depsLabel ? '<span class="team-mission-task-meta">depends on: ' + escapeHtml(depsLabel) + '</span>' : '') +
        '</span>' + actionsHtml;
        return '<details class="team-mission-task-node" ' + (level < 1 ? 'open' : '') + '>' +
          '<summary>' + summary + '</summary>' +
          (children || '') +
        '</details>';
      }).join('');
    }

    function renderMissionDetail(mission, detailEl) {
      var detail = detailEl || document.getElementById('team-mission-detail');
      if (!detail) return;
      if (!mission || typeof mission !== 'object') {
        detail.innerHTML = '<p class="team-agent-inbox-empty" style="margin:0;padding:0;">Select a mission to view details and tasks.</p>';
        return;
      }
      var status = String(mission.status || 'active').toLowerCase();
      var pct = normalizeTaskProgress(mission.progress && mission.progress.pct);
      var missionId = String(mission.id || '');
      var tasks = Array.isArray(mission.tasks) ? mission.tasks : [];
      var taskLookup = indexMissionTasks(tasks, {});
      var taskTree = renderMissionTaskTree(tasks, taskLookup, 0, missionId);
      var needsInput = typeof missionNeedsAttention === 'function' ? missionNeedsAttention(mission) : false;
      var toggleLabel = status === 'active' ? 'Pause mission' : (status === 'paused' ? 'Resume mission' : 'Activate mission');
      detail.innerHTML = '' +
        '<h4>' + escapeHtml(mission.title || 'Untitled mission') + ' <span class="team-mission-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span></h4>' +
        '<div class="team-mission-detail-row"><strong>Owner:</strong> ' + escapeHtml(missionOwnerLabel(mission)) + '</div>' +
        '<div class="team-mission-detail-row"><strong>Objective:</strong> ' + escapeHtml(String(mission.objective || '')) + '</div>' +
        '<div class="team-mission-detail-row"><strong>Progress:</strong> ' + escapeHtml(String(pct)) + '%</div>' +
        (mission.lastActivity ? '<div class="team-mission-detail-row"><strong>Latest activity:</strong> ' + escapeHtml(String(mission.lastActivity)) + '</div>' : '') +
        '<div class="team-suggestedTask-actions team-mission-detail-actions">' +
          '<button type="button" class="secondary" data-mc-mission-action="run" data-mission-id="' + escapeHtml(missionId) + '">Run now</button>' +
          '<button type="button" class="secondary" data-mc-mission-action="toggle" data-mission-id="' + escapeHtml(missionId) + '">' + escapeHtml(toggleLabel) + '</button>' +
          (needsInput
            ? '<button type="button" class="secondary" data-mc-mission-action="respond" data-mission-id="' + escapeHtml(missionId) + '">Give input</button>'
            : '') +
        '</div>' +
        '<div class="team-mission-tasks">' +
          '<h5>Tasks — you can change or remove any task below</h5>' +
          (taskTree || '<p class="team-agent-inbox-empty" style="margin:0;padding:0;">No tasks yet.</p>') +
        '</div>';
      wireMissionMissionDetailActions(detail, mission);
    }

    function renderMissionsOwnerOptions() {
      var el = document.getElementById('team-mission-owner');
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

    function renderMissionsList() {
      var wrap = document.getElementById('team-missions-list');
      if (!wrap) return;
      var missions = Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions.slice() : [];
      missions.sort(function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); });
      if (!missions.length) {
        selectedTeamMissionId = '';
        wrap.innerHTML = '<p class="team-agent-inbox-empty" style="margin:0;padding:0.5rem 0;">No missions yet.</p>';
        renderMissionDetail(null);
        renderCurrentMission();
        renderTeamTaskSummary();
        return;
      }
      if (!selectedTeamMissionId || !missions.some(function (g) { return String(g.id || '') === selectedTeamMissionId; })) {
        selectedTeamMissionId = String(missions[0].id || '');
      }
      wrap.innerHTML = missions.map(function (g) {
        var id = String(g.id || '');
        var status = String(g.status || 'active').toLowerCase();
        var pct = Number(g.progress && g.progress.pct);
        if (!isFinite(pct)) pct = 0;
        pct = Math.max(0, Math.min(100, Math.round(pct)));
        var running = !!g.running;
        var selected = id === selectedTeamMissionId ? ' selected' : '';
        var taskCount = countMissionTasks(g.tasks);
        var openSuggestedTasksCount = (Array.isArray(teamSuggestedTasksSnapshot.suggestedTasks) ? teamSuggestedTasksSnapshot.suggestedTasks : []).filter(function (it) {
          var related = Array.isArray(it.relatedMissionIds) ? it.relatedMissionIds : [];
          var status = String(it.status || 'proposed').toLowerCase();
          return related.indexOf(id) >= 0 && status === 'proposed';
        }).length;
        var runningTxt = running ? ('Working: ' + escapeHtml(missionOwnerLabel(g))) : '';
        var last = formatMissionTs(g.lastRunAt);
        var next = formatMissionTs(g.nextRunAt);
        return '<div class="team-mission-card' + selected + '" data-mission-id="' + escapeHtml(id) + '">' +
          '<div class="team-mission-card-head">' +
            '<h4 class="team-mission-card-title">' + escapeHtml(g.title || 'Untitled mission') + '</h4>' +
            '<span class="team-mission-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' +
          '</div>' +
          '<div class="team-mission-meta"><strong>Owner:</strong> ' + escapeHtml(missionOwnerLabel(g)) + '</div>' +
          '<div class="team-mission-meta"><strong>Objective:</strong> ' + escapeHtml(String(g.objective || '').slice(0, 180)) + '</div>' +
          '<div class="team-mission-meta"><strong>Tasks:</strong> ' + escapeHtml(String(taskCount)) + '</div>' +
          '<div class="team-mission-meta"><strong>Proposed Suggested Tasks:</strong> ' + escapeHtml(String(openSuggestedTasksCount)) + '</div>' +
          '<div class="team-mission-progress"><span style="width:' + pct + '%"></span></div>' +
          '<div class="team-mission-meta"><strong>Progress:</strong> ' + pct + '%</div>' +
          '<div class="team-mission-meta"><strong>Last:</strong> ' + escapeHtml(last) + ' <strong>Next:</strong> ' + escapeHtml(next) + '</div>' +
          (runningTxt ? '<div class="team-mission-meta"><strong>' + runningTxt + '</strong></div>' : '') +
          (g.lastActivity ? '<div class="team-mission-meta"><strong>Activity:</strong> ' + escapeHtml(g.lastActivity) + '</div>' : '') +
          '<div class="team-mission-actions">' +
            '<button type="button" class="secondary" data-mission-run="' + escapeHtml(id) + '" style="margin:0;">Run now</button>' +
            '<button type="button" class="secondary" data-mission-toggle="' + escapeHtml(id) + '" style="margin:0;">' + (status === 'active' ? 'Pause' : (status === 'paused' ? 'Resume' : 'Activate')) + '</button>' +
          '</div>' +
        '</div>';
      }).join('');
      renderMissionDetail(missions.find(function (g) { return String(g.id || '') === selectedTeamMissionId; }) || missions[0]);
      renderCurrentMission();
      renderTeamTaskSummary();

      wrap.querySelectorAll('button[data-mission-run]').forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          e.preventDefault();
          e.stopPropagation();
          var id = btn.getAttribute('data-mission-run');
          if (!id) return;
          btn.disabled = true;
          try {
            await fetch(API + '/api/missions/' + encodeURIComponent(id) + '/run', { method: 'POST' });
          } catch (_) {}
          btn.disabled = false;
          fetchMissionsSnapshot();
        });
      });
      wrap.querySelectorAll('button[data-mission-toggle]').forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          e.preventDefault();
          e.stopPropagation();
          var id = btn.getAttribute('data-mission-toggle');
          if (!id) return;
          var mission = missions.find(function (g) { return String(g.id) === id; });
          if (!mission) return;
          var nextStatus = mission.status === 'active' ? 'paused' : 'active';
          btn.disabled = true;
          try {
            await fetch(API + '/api/missions/' + encodeURIComponent(id), {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: nextStatus }),
            });
          } catch (_) {}
          btn.disabled = false;
          fetchMissionsSnapshot();
        });
      });
      wrap.querySelectorAll('.team-mission-card').forEach(function (card) {
        card.addEventListener('click', function () {
          var id = String(card.getAttribute('data-mission-id') || '').trim();
          if (!id) return;
          selectedTeamMissionId = id;
          renderMissionsList();
        });
      });
    }

    function missionTitleForMissionId(missionId) {
      var gid = String(missionId || '').trim();
      if (!gid) return '';
      var mission = (teamMissionsSnapshot.missions || []).find(function (g) { return String(g.id || '') === gid; });
      return mission ? String(mission.title || mission.objective || gid).trim() : gid;
    }

    function humanizeSuggestedTaskActivityLine(line) {
      var s = String(line || '');
      return s.replace(/(?:Auto-promoted|Promoted) to task in (mission-[a-z0-9-]+)/gi, function (_m, gid) {
        var name = missionTitleForMissionId(gid);
        return 'Added to mission: ' + (name || gid);
      });
    }

    function suggestedTaskTaskId(suggestedTask) {
      var id = String(suggestedTask && suggestedTask.id || '').trim();
      return id ? 'init-' + id : '';
    }

    function suggestedTaskActivityLines(suggestedTask) {
      var raw = suggestedTask && suggestedTask.activity;
      if (!raw) return [];
      if (Array.isArray(raw)) return raw.map(function (line) { return String(line || ''); });
      return [String(raw)];
    }

    function suggestedTaskWasAutoPromoted(suggestedTask) {
      return suggestedTaskActivityLines(suggestedTask).some(function (line) {
        return line.indexOf('Auto-promoted to task in ') >= 0;
      });
    }

    function missionTreeHasTaskId(tasks, taskId) {
      var sid = String(taskId || '').trim();
      if (!sid) return false;
      var stack = Array.isArray(tasks) ? tasks.slice() : [];
      while (stack.length) {
        var sg = stack.pop();
        if (!sg || typeof sg !== 'object') continue;
        if (String(sg.id || '') === sid) return true;
        if (Array.isArray(sg.tasks) && sg.tasks.length) stack.push.apply(stack, sg.tasks);
      }
      return false;
    }

    function suggestedTaskPromotedMissionId(suggestedTask) {
      if (!suggestedTask || typeof suggestedTask !== 'object') return '';
      var lines = suggestedTaskActivityLines(suggestedTask);
      var i;
      for (i = 0; i < lines.length; i++) {
        var m = lines[i].match(/(?:Auto-)?[Pp]romoted to task in (mission-[a-z0-9-]+)/i);
        if (m) return m[1];
      }
      var subId = suggestedTaskTaskId(suggestedTask);
      var missions = Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : [];
      for (i = 0; i < missions.length; i++) {
        if (missionTreeHasTaskId(missions[i].tasks, subId)) return String(missions[i].id || '');
      }
      var related = Array.isArray(suggestedTask.relatedMissionIds) ? suggestedTask.relatedMissionIds : [];
      return String(related[0] || '').trim();
    }

    function suggestedTaskIsOnMission(suggestedTask) {
      var subId = suggestedTaskTaskId(suggestedTask);
      if (!subId) return false;
      return (teamMissionsSnapshot.missions || []).some(function (g) {
        return missionTreeHasTaskId(g.tasks, subId);
      });
    }

    function activeMissionsForSuggestedTaskPicker() {
      return (Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : []).filter(function (g) {
        return String(g.status || '').toLowerCase() === 'active';
      });
    }

    function removeTaskFromTree(tasks, taskId) {
      var sid = String(taskId || '').trim();
      var out = [];
      (tasks || []).forEach(function (sg) {
        if (!sg || typeof sg !== 'object') return;
        if (String(sg.id || '') === sid) return;
        var next = Object.assign({}, sg);
        if (Array.isArray(next.tasks) && next.tasks.length) {
          next.tasks = removeTaskFromTree(next.tasks, sid);
        }
        out.push(next);
      });
      return out;
    }

    async function undoSuggestedTaskPromotion(suggestedTask) {
      if (!suggestedTask || !suggestedTask.id) return false;
      var missionId = suggestedTaskPromotedMissionId(suggestedTask);
      var subId = suggestedTaskTaskId(suggestedTask);
      if (!missionId || !subId) return false;
      var mission = (Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : []).find(function (g) {
        return String(g.id || '') === missionId;
      });
      if (!mission) return false;
      try {
        var gr = await fetch(API + '/api/missions/' + encodeURIComponent(missionId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tasks: removeTaskFromTree(mission.tasks, subId) }),
        });
        if (!gr.ok) return false;
        await fetch(API + '/api/suggestedTasks/' + encodeURIComponent(suggestedTask.id), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'proposed',
            activity: ['Promotion removed by user — review again before approving'],
          }),
        }).catch(function () {});
        await fetchMissionsSnapshot();
        await fetchSuggestedTasksSnapshot();
        if (typeof renderMissionControl === 'function') renderMissionControl();
        return true;
      } catch (_) {
        return false;
      }
    }

    function viewSuggestedTaskOnMission(suggestedTask) {
      var missionId = suggestedTaskPromotedMissionId(suggestedTask);
      var subId = suggestedTaskTaskId(suggestedTask);
      if (subId && typeof mc2OpenTaskDetail === 'function' && typeof findMissionTaskItem === 'function') {
        var item = findMissionTaskItem({ missionId: missionId, taskId: subId, title: suggestedTask && suggestedTask.title });
        if (item) {
          mc2OpenTaskDetail(item, { filter: 'all' });
          return;
        }
      }
      if (typeof mc2OpenTaskForSuggestedTask === 'function' && suggestedTask && suggestedTask.id) {
        mc2OpenTaskForSuggestedTask(suggestedTask.id);
        return;
      }
      if (!missionId) return;
      if (typeof mc2OpenTaskDetail === 'function') {
        mc2OpenTaskDetail(null, { missionId: missionId, taskId: subId, filter: 'all' });
        return;
      }
      selectedTeamMissionId = missionId;
      if (typeof mc2SetView === 'function') mc2SetView('missions');
      Promise.resolve(typeof mc2RenderMissions === 'function' ? mc2RenderMissions() : null).then(function () {
        if (typeof scheduleScrollToBlockedTarget === 'function') {
          scheduleScrollToBlockedTarget({
            kind: subId ? 'task' : 'mission',
            missionId: missionId,
            taskId: subId,
            title: suggestedTask.title || '',
          }, 0);
        }
      });
      renderMissionsList();
    }

    function renderSuggestedTaskDetail(suggestedTask, detailEl) {
      var detail = detailEl || document.getElementById('team-suggestedTask-detail');
      if (!detail) return;
      if (!suggestedTask || typeof suggestedTask !== 'object') {
        detail.innerHTML = '<p class="team-agent-inbox-empty" style="margin:0;padding:0;">Select an suggestedTask to review and promote.</p>';
        return;
      }
      var relatedMissions = Array.isArray(suggestedTask.relatedMissionIds) ? suggestedTask.relatedMissionIds : [];
      var relatedLabel = relatedMissions.length ? relatedMissions.map(function (gid) {
        var mission = (teamMissionsSnapshot.missions || []).find(function (g) { return String(g.id || '') === String(gid); });
        return mission ? mission.title : gid;
      }).join(', ') : '—';
      var status = String(suggestedTask.status || 'proposed').toLowerCase();
      var autoPromoted = suggestedTaskWasAutoPromoted(suggestedTask);
      var onMission = suggestedTaskIsOnMission(suggestedTask);
      var awaitingApproval = status === 'proposed' && !onMission;
      var activeMissions = activeMissionsForSuggestedTaskPicker();
      var defaultMissionId = suggestedTaskPromotedMissionId(suggestedTask) ||
        relatedMissions[0] ||
        (activeMissions[0] && activeMissions[0].id) ||
        '';
      var missionPickerHtml = activeMissions.length
        ? '<div class="team-suggestedTask-row"><label><strong>Target mission:</strong> ' +
            '<select class="team-init-mission-picker" data-init-mission-picker="1">' +
            activeMissions.map(function (g) {
              var gid = String(g.id || '');
              var selected = gid === String(defaultMissionId) ? ' selected' : '';
              return '<option value="' + escapeHtml(gid) + '"' + selected + '>' +
                escapeHtml(String(g.title || g.objective || gid)) + '</option>';
            }).join('') +
            '</select></label></div>'
        : '<div class="team-suggestedTask-row"><strong>Target mission:</strong> No active missions</div>';
      var badgeHtml = autoPromoted
        ? '<span class="team-suggestedTask-auto-badge">Auto-promoted (legacy)</span> '
        : (onMission ? '<span class="team-suggestedTask-auto-badge">On mission</span> '
          : (awaitingApproval ? '<span class="team-suggestedTask-auto-badge">Proposed</span> ' : ''));
      var reviseHtml = onMission
        ? '<button type="button" class="secondary" data-init-action="view-mission">View on mission</button>' +
          '<button type="button" class="secondary" data-init-action="undo-promotion">Undo promotion</button>'
        : '';
      var reviewHtml = status !== 'rejected' && !onMission
        ? '<button type="button" class="secondary" data-init-action="approve-task">Approve → add to mission</button>' +
          '<button type="button" class="secondary" data-init-action="reject">Reject</button>' +
          '<button type="button" class="secondary" data-init-action="promote-mission">Approve as new mission</button>'
        : (status === 'rejected' ? '' : '');
      detail.innerHTML = '' +
        '<h4>' + badgeHtml + escapeHtml(suggestedTask.title || 'Untitled suggestedTask') + '</h4>' +
        '<div class="team-suggestedTask-row"><strong>Type:</strong> <span class="team-suggestedTask-type">' + escapeHtml(suggestedTask.type || 'observation') + '</span></div>' +
        '<div class="team-suggestedTask-row"><strong>Status:</strong> <span class="team-suggestedTask-status ' + escapeHtml(status) + '">' + escapeHtml(status === 'proposed' ? 'proposed' : (suggestedTask.status || 'proposed')) + '</span></div>' +
        '<div class="team-suggestedTask-row"><strong>Confidence:</strong> ' + escapeHtml(String(Math.round((Number(suggestedTask.confidence) || 0) * 100))) + '%</div>' +
        '<div class="team-suggestedTask-row"><strong>Description:</strong> ' + escapeHtml(suggestedTask.description || '') + '</div>' +
        '<div class="team-suggestedTask-row"><strong>Source:</strong> ' + escapeHtml(suggestedTask.source || '') + '</div>' +
        '<div class="team-suggestedTask-row"><strong>Created by:</strong> ' + escapeHtml(agentNameById(suggestedTask.createdBy || 'main')) + '</div>' +
        '<div class="team-suggestedTask-row"><strong>Related missions:</strong> ' + escapeHtml(relatedLabel) + '</div>' +
        missionPickerHtml +
        '<div class="team-suggestedTask-row"><strong>Activity:</strong> ' + escapeHtml(
          suggestedTaskActivityLines(suggestedTask).map(humanizeSuggestedTaskActivityLine).join(' | ') || '—'
        ) + '</div>' +
        '<div class="team-suggestedTask-row"><strong>Specialist reviews:</strong> ' + escapeHtml((suggestedTask.specialistReviews || []).join(' | ') || '—') + '</div>' +
        '<div class="team-suggestedTask-actions">' + reviseHtml + reviewHtml + '</div>';
      wireSuggestedTaskDetailActions(detail, suggestedTask);
    }

    function wireSuggestedTaskDetailActions(detailEl, suggestedTask) {
      if (!detailEl || !suggestedTask || !suggestedTask.id) return;
      function missionIdFromPicker() {
        var picker = detailEl.querySelector('[data-init-mission-picker]');
        if (picker && picker.value) return String(picker.value).trim();
        return suggestedTaskPromotedMissionId(suggestedTask) ||
          ((Array.isArray(suggestedTask.relatedMissionIds) ? suggestedTask.relatedMissionIds : [])[0] || '');
      }
      detailEl.querySelectorAll('[data-init-action]').forEach(function (btn) {
        btn.addEventListener('click', async function () {
          var action = btn.getAttribute('data-init-action') || '';
          btn.disabled = true;
          try {
            if (action === 'reject') {
              await fetch(API + '/api/suggestedTasks/' + encodeURIComponent(suggestedTask.id), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'rejected', activity: ['Rejected by lead'] }),
              }).catch(function () {});
              await fetchSuggestedTasksSnapshot();
            } else if (action === 'promote-mission') {
              await fetch(API + '/api/suggestedTasks/' + encodeURIComponent(suggestedTask.id) + '/promote', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'mission' }),
              }).catch(function () {});
              await fetchMissionsSnapshot();
              await fetchSuggestedTasksSnapshot();
            } else if (action === 'approve-task' || action === 'promote-task') {
              var missionId = missionIdFromPicker();
              if (!missionId) return;
              await fetch(API + '/api/suggestedTasks/' + encodeURIComponent(suggestedTask.id) + '/promote', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: 'task', missionId: missionId }),
              }).catch(function () {});
              await fetchMissionsSnapshot();
              await fetchSuggestedTasksSnapshot();
            } else if (action === 'view-mission') {
              viewSuggestedTaskOnMission(suggestedTask);
            } else if (action === 'undo-promotion') {
              if (!window.confirm('Remove this suggestedTask from the mission and reopen it for review?')) return;
              await undoSuggestedTaskPromotion(suggestedTask);
            }
          } finally {
            btn.disabled = false;
          }
        });
      });
    }

    function renderSuggestedTasksPanel(opts) {
      opts = opts || {};
      var wrap = document.getElementById(opts.listId || 'team-suggestedTasks-list');
      var detailEl = document.getElementById(opts.detailId || 'team-suggestedTask-detail');
      if (!wrap) return;
      var suggestedTasks = Array.isArray(teamSuggestedTasksSnapshot.suggestedTasks) ? teamSuggestedTasksSnapshot.suggestedTasks.slice() : [];
      suggestedTasks.sort(function (a, b) { return (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0); });
      if (!suggestedTasks.length) {
        if (!selectedTeamSuggestedTaskId) selectedTeamSuggestedTaskId = '';
        wrap.innerHTML = '<p class="team-agent-inbox-empty" style="margin:0;padding:0.5rem 0;">No suggestedTasks yet.</p>';
        if (detailEl) renderSuggestedTaskDetail(null, detailEl);
        return;
      }
      if (!selectedTeamSuggestedTaskId || !suggestedTasks.some(function (i) { return String(i.id || '') === selectedTeamSuggestedTaskId; })) {
        selectedTeamSuggestedTaskId = String(suggestedTasks[0].id || '');
      }
      wrap.innerHTML = suggestedTasks.map(function (it) {
        var id = String(it.id || '');
        var selected = id === selectedTeamSuggestedTaskId ? ' selected' : '';
        var confidence = Math.round((Number(it.confidence) || 0) * 100);
        var status = String(it.status || 'proposed').toLowerCase();
        var badge = suggestedTaskWasAutoPromoted(it)
          ? '<span class="team-suggestedTask-auto-badge">Auto-promoted (legacy)</span> '
          : (suggestedTaskIsOnMission(it) ? '<span class="team-suggestedTask-auto-badge">On mission</span> '
            : (status === 'proposed' ? '<span class="team-suggestedTask-auto-badge">Proposed</span> ' : ''));
        return '<div class="team-suggestedTask-card' + selected + '" data-suggestedTask-id="' + escapeHtml(id) + '">' +
          '<div class="team-mission-card-head">' +
            '<h4 class="team-mission-card-title">' + badge + escapeHtml(it.title || 'Untitled suggestedTask') + '</h4>' +
            '<span class="team-suggestedTask-status ' + escapeHtml(status) + '">' + escapeHtml(status) + '</span>' +
          '</div>' +
          '<div class="team-mission-meta"><span class="team-suggestedTask-type">' + escapeHtml(it.type || 'observation') + '</span></div>' +
          '<div class="team-mission-meta"><strong>Confidence:</strong> ' + escapeHtml(String(confidence)) + '%</div>' +
          '<div class="team-mission-meta"><strong>Source:</strong> ' + escapeHtml(it.source || '') + '</div>' +
          '<div class="team-mission-meta">' + escapeHtml(String(it.description || '').slice(0, 180)) + '</div>' +
        '</div>';
      }).join('');
      var selectedSuggestedTask = suggestedTasks.find(function (i) { return String(i.id || '') === selectedTeamSuggestedTaskId; }) || suggestedTasks[0];
      if (detailEl) renderSuggestedTaskDetail(selectedSuggestedTask, detailEl);
      wrap.querySelectorAll('.team-suggestedTask-card').forEach(function (card) {
        card.addEventListener('click', function () {
          var id = String(card.getAttribute('data-suggestedTask-id') || '').trim();
          if (!id) return;
          selectedTeamSuggestedTaskId = id;
          renderSuggestedTasksPanels();
        });
      });
    }

    function renderSuggestedTasksPanels() {
      renderSuggestedTasksPanel({ listId: 'team-suggestedTasks-list', detailId: 'team-suggestedTask-detail' });
      renderSuggestedTasksPanel({ listId: 'mc2-suggestedTasks-list', detailId: 'mc2-suggestedTask-detail' });
    }

    function renderSuggestedTasksList() {
      renderSuggestedTasksPanels();
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
          renderAgentCardMenuButton(id) +
          '<div class="team-agent-card-head">' + shortName + ' ' + emoji + '</div>' +
          '<div class="team-agent-card-state">' + escapeHtml(stateLabel) + '</div>' +
          '<div class="team-agent-card-active">' + escapeHtml(String(activeCount)) + ' active</div>' +
        '</div>';
      }).join('');
      wireAgentCardMenus(row);
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
      var mission = missionLabelForAgent(agentId, row);
      var thought = String(row.currentThought || row.currentStep || '').trim();
      if (!thought && String(row.state || '') === 'idle') thought = 'Standing by for the next task.';
      var waitingOn = String(row.waitingFor || '').trim()
        ? agentNameById(row.waitingFor)
        : 'None';
      var lastAction = String(row.lastAction || '').trim() || 'None';
      return { mission: mission, thought: thought, waitingOn: waitingOn, lastAction: lastAction, state: row.state };
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
      html += renderAgentContextField('Current Mission:', display.mission, true);
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
        if (display.mission) bits.push(display.mission);
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
      var s = String(msg || '');
      // Strip the internal mission-tick system prompt prefix so it never surfaces in the UI.
      s = s.replace(/^You are executing a persistent background mission tick\.\s*/i, '');
      // If the remaining text starts with "Mission ID: ..." it's still internal; drop it.
      s = s.replace(/^Mission ID:\s*\S+\s*/i, '');
      // Unwrap a raw JSON blob that starts with { "status": ... } — show the summary field if present.
      if (/^\s*\{/.test(s)) {
        try {
          var parsed = JSON.parse(s);
          if (parsed && typeof parsed === 'object') {
            s = String(parsed.summary || parsed.message || parsed.status || s).trim();
          }
        } catch (_) {}
      }
      return s
        .replace(/Auto-promoted suggestedTask to task:/gi, 'Added suggestedTask to mission:')
        .replace(/Auto-promoted to task in/gi, 'Added to mission')
        .replace(/Promoted to task in/gi, 'Added to mission')
        .replace(/\btask\b/gi, 'task')
        .replace(/\btasks\b/gi, 'tasks')
        .trim();
    }

    function activityNavFromEvent(ev) {
      if (!ev || typeof ev !== 'object') return null;
      var type = String(ev.type || '');
      var details = ev.details && typeof ev.details === 'object' ? ev.details : {};
      var agentId = String(ev.agentId || ev.ownerAgentId || '');
      var missionId = String(ev.missionId || details.missionId || '');
      var taskId = String(ev.taskId || details.taskId || '');
      var suggestedTaskId = String(details.suggestedTaskId || '');
      if (type === 'suggestedTask_auto_promoted') {
        return {
          view: 'tasks',
          missionId: missionId,
          taskId: taskId,
          suggestedTaskId: suggestedTaskId,
          agentId: agentId,
        };
      }
      if (type === 'delegation_task_assigned') {
        return { view: 'tasks', missionId: missionId, taskId: taskId, agentId: agentId };
      }
      if (type === 'mission_task_created') {
        return { view: 'tasks', missionId: missionId, taskId: taskId, agentId: agentId };
      }
      if (type === 'mission_tick_done' || type === 'mission_tick_error' || type === 'mission_tick_start') {
        return { view: 'tasks', missionId: missionId, agentId: agentId };
      }
      if (type === 'turn_start' || type === 'turn_done') {
        return { view: 'tasks', agentId: agentId };
      }
      if (type.indexOf('delegation_') === 0) {
        return { view: 'tasks', agentId: agentId, missionId: missionId, taskId: taskId };
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
      if (type === 'suggestedTask_auto_promoted') {
        var initTitle = String(event.title || (details && details.title) || '').trim();
        if (!initTitle && msg) {
          var titleFromMsg = msg.match(/(?:Auto-promoted suggestedTask to task:|Added suggestedTask to mission:)\s*(.+?)\s*\(\d+%/i);
          if (titleFromMsg) initTitle = String(titleFromMsg[1] || '').trim();
        }
        var missionName = missionTitleForMissionId(String(event.missionId || (details && details.missionId) || ''));
        var confMatch = msg.match(/\((\d+)%\s*confidence\)/i);
        var confPct = confMatch ? confMatch[1] : '';
        var line = 'Added <span class="accent">' + escapeHtml(initTitle || 'suggestedTask') + '</span> to mission';
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
        return 'New task: ' + escapeHtml(humanizeTeamActivityMessage(msg) || 'request');
      }
      if (type === 'turn_done') {
        return 'Finished the task. ' + escapeHtml(humanizeTeamActivityMessage(msg) || '');
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
      if (type === 'suggestedTask_auto_promoted') {
        var initTitleSub = String(event.title || (details && details.title) || '').trim();
        var missionNameSub = missionTitleForMissionId(String(event.missionId || (details && details.missionId) || ''));
        var lineSub = 'Added <span class="accent">' + escapeHtml(initTitleSub || 'suggestedTask') + '</span> to mission';
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
      suggestedTask_auto_promoted: true,
      suggestedTask_scan_done: true,
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

      // For mission_tick_done events: keep only the LATEST one per mission so they appear
      // as a single "what this mission did last" row instead of one row per 60s tick.
      // mission_tick_start events are pure noise (no summary yet) — suppress them entirely.
      // All other event types pass through unchanged.
      var latestTickByMission = {};
      all.forEach(function (ev) {
        if (!ev) return;
        var type = String(ev.type || '');
        if (type !== 'mission_tick_done' && type !== 'mission_tick_error') return;
        var missionId = String((ev.details && ev.details.missionId) || ev.missionId || ev.agentId || '');
        var key = type + '|' + missionId;
        var ts = Number(ev.ts) || 0;
        if (!latestTickByMission[key] || ts > (Number(latestTickByMission[key].ts) || 0)) {
          latestTickByMission[key] = ev;
        }
      });
      var latestTickIds = {};
      Object.keys(latestTickByMission).forEach(function (k) {
        var ev = latestTickByMission[k];
        if (ev && ev.id) latestTickIds[String(ev.id)] = true;
      });

      var rest = all.filter(function (ev) {
        if (!ev || pinnedIds[String(ev.id || '')]) return false;
        var type = String(ev.type || '');
        if (type === 'mission_tick_start') return false; // no summary yet, pure noise
        if (type === 'mission_tick_done' || type === 'mission_tick_error') {
          // Only keep the latest tick per mission
          return !!latestTickIds[String(ev.id || '')];
        }
        return true;
      });
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
      return out.sort(function (a, b) {
        return (Number(b.ts) || 0) - (Number(a.ts) || 0);
      }).slice(0, maxGroups);
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
        if (nav.missionId) navAttrs += ' data-mission-id="' + escapeHtml(nav.missionId) + '"';
        if (nav.taskId) navAttrs += ' data-task-id="' + escapeHtml(nav.taskId) + '"';
        if (nav.suggestedTaskId) navAttrs += ' data-suggestedTask-id="' + escapeHtml(nav.suggestedTaskId) + '"';
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
      if (document.getElementById('page-team') && document.getElementById('page-team').classList.contains('active') &&
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
      if (document.getElementById('page-team') && document.getElementById('page-team').classList.contains('active') &&
        typeof renderMissionControl === 'function' && !shouldPauseTeamDashboardRefresh()) {
        renderMissionControl();
      }
    }

    async function fetchLlmUsage() {
      try {
        var r = await fetch(API + '/api/llm/usage');
        if (!r.ok) return;
        var d = await r.json().catch(function () { return {}; });
        var chip = document.getElementById('mc2-llm-usage');
        var txt  = document.getElementById('mc2-llm-usage-text');
        if (chip && txt) {
          var count = Number(d.count) || 0;
          var limit = Number(d.limit) || 100;
          var pct   = limit > 0 ? count / limit : 0;
          txt.textContent = count + ' / ' + limit;
          chip.classList.remove('is-warning', 'is-danger');
          if (pct >= 1)        chip.classList.add('is-danger');
          else if (pct >= 0.8) chip.classList.add('is-warning');
          var hoursLeft = Math.ceil((Number(d.msUntilReset) || 0) / 3600000);
          chip.title = count + ' of ' + limit + ' cloud LLM calls used today. Resets in ~' + hoursLeft + 'h (midnight UTC).';
        }
        var localRpm = d.localRpm !== undefined ? Number(d.localRpm) : 1;
        var rpmTxt = document.getElementById('mc2-local-rpm-text');
        var rpmBtn = document.getElementById('mc2-local-rpm-btn');
        if (rpmTxt) {
          rpmTxt.textContent = localRpm === 0 ? 'local: unlimited' : 'local: ' + localRpm + '/min';
        }
        if (rpmBtn) {
          rpmBtn.title = 'Local LLM rate limit: ' + (localRpm === 0 ? 'unlimited' : localRpm + ' req/min') + '. Click to change.';
        }
      } catch (_) {}
    }

    (function setupLocalRpmBtn() {
      var btn = document.getElementById('mc2-local-rpm-btn');
      if (!btn) return;
      btn.addEventListener('click', async function () {
        var currentTxt = document.getElementById('mc2-local-rpm-text');
        var currentRpm = 1;
        if (currentTxt) {
          var m = currentTxt.textContent.match(/(\d+)/);
          currentRpm = m ? Number(m[1]) : 1;
          if (currentTxt.textContent.includes('unlimited')) currentRpm = 0;
        }
        var input = window.prompt(
          'Local LLM requests per minute (1 = default, 0 = unlimited):',
          String(currentRpm)
        );
        if (input === null) return;
        var val = Number(input);
        if (isNaN(val) || val < 0) { alert('Invalid value. Enter a number ≥ 0.'); return; }
        try {
          var r = await fetch(API + '/api/llm/local-rpm', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ localRpm: val }),
          });
          if (!r.ok) { var e = await r.json().catch(function () { return {}; }); alert('Failed: ' + (e.error || r.status)); return; }
          fetchLlmUsage();
        } catch (ex) { alert('Error saving: ' + ex.message); }
      });
    })();

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

    async function fetchMissionsSnapshot() {
      try {
        var r = await fetch(API + '/api/missions');
        if (!r.ok) return;
        var d = await r.json().catch(function () { return {}; });
        teamMissionsSnapshot = {
          missions: Array.isArray(d.missions) ? d.missions : [],
          updatedAt: Number(d.updatedAt) || 0,
        };
      } catch (_) {}
      renderMissionsList();
      renderAgentContext();
      renderCurrentMission();
      renderTeamTaskSummary();
      if (typeof renderMissionControl === 'function' && !shouldPauseTeamDashboardRefresh()) {
        renderMissionControl();
      }
      if (!shouldPauseTeamDashboardRefresh()) renderTeamUserInputModal();
    }

    var teamUserInputMissionId = '';
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

    function countBlockedTasksForMission(mission) {
      if (!mission) return 0;
      var count = 0;
      function walk(tasks) {
        (tasks || []).forEach(function (sg) {
          if (!sg || typeof sg !== 'object') return;
          if (effectiveTaskStatus(sg, mission) === 'blocked') count++;
          walk(sg.tasks);
        });
      }
      walk(mission.tasks);
      return count;
    }

    function collectBlockedTasksForMission(mission) {
      var result = [];
      if (!mission) return result;
      function walk(tasks) {
        (tasks || []).forEach(function (sg) {
          if (!sg || typeof sg !== 'object') return;
          // system_error tasks auto-retry and are never user-actionable — hide from user.
          if (effectiveTaskStatus(sg, mission) === 'blocked' && !isSystemErrorTask(sg)) result.push(sg);
          walk(sg.tasks);
        });
      }
      walk(mission.tasks);
      return result;
    }

    function parseUserInputNumberedOptions(optionsText) {
      var raw = String(optionsText || '').trim();
      if (!raw) return [];
      var chunks = raw.split(/\s*(?:·|\|)\s*|\s+(?=\d+\)\s)/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (chunks.length <= 1 && /\d+\)/.test(raw)) {
        chunks = raw.match(/\d+\)\s*[\s\S]*?(?=\s+\d+\)|$)/g) || [raw];
      }
      return chunks.map(function (part) {
        return part.replace(/^\d+\)\s*/, '').replace(/\*\*/g, '').trim();
      }).filter(Boolean);
    }

    function parseUserInputAsk(ask) {
      var raw = String(ask || '').replace(/\*\*/g, '').trim();
      if (!raw) return { kind: 'empty' };
      if (raw.indexOf('\n') >= 0) {
        var lines = raw.split(/\n+/).map(function (line) { return line.trim(); }).filter(Boolean);
        var recIdx = -1;
        var optIdx = -1;
        var replyIdx = -1;
        lines.forEach(function (line, idx) {
          if (recIdx < 0 && /^Recommend(?::|\s)/i.test(line)) recIdx = idx;
          if (optIdx < 0 && /^Options:?$/i.test(line)) optIdx = idx;
          if (replyIdx < 0 && /^Reply\b/i.test(line)) replyIdx = idx;
        });
        if (recIdx >= 0 && optIdx >= 0) {
          var optionLines = lines.slice(optIdx + 1, replyIdx >= 0 ? replyIdx : lines.length);
          return {
            kind: 'decision',
            question: lines.slice(0, recIdx).join(' ').replace(/\.$/, '').trim(),
            recommend: lines[recIdx].replace(/^Recommend(?::|\s)/i, '').replace(/\.$/, '').trim(),
            options: optionLines.map(function (line) {
              return line.replace(/^\d+\)\s*/, '').trim();
            }).filter(Boolean),
            reply: replyIdx >= 0 ? lines[replyIdx] : '',
          };
        }
        return { kind: 'multiline', lines: lines };
      }
      var decisionMatch = raw.match(/^(.+?)\.\s*Recommend(?::|\s)\s*(.+?)\.\s*Options:\s*(.+?)\.\s*(Reply.+)$/i);
      if (decisionMatch) {
        return {
          kind: 'decision',
          question: decisionMatch[1].trim(),
          recommend: decisionMatch[2].trim(),
          options: parseUserInputNumberedOptions(decisionMatch[3]),
          reply: decisionMatch[4].trim(),
        };
      }
      var softened = raw
        .replace(/\.\s*(Recommend(?::|\s))/gi, '.\n$1')
        .replace(/\.\s*(Options:)/gi, '.\n$1')
        .replace(/(Options:)\s*/i, '$1\n')
        .replace(/\s+(?=\d+\)\s)/g, '\n')
        .replace(/\.\s*(Reply\b)/i, '.\n$1');
      if (softened.indexOf('\n') >= 0) {
        return parseUserInputAsk(softened);
      }
      return { kind: 'plain', text: raw };
    }

    function formatUserInputQuestionHtml(ask) {
      var parsed = parseUserInputAsk(ask);
      if (parsed.kind === 'decision') {
        var html = '<div class="team-user-input-question-body">';
        html += '<p class="team-user-input-question-lead">' + escapeHtml(parsed.question) + '</p>';
        html += '<p class="team-user-input-question-recommend"><span class="team-user-input-question-kicker">Recommended</span> ' + escapeHtml(parsed.recommend) + '</p>';
        if (parsed.options.length) {
          html += '<div class="team-user-input-question-options"><span class="team-user-input-question-kicker">Options</span><ol>';
          parsed.options.forEach(function (opt) {
            html += '<li>' + escapeHtml(opt) + '</li>';
          });
          html += '</ol></div>';
        }
        html += '<p class="team-user-input-question-reply">' + escapeHtml(parsed.reply) + '</p>';
        html += '</div>';
        return html;
      }
      if (parsed.kind === 'multiline') {
        var lines = parsed.lines || [];
        var body = '<div class="team-user-input-question-body">';
        if (lines.length) {
          body += '<p class="team-user-input-question-lead">' + escapeHtml(lines[0]) + '</p>';
          lines.slice(1).forEach(function (line) {
            body += '<p class="team-user-input-question-detail">' + escapeHtml(line) + '</p>';
          });
        }
        body += '</div>';
        return body;
      }
      return '<div class="team-user-input-question-body team-user-input-question-plain">' + escapeHtml(parsed.text || ask) + '</div>';
    }

    function extractUserInputQuickOptions(ask) {
      var parsed = parseUserInputAsk(ask);
      if (parsed.kind !== 'decision' || !parsed.options.length) return [];
      var options = [{ label: 'Use default', value: 'use default' }];
      parsed.options.forEach(function (label, index) {
        options.push({ label: label, value: String(index + 1) });
      });
      return options;
    }

    function userInputModalIsRich(ask, quickOptions, blockedTasks) {
      var parsed = parseUserInputAsk(ask);
      if (parsed.kind === 'decision' && parsed.options.length) return true;
      if (parsed.kind === 'multiline' && parsed.lines.length >= 3) return true;
      if (quickOptions && quickOptions.length) return true;
      if (String(ask || '').length > 140) return true;
      if (blockedTasks && blockedTasks.length > 0) {
        var desc = String(blockedTasks[0].description || blockedTasks[0].expectedOutput || '').trim();
        if (desc.length > 80) return true;
      }
      return false;
    }

    function isOrphanedLetterPrompt(text) {
      var raw = String(text || '').replace(/\s+/g, ' ').trim();
      if (!raw) return false;
      var asksForLetter = /\breply with (one )?(character|letter)\b/i.test(raw)
        || (/\b(recommended|pick|choose):\s*[A-E]\b/i.test(raw) && /\b[A-E]\s*,\s*[A-E]\b/.test(raw));
      if (!asksForLetter) return false;
      var hasOptionDefs = /\b[A-E]\s*=\s*\S/.test(raw)
        || /\b[A-E]\)\s+[A-Za-z0-9"']/.test(raw);
      var truncatedGlossary = /\b[A-E]\s*=/.test(raw) && raw.endsWith('...');
      return !hasOptionDefs || truncatedGlossary;
    }

    function missionAttentionPrompt(mission) {
      if (!mission) return '';
      var ask = String(mission.needsUserInput || '').trim();
      if (ask && !isOrphanedLetterPrompt(ask)) return ask;
      var blockedTasks = collectBlockedTasksForMission(mission);
      if (blockedTasks.length > 0) {
        var first = blockedTasks[0];
        var taskTitle = String(first.title || '').trim();
        var taskDesc = String(first.description || first.expectedOutput || '').trim();
        var typeLabel = blockerTypeLabel(first);
        if (taskTitle && taskDesc) {
          var prompt = typeLabel + ': "' + taskTitle + '"\n' + taskDesc;
          if (blockedTasks.length > 1) {
            prompt += '\n\n(+' + (blockedTasks.length - 1) + ' more blocked task' + (blockedTasks.length > 2 ? 's' : '') + ')';
          }
          return prompt;
        }
        if (taskTitle) {
          var prompt = typeLabel + ': "' + taskTitle + '"\nPlease provide what\'s needed to unblock this task.';
          if (blockedTasks.length > 1) {
            prompt += '\n\n(+' + (blockedTasks.length - 1) + ' more blocked task' + (blockedTasks.length > 2 ? 's' : '') + ')';
          }
          return prompt;
        }
        return 'This mission has ' + blockedTasks.length + ' blocked task(s). Tell the team what to do next.';
      }
      if (isMissionPartialWait(mission)) {
        return missionImplementationBlockedLabel(mission) || 'Implementation is paused until you confirm the next step. Reply with your choice or "use default".';
      }
      if (String(mission.status || '').toLowerCase() === 'blocked') {
        return String(mission.blockedReason || '').trim() || 'This mission is blocked. What should the team do next?';
      }
      return '';
    }

    function missionNeedsAttention(mission) {
      if (!mission) return false;
      // User was explicitly asked something.
      var ask = String(mission.needsUserInput || '').trim();
      if (ask && !isOrphanedLetterPrompt(ask)) return true;
      // There are tasks that need user input or have hard errors.
      if (countBlockedTasksForMission(mission) > 0) return true;
      // Mission itself errored or is hard-blocked.
      if (String(mission.status || '').toLowerCase() === 'blocked') return true;
      // A partial wait with no user-input ask is an internal dependency pause — no user action required.
      return false;
    }

    function teamUserInputDismissKey(mission) {
      return String(mission.id || '') + '::' + missionAttentionPrompt(mission).slice(0, 240);
    }

    function isTeamUserInputModalOpen() {
      var modal = document.getElementById('team-user-input-modal');
      return !!(modal && modal.classList.contains('open'));
    }

    function shouldPauseTeamDashboardRefresh() {
      return isTeamUserInputModalOpen();
    }

    function isTeamMainViewActive() {
      if (document.body.classList.contains('dashboard-team-active')) {
        return true;
      }
      if (document.body.classList.contains('dashboard-team-active')) {
        return teamTopTab === 'roster';
      }
      return false;
    }

    function getMissionsNeedingUserInput() {
      return (Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : []).filter(function (g) {
        return missionNeedsAttention(g);
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
      var cardEl = modal.querySelector('.team-user-input-modal-card');
      if (cardEl) cardEl.classList.remove('team-user-input-modal-card--rich');
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      teamUserInputMissionId = '';
      showTeamUserInputModalError('');
    }

    function openTeamUserInputModal(mission, opts) {
      opts = opts || {};
      var modal = document.getElementById('team-user-input-modal');
      var titleEl = document.getElementById('team-user-input-modal-title');
      var missionEl = document.getElementById('team-user-input-modal-mission');
      var questionEl = document.getElementById('team-user-input-modal-question');
      var quickEl = document.getElementById('team-user-input-modal-quick');
      var textEl = document.getElementById('team-user-input-modal-text');
      var cardEl = modal ? modal.querySelector('.team-user-input-modal-card') : null;
      if (!modal || !mission) return;
      var id = String(mission.id || '');
      var ask = String(opts.ask || mission.needsUserInput || '').trim();
      if (!ask) ask = missionAttentionPrompt(mission);
      if (!id || !ask) return;
      teamUserInputMissionId = id;

      var blockedTasks = collectBlockedTasksForMission(mission);
      var firstBlockedTitle = blockedTasks.length > 0 ? String(blockedTasks[0].title || '').trim() : '';

      if (titleEl) {
        titleEl.textContent = firstBlockedTitle
          ? 'Task blocked — needs your input'
          : 'Mission needs your input';
      }
      if (missionEl) missionEl.textContent = 'Mission: ' + String(mission.title || 'Untitled mission');
      if (questionEl) questionEl.innerHTML = formatUserInputQuestionHtml(ask);
      if (textEl) textEl.value = '';
      showTeamUserInputModalError('');
      var askLower = ask.toLowerCase();
      var firstBlockedDesc = blockedTasks.length > 0 ? String(blockedTasks[0].description || blockedTasks[0].expectedOutput || '').toLowerCase() : '';
      var matchText = askLower + ' ' + firstBlockedDesc;
      var options = extractUserInputQuickOptions(ask);
      if (!options.length && /posthog|analytics|ga4|mixpanel|tracking|measurement/.test(matchText)) {
        options = [
          { label: 'PostHog', value: 'PostHog' },
          { label: 'Google Analytics (GA4)', value: 'Google Analytics (GA4)' },
          { label: 'Mixpanel', value: 'Mixpanel' },
          { label: 'No analytics yet — use defaults', value: 'use default' },
        ];
      }
      if (quickEl) {
        quickEl.innerHTML = options.map(function (opt) {
          var label = typeof opt === 'string' ? opt : opt.label;
          var value = typeof opt === 'string' ? opt : opt.value;
          return '<button type="button" class="secondary team-user-input-quick-btn" data-quick-response="' + escapeHtml(value) + '">' + escapeHtml(label) + '</button>';
        }).join('');
      }
      if (cardEl) {
        cardEl.classList.toggle('team-user-input-modal-card--rich', userInputModalIsRich(ask, options, blockedTasks));
      }
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      if (textEl) setTimeout(function () { textEl.focus(); }, 0);
    }

    function openMissionWorkInputModal(item) {
      if (!item || !item.missionId) return false;
      var mission = (Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : []).find(function (g) {
        return String(g.id || '') === String(item.missionId || '');
      });
      if (!mission) return false;
      var ask = missionAttentionPrompt(mission);
      if (item.title && item.kind === 'task') {
        ask = 'Blocked task: "' + String(item.title) + '". ' + ask;
      }
      openTeamUserInputModal(mission, { ask: ask });
      return true;
    }

    async function patchMissionTaskStatus(missionId, taskId, nextStatus) {
      var gid = String(missionId || '').trim();
      var sid = String(taskId || '').trim();
      if (!gid || !sid) return false;
      var mission = (Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : []).find(function (g) {
        return String(g.id || '') === gid;
      });
      if (!mission) return false;
      function patchTree(tasks) {
        return (tasks || []).map(function (sg) {
          if (!sg || typeof sg !== 'object') return sg;
          var next = Object.assign({}, sg);
          if (String(next.id || '') === sid) {
            next.status = nextStatus;
          }
          if (Array.isArray(next.tasks) && next.tasks.length) {
            next.tasks = patchTree(next.tasks);
          }
          return next;
        });
      }
      try {
        var r = await fetch(API + '/api/missions/' + encodeURIComponent(gid), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tasks: patchTree(mission.tasks) }),
        });
        if (!r.ok) return false;
        await fetchMissionsSnapshot();
        if (typeof renderMissionControl === 'function') renderMissionControl();
        return true;
      } catch (_) {
        return false;
      }
    }

    function findMissionById(missionId) {
      var gid = String(missionId || '').trim();
      if (!gid) return null;
      var missions = Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : [];
      for (var i = 0; i < missions.length; i++) {
        if (String(missions[i].id || '') === gid) return missions[i];
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

    function countMissionTicksBefore(missionId, beforeTs) {
      var gid = String(missionId || '').trim();
      if (!gid) return 0;
      var cutoff = Number(beforeTs) || Date.now();
      var ticks = (teamActivityEvents || []).filter(function (ev) {
        return ev &&
          String(ev.type || '') === 'mission_tick_start' &&
          String(ev.missionId || '') === gid &&
          Number(ev.ts) <= cutoff;
      }).sort(function (a, b) { return (Number(a.ts) || 0) - (Number(b.ts) || 0); });
      return ticks.length;
    }

    function formatMissionSourceLabel(kind) {
      var labels = {
        suggestedTask_auto_promotion: 'SuggestedTask Auto Promotion',
        suggestedTask_promotion: 'SuggestedTask Promotion',
        mission_tick: 'Mission Tick',
        curiosity_momentum: 'Curiosity Momentum',
        curiosity_suggestion: 'Idle Suggestion',
        curiosity_idle_check: 'Idle Check',
        agent_delegation: 'Agent Delegation',
        user_request: 'User Request',
        agent_turn: 'Agent Task',
        mission_planning: 'Mission Planning',
      };
      return labels[kind] || labels.mission_planning;
    }

    function findTaskOriginEvents(item) {
      var taskId = String(item && item.taskId || '');
      var missionId = String(item && item.missionId || '');
      var titleNeedle = String(item && item.title || '').trim().toLowerCase().slice(0, 40);
      var out = { promoteEv: null, createEv: null, assignEv: null };
      (teamActivityEvents || []).forEach(function (ev) {
        if (!ev) return;
        var type = String(ev.type || '');
        var details = ev.details && typeof ev.details === 'object' ? ev.details : {};
        var evSubId = String(details.taskId || ev.taskId || '');
        var evMissionId = String(details.missionId || ev.missionId || '');
        var matchSub = taskId && evSubId === taskId;
        var matchMissionTitle = !matchSub && missionId && evMissionId === missionId && titleNeedle &&
          (String(ev.title || details.title || ev.message || '').toLowerCase().indexOf(titleNeedle.slice(0, 24)) >= 0);
        if (!matchSub && !matchMissionTitle) return;
        if (type === 'suggestedTask_auto_promoted' && !out.promoteEv) out.promoteEv = ev;
        if (type === 'mission_task_created' && !out.createEv) out.createEv = ev;
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
        suggestedTaskTitle: '',
        suggestedTaskId: '',
      };
      var missionId = String(item.missionId || '');
      var taskId = String(item.taskId || '');
      var suggestedTask = typeof findSuggestedTaskForTaskId === 'function'
        ? findSuggestedTaskForTaskId(taskId)
        : null;
      var origin = findTaskOriginEvents(item);
      var promoteEv = origin.promoteEv;
      var createEv = origin.createEv;
      var assignEv = origin.assignEv;

      if (suggestedTask || promoteEv || /^init-/.test(taskId)) {
        var auto = (suggestedTask && suggestedTaskWasAutoPromoted(suggestedTask)) || !!promoteEv;
        chain.sourceKind = auto ? 'suggestedTask_auto_promotion' : 'suggestedTask_promotion';
        chain.source = formatMissionSourceLabel(chain.sourceKind);
        chain.suggestedTaskId = suggestedTask
          ? String(suggestedTask.id || '')
          : suggestedTaskIdFromTaskId(taskId);
        chain.suggestedTaskTitle = suggestedTask ? String(suggestedTask.title || '') : String(item.title || '');
        var conf = suggestedTask ? Number(suggestedTask.confidence) : NaN;
        if (!isFinite(conf) && promoteEv) {
          var confMatch = String(promoteEv.message || '').match(/\((\d+)%\s*confidence\)/i);
          if (confMatch) conf = Number(confMatch[1]) / 100;
        }
        if (isFinite(conf) && conf > 0) {
          chain.confidence = Math.round(conf <= 1 ? conf * 100 : conf);
        }
        var originTs = (suggestedTask && Number(suggestedTask.createdAt)) ||
          (promoteEv && Number(promoteEv.ts)) ||
          Number(item.createdAt) || Date.now();
        var tickMissionId = missionId ||
          (suggestedTask && Array.isArray(suggestedTask.relatedMissionIds) && suggestedTask.relatedMissionIds[0]) ||
          String(promoteEv && promoteEv.missionId || '');
        var tickNum = countMissionTicksBefore(tickMissionId, originTs);
        chain.createdBy = tickNum ? ('Mission Tick #' + tickNum) : 'SuggestedTask Scan';
        chain.agentId = (suggestedTask && String(suggestedTask.createdBy || '')) ||
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
        if (assignEv && missionId) {
          var dTick = countMissionTicksBefore(missionId, assignEv.ts);
          if (dTick) chain.createdBy = 'Mission Tick #' + dTick;
        }
        return chain;
      }

      if (createEv) {
        var createMsg = String(createEv.message || '');
        var isCuriosity = /curiosity task/i.test(createMsg);
        chain.sourceKind = isCuriosity ? 'curiosity_momentum' : 'mission_tick';
        chain.source = formatMissionSourceLabel(chain.sourceKind);
        var cMissionId = missionId || String(createEv.missionId || '');
        var cTick = countMissionTicksBefore(cMissionId, createEv.ts);
        chain.createdBy = cTick ? ('Mission Tick #' + cTick) : (isCuriosity ? 'Curiosity Cycle' : 'Mission Tick');
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

      var mission = missionId ? findMissionById(missionId) : null;
      if (mission && String(mission.needsUserInput || '').trim()) {
        chain.sourceKind = 'user_request';
        chain.source = formatMissionSourceLabel(chain.sourceKind);
        chain.createdBy = 'User';
        chain.agentId = String(item.assignee || mission.ownerAgentId || '');
        chain.agent = agentNameById(chain.agentId) || '—';
        return chain;
      }

      chain.source = formatMissionSourceLabel('mission_planning');
      var fallbackTick = countMissionTicksBefore(missionId, item.createdAt || Date.now());
      chain.createdBy = fallbackTick ? ('Mission Tick #' + fallbackTick) : 'Mission Planning';
      chain.agentId = String(item.assignee || (mission && mission.ownerAgentId) || item.agentId || '');
      chain.agent = agentNameById(chain.agentId) || '—';
      return chain;
    }

    var MISSION_TASK_AI_SUGGESTED_ARCHIVE_DAYS = 3;
    var MISSION_TASK_MANUAL_INIT_ARCHIVE_DAYS = 7;

    function formatInactionDaysRemaining(deadlineTs) {
      var ms = Number(deadlineTs) - Date.now();
      if (!Number(deadlineTs)) return null;
      if (ms <= 0) return 'Soon';
      var days = Math.ceil(ms / 86400000);
      if (days === 1) return '1 day';
      return days + ' days';
    }

    function missionTaskImpactFromSuggestedTask(suggestedTask) {
      if (!suggestedTask) return 'Medium';
      var initType = String(suggestedTask.type || 'observation').toLowerCase();
      if (initType === 'risk' || initType === 'gap' || initType === 'warning') return 'High';
      var conf = Number(suggestedTask.confidence);
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

      var mission = item.missionId ? findMissionById(item.missionId) : null;
      var suggestedTask = (item.fromSuggestedTask || /^init-/.test(String(item.taskId || '')))
        ? findSuggestedTaskForTaskId(item.taskId)
        : null;
      var autoPromoted = suggestedTask && suggestedTaskWasAutoPromoted(suggestedTask);

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
        if (mission && String(mission.needsUserInput || '').trim()) {
          blockedMsg = 'Mission progress blocked until reviewed.';
        }
        return pack(true, 'High', blockedMsg, null);
      }

      if (mission) {
        var needsInput = String(mission.needsUserInput || '').trim();
        var partialWait = typeof isMissionPartialWait === 'function' && isMissionPartialWait(mission);
        if (needsInput) {
          return pack(true, 'High', 'Mission progress blocked until you respond.', null);
        }
        if (partialWait) {
          return pack(true, 'High', 'Implementation blocked — mission continues research only until resolved.', null);
        }
        if (String(mission.status || '').toLowerCase() === 'blocked') {
          return pack(true, 'High', 'Mission progress blocked until reviewed.', null);
        }
      }

      if (autoPromoted && suggestedTask) {
        var promotedTs = Number(suggestedTask.updatedAt || suggestedTask.createdAt || item.createdAt) || Date.now();
        var archiveDeadline = promotedTs + (MISSION_TASK_AI_SUGGESTED_ARCHIVE_DAYS * 86400000);
        var impact = missionTaskImpactFromSuggestedTask(suggestedTask);
        var archiveIn = formatInactionDaysRemaining(archiveDeadline);
        var advisory = 'Agents keep working on other tasks. Unreviewed auto-promoted tasks archive and leave the mission after ' +
          MISSION_TASK_AI_SUGGESTED_ARCHIVE_DAYS + ' days.';
        return pack(false, impact, advisory, archiveIn);
      }

      if (suggestedTask && typeof suggestedTaskIsOnMission === 'function' && suggestedTaskIsOnMission(suggestedTask)) {
        var manualTs = Number(suggestedTask.updatedAt || item.createdAt) || Date.now();
        var manualArchive = formatInactionDaysRemaining(manualTs + (MISSION_TASK_MANUAL_INIT_ARCHIVE_DAYS * 86400000));
        return pack(
          false,
          missionTaskImpactFromSuggestedTask(suggestedTask),
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
      var mission = out.missionId ? findMissionById(out.missionId) : null;
      var events = typeof buildMissionTaskTimeline === 'function' ? buildMissionTaskTimeline(out, 40) : [];
      var createdEv = null;
      var assignedEv = null;
      var delegatedEv = null;
      var completedEv = null;
      events.forEach(function (ev) {
        var type = String(ev && ev.type || '');
        if (type === 'mission_task_created' && !createdEv) createdEv = ev;
        if (type === 'delegation_task_assigned' && !assignedEv) assignedEv = ev;
        if (type === 'delegation_start' && !delegatedEv) delegatedEv = ev;
        if (type === 'turn_done' && !completedEv) completedEv = ev;
      });

      if (!out.createdAt) {
        if (createdEv) out.createdAt = Number(createdEv.ts) || 0;
        else if (out.delegatedAt) out.createdAt = Number(out.delegatedAt) || 0;
        else if (mission && mission.createdAt) out.createdAt = Number(mission.createdAt) || 0;
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
        } else if (out.fromSuggestedTask) {
          out.createdByLabel = createdEv && createdEv.agentId ? agentNameById(createdEv.agentId) : 'Agent';
        } else if (mission && String(mission.needsUserInput || '').trim()) {
          out.createdByLabel = 'User';
        } else {
          out.createdByLabel = 'User';
        }
      }
      if (!out.reason) {
        out.reason = String(out.description || '').trim();
        if (!out.reason && mission) {
          out.reason = String(mission.needsUserInput || mission.objective || '').trim();
        }
        if (!out.reason && out.prompt) out.reason = String(out.prompt).trim();
        if (!out.reason && out.summary) out.reason = String(out.summary).trim();
      }
      if (!out.mainAsk) {
        var turnStartEv = null;
        events.forEach(function (ev) {
          if (String(ev && ev.type || '') === 'turn_start') turnStartEv = ev;
        });
        if (turnStartEv && String(turnStartEv.message || '').trim()) {
          out.mainAsk = String(turnStartEv.message).trim();
        } else if (out.prompt) {
          out.mainAsk = String(out.prompt).trim();
        } else if (mission && String(mission.needsUserInput || '').trim()) {
          out.mainAsk = String(mission.needsUserInput).trim();
        } else if (mission && String(mission.objective || '').trim()) {
          out.mainAsk = String(mission.objective).trim();
        }
      }
      if (!out.missionObjective && mission) {
        out.missionObjective = String(mission.objective || '').trim();
      }
      if (!out.missionHistory && mission && Array.isArray(mission.history) && mission.history.length) {
        out.missionHistory = mission.history.slice(-5);
      }
      if (!out.missionProgress && mission && mission.progress) {
        out.missionProgress = mission.progress;
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
        if (!skills.length && mission && String(mission.source || '').indexOf('workflow') >= 0) {
          skills.push('project-workflow');
        }
        out.skillsUsed = skills;
      }
      if (!out.missionTitle && mission) {
        out.missionTitle = String(mission.title || mission.objective || '').trim();
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
        if (type === 'mission_task_created') push(ts, 'Created');
        else if (type === 'delegation_task_assigned') push(ts, 'Assigned');
        else if (type === 'delegation_start') push(ts, 'Delegated');
        else if (type === 'turn_start') push(ts, 'Started');
        else if (type === 'turn_done') push(ts, 'Completed');
        else if (type === 'suggestedTask_auto_promoted') push(ts, 'Added to mission');
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
      var missionId = String(opts.missionId || '').trim();
      var taskId = String(opts.taskId || '').trim();
      var slug = String(opts.slug || '').trim();
      var agentId = String(opts.agentId || '').trim();
      var title = String(opts.title || '').trim().toLowerCase();
      var i;
      if (taskId) {
        for (i = 0; i < items.length; i++) {
          if (String(items[i].taskId || '') === taskId) {
            if (!missionId || String(items[i].missionId || '') === missionId) return items[i];
          }
        }
        // taskId didn't match any item's id — also try matching it against slug
        for (i = 0; i < items.length; i++) {
          if (String(items[i].slug || '') === taskId) {
            if (!missionId || String(items[i].missionId || '') === missionId) return items[i];
          }
        }
      }
      if (slug) {
        for (i = 0; i < items.length; i++) {
          if (String(items[i].slug || '') === slug) {
            if (!missionId || String(items[i].missionId || '') === missionId) return items[i];
          }
        }
      }
      if (agentId) {
        var agentItems = items.filter(function (it) {
          return it.kind === 'task' &&
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
      if (title && !taskId && !missionId) {
        var byTitleOnly = findMissionTaskItemByTitle(title);
        if (byTitleOnly) return byTitleOnly;
      }
      if (title && missionId) {
        for (i = 0; i < items.length; i++) {
          if (String(items[i].missionId || '') === missionId &&
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
        return it.kind === 'task' &&
          String(it.assignee || it.agentId || '') === aid &&
          (it.status === 'blocked' || it.status === 'doing' || it.status === 'todo');
      });
      if (active.length === 1) return active[0];
      ctx = ctx || (teamAgentContextSnapshot.agents || {})[aid] || {};
      var needle = String(ctx.currentStep || ctx.currentMission || ctx.currentThought || ctx.lastAction || '').trim().toLowerCase();
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
      var missionId = String(item.missionId || '');
      var taskId = String(item.taskId || '');
      var assignee = String(item.assignee || item.agentId || '');
      var titleNeedle = String(item.title || '').trim().toLowerCase().slice(0, 48);
      var matched = [];
      (teamActivityEvents || []).forEach(function (ev) {
        if (!ev) return;
        var details = ev.details && typeof ev.details === 'object' ? ev.details : {};
        var evMissionId = String(details.missionId || ev.missionId || '');
        var evSubId = String(details.taskId || '');
        var hit = false;
        if (taskId && evSubId === taskId) hit = true;
        if (!hit && taskId && String(ev.type || '') === 'suggestedTask_auto_promoted' &&
          String(ev.title || details.title || '').toLowerCase().indexOf(titleNeedle.slice(0, 24)) >= 0) {
          hit = true;
        }
        if (!hit && missionId && evMissionId === missionId) {
          if (!taskId || !titleNeedle) hit = true;
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
      } else if (type === 'suggestedTask_auto_promoted') {
        line = 'Added to mission' + (msg ? ': ' + humanizeTeamActivityMessage(msg).replace(/^Added suggestedTask to mission:\s*/i, '') : '');
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

    function parseMissionTickActivityLines(message) {
      var msg = humanizeTeamActivityMessage(String(message || '')).trim();
      if (!msg) return [];
      var lines = [];
      var initMatch = msg.match(/(?:proposals|suggestedTasks) created=(\d+)/i);
      if (initMatch && Number(initMatch[1]) > 0) {
        var n = Number(initMatch[1]);
        lines.push('Proposed ' + n + ' suggestedTask' + (n === 1 ? '' : 's'));
      }
      var mergedMatch = msg.match(/merged=(\d+)/i);
      if (mergedMatch && Number(mergedMatch[1]) > 0 && !initMatch) {
        var m = Number(mergedMatch[1]);
        lines.push('Merged ' + m + ' suggestedTask' + (m === 1 ? '' : 's'));
      }
      var parts = msg.split(/\s*\|\s*/).map(function (part) { return part.trim(); }).filter(Boolean);
      parts.forEach(function (part) {
        if (/^(?:proposals|suggestedTasks) created=/i.test(part) || /^merged=/i.test(part)) return;
        if (/^New tasks:/i.test(part)) {
          lines.push(part.replace(/^New tasks:\s*/i, 'Added tasks: '));
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
      if (type === 'mission_tick_done' || type === 'mission_tick_start') {
        return parseMissionTickActivityLines(msg || title).join('\n');
      }
      if (type === 'suggestedTask_scan_done') {
        var created = msg.match(/created=(\d+)/i);
        if (created && Number(created[1]) > 0) {
          var n = Number(created[1]);
          return 'Created ' + n + ' suggestedTask' + (n === 1 ? '' : 's');
        }
      }
      if (type === 'suggestedTask_auto_promoted') {
        var initTitle = title || String(details.title || '').trim();
        return initTitle ? ('Added suggestedTask: ' + initTitle) : 'Added suggestedTask to mission';
      }
      if (type === 'mission_task_created') {
        return title ? ('Added task: ' + title) : humanizeTeamActivityMessage(msg);
      }
      if (type === 'curiosity_momentum_done' || type === 'curiosity_suggestion' || type === 'curiosity_idle_check') {
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
    window.renderAgentMetricsCard = renderAgentMetricsCard;

    window.openMissionWorkInputModal = openMissionWorkInputModal;
    window.patchMissionTaskStatus = patchMissionTaskStatus;
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
    window.runMissionMissionAction = runMissionMissionAction;
    window.removeMissionTask = removeMissionTask;
    window.openSuggestedTaskForTask = openSuggestedTaskForTask;
    window.missionNeedsAttention = missionNeedsAttention;
    window.countBlockedTasksForMission = countBlockedTasksForMission;

    function renderTeamUserInputModal() {
      var modal = document.getElementById('team-user-input-modal');
      var modalOpen = isTeamUserInputModalOpen();
      if (!isTeamMainViewActive()) {
        if (!modalOpen) closeTeamUserInputModal();
        return;
      }
      if (!modal) return;
      var missions = getMissionsNeedingUserInput().filter(function (g) {
        return !teamUserInputDismissed[teamUserInputDismissKey(g)];
      });
      if (modalOpen) {
        if (teamUserInputMissionId) {
          var current = missions.find(function (g) { return String(g.id || '') === teamUserInputMissionId; });
          if (current) return;
        }
        if (!missions.length) return;
        var queued = missions[0];
        if (teamUserInputMissionId === String(queued.id || '')) return;
        openTeamUserInputModal(queued);
        return;
      }
      if (!missions.length) {
        closeTeamUserInputModal();
        return;
      }
      openTeamUserInputModal(missions[0]);
    }

    async function submitTeamUserInputResponse(responseText) {
      if (teamUserInputSubmitBusy || !teamUserInputMissionId) return;
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
        var r = await fetch(API + '/api/missions/' + encodeURIComponent(teamUserInputMissionId) + '/respond', {
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
        await fetchMissionsSnapshot();
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
        var missions = getMissionsNeedingUserInput();
        var mission = missions.find(function (g) { return String(g.id || '') === teamUserInputMissionId; }) || missions[0];
        if (mission) teamUserInputDismissed[teamUserInputDismissKey(mission)] = true;
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
          var missions = getMissionsNeedingUserInput();
          var mission = missions.find(function (g) { return String(g.id || '') === teamUserInputMissionId; }) || missions[0];
          if (mission) teamUserInputDismissed[teamUserInputDismissKey(mission)] = true;
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

    // ── Voice input for team user-input modal ──────────────────────────────
    (function wireTeamMicInput() {
      var micBtn = document.getElementById('team-user-input-mic-btn');
      if (!micBtn) return;

      var mediaRecorder = null;
      var chunks = [];
      var stream = null;
      var audioCtx = null;
      var analyser = null;
      var animFrame = null;
      var isRecording = false;
      var isRecordingRef = false;
      var isStarting = false;
      var isStopping = false;

      var composerEl = document.getElementById('team-user-input-composer');
      var waveformBarsEl = document.getElementById('team-user-input-waveform-bars');
      var waveformWrapEl = document.getElementById('team-user-input-waveform-wrap');

      var waveformBuffer = [];
      var nextBarId = 0;
      var lastBarTime = 0;
      var lastFrameTime = 0;
      var scrollSpeedPixelsPerSecond = 96;
      var barsPerSecond = 15;
      var barInterval = 1000 / barsPerSecond;
      var barWidth = 3;

      function showVoiceError(msg) {
        if (typeof showTeamUserInputModalError === 'function') showTeamUserInputModalError(msg || '');
      }

      function getComposerWidth() {
        if (!waveformWrapEl) return 600;
        return Math.max(waveformWrapEl.clientWidth - 32, 200);
      }

      function renderWaveformBars() {
        if (!waveformBarsEl) return;
        waveformBarsEl.innerHTML = waveformBuffer.map(function (bar) {
          var barHeight = Math.max(bar.amplitude * 324, 2);
          var halfHeight = barHeight / 2;
          return '<div class="team-voice-bar" style="height:' + barHeight + 'px;left:' + bar.x + 'px;top:calc(50% - ' + halfHeight + 'px);"></div>';
        }).join('');
      }

      function clearWaveform() {
        waveformBuffer = [];
        nextBarId = 0;
        lastBarTime = 0;
        if (waveformBarsEl) waveformBarsEl.innerHTML = '';
      }

      function setRecordingState(active) {
        isRecording = active;
        isRecordingRef = active;
        micBtn.classList.toggle('team-mic-btn--recording', active);
        micBtn.setAttribute('aria-label', active ? 'Stop recording' : 'Start voice input');
        micBtn.title = active ? 'Stop recording' : 'Speak your answer';
        if (composerEl) composerEl.classList.toggle('team-user-input-composer--recording', active);
        if (!active) clearWaveform();
      }

      function setTranscribingState(active) {
        micBtn.disabled = active || isStarting;
        micBtn.classList.toggle('team-mic-btn--transcribing', active);
        if (composerEl) composerEl.classList.toggle('team-user-input-composer--transcribing', active);
      }

      function stopStream() {
        isRecordingRef = false;
        if (animFrame) { cancelAnimationFrame(animFrame); animFrame = null; }
        if (audioCtx) { audioCtx.close().catch(function () {}); audioCtx = null; }
        analyser = null;
        if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      }

      function fillTranscribedText(text) {
        var textEl = document.getElementById('team-user-input-modal-text');
        if (!textEl || !text) return false;
        var trimmed = String(text).trim();
        if (!trimmed) return false;
        textEl.value = textEl.value ? textEl.value.trimEnd() + ' ' + trimmed : trimmed;
        textEl.dispatchEvent(new Event('input', { bubbles: true }));
        composerEl && composerEl.classList.remove('team-user-input-composer--recording', 'team-user-input-composer--transcribing');
        textEl.style.opacity = '';
        textEl.style.pointerEvents = '';
        textEl.focus();
        var len = textEl.value.length;
        if (typeof textEl.setSelectionRange === 'function') textEl.setSelectionRange(len, len);
        return true;
      }

      async function transcribeBlob(blob) {
        setTranscribingState(true);
        try {
          var res = await fetch(API + '/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'audio/webm' },
            body: blob,
          });
          var data = await res.json().catch(function () { return {}; });
          if (!res.ok) {
            var errMsg = data.error || data.message || ('Transcription failed (' + res.status + ')');
            if (/invalid_api_key|401|Whisper API key not configured/i.test(String(errMsg))) {
              errMsg = 'Transcription unavailable — run pasture setup to update LLM_1_API_KEY in ~/.pasture/.env, then retry (restart dashboard if it was already running during setup).';
            }
            throw new Error(errMsg);
          }
          return (data.data && data.data.text) || data.text || '';
        } finally {
          setTranscribingState(false);
          micBtn.disabled = false;
        }
      }

      function waitForRecorderStop(recorder) {
        return new Promise(function (resolve) {
          if (!recorder || recorder.state === 'inactive') {
            resolve();
            return;
          }
          var settled = false;
          function done() {
            if (settled) return;
            settled = true;
            resolve();
          }
          recorder.addEventListener('stop', done, { once: true });
          recorder.addEventListener('error', done, { once: true });
          try {
            if (typeof recorder.requestData === 'function') recorder.requestData();
          } catch (_) {}
          try {
            recorder.stop();
          } catch (_) {
            done();
          }
          setTimeout(done, 1500);
        });
      }

      function updateWaveform() {
        if (!analyser || !isRecordingRef) return;

        var currentTime = performance.now();
        var deltaTime = lastFrameTime ? (currentTime - lastFrameTime) / 1000 : 0;
        lastFrameTime = currentTime;
        var scrollDelta = scrollSpeedPixelsPerSecond * deltaTime;

        var bufferLength = analyser.fftSize;
        var dataArray = new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(dataArray);

        var startSample = Math.floor(bufferLength * 0.3);
        var endSample = Math.floor(bufferLength * 0.7);
        var sumSquares = 0;
        var count = 0;
        for (var i = startSample; i < endSample; i += 5) {
          var normalized = (dataArray[i] - 128) / 128;
          sumSquares += normalized * normalized;
          count++;
        }
        var rms = Math.sqrt(sumSquares / Math.max(count, 1));
        var amplitude = rms;
        var noiseGateThreshold = 0.04;
        var voiceThreshold = 0.03;
        if (amplitude < noiseGateThreshold) {
          amplitude = 0;
        } else if (amplitude >= voiceThreshold) {
          amplitude = amplitude * 0.6;
        } else {
          amplitude = (amplitude - noiseGateThreshold) * 0.5;
        }
        var normalizedAmplitude = Math.abs(amplitude);
        var now = Date.now();
        var containerWidth = getComposerWidth();

        waveformBuffer = waveformBuffer
          .map(function (bar) { return { id: bar.id, amplitude: bar.amplitude, x: bar.x - scrollDelta }; })
          .filter(function (bar) { return bar.x > -barWidth; });

        if (now - lastBarTime >= barInterval) {
          waveformBuffer.push({
            id: nextBarId++,
            amplitude: normalizedAmplitude,
            x: containerWidth,
          });
          lastBarTime = now;
        }

        renderWaveformBars();
        animFrame = requestAnimationFrame(updateWaveform);
      }

      async function finalizeRecording() {
        var recorder = mediaRecorder;
        mediaRecorder = null;
        await waitForRecorderStop(recorder);
        stopStream();
        setRecordingState(false);

        var blob = new Blob(chunks, { type: 'audio/webm' });
        chunks = [];
        if (!blob.size) {
          showVoiceError('No audio captured. Hold the mic a moment and speak before stopping.');
          return;
        }
        try {
          var text = await transcribeBlob(blob);
          if (!fillTranscribedText(text)) {
            showVoiceError('No speech detected. Try again.');
            return;
          }
          showVoiceError('');
        } catch (err) {
          showVoiceError('Voice input: ' + (err.message || 'Failed to transcribe.'));
        }
      }

      async function startRecording() {
        if (isRecording || isStarting || isStopping) return;
        isStarting = true;
        micBtn.disabled = true;
        showVoiceError('');

        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
          alert('Could not access microphone. Please check your browser permissions.');
          return;
        } finally {
          isStarting = false;
          if (!isRecording) micBtn.disabled = false;
        }

        try {
          audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          if (audioCtx.state === 'suspended') await audioCtx.resume();
          analyser = audioCtx.createAnalyser();
          analyser.fftSize = 2048;
          analyser.smoothingTimeConstant = 0.3;
          var src = audioCtx.createMediaStreamSource(stream);
          src.connect(analyser);
          clearWaveform();
          lastFrameTime = 0;
          isRecordingRef = true;
          updateWaveform();
        } catch (_) {}

        var mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : (MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '');
        mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType: mimeType }) : new MediaRecorder(stream);
        chunks = [];

        mediaRecorder.ondataavailable = function (e) {
          if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        mediaRecorder.onerror = function () {
          if (!isStopping) stopRecording();
        };

        try {
          mediaRecorder.start(250);
        } catch (err) {
          stopStream();
          showVoiceError('Could not start recording: ' + (err.message || String(err)));
          return;
        }
        setRecordingState(true);
        micBtn.disabled = false;
      }

      function stopRecording() {
        if (!isRecording || isStopping) return;
        isStopping = true;
        isRecording = false;
        isRecordingRef = false;
        setRecordingState(false);
        setTranscribingState(true);
        finalizeRecording().finally(function () {
          isStopping = false;
        });
      }

      micBtn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (isRecording || micBtn.classList.contains('team-mic-btn--recording')) stopRecording();
        else startRecording();
      });
    })();
    // ── End voice input ────────────────────────────────────────────────────

    async function fetchSuggestedTasksSnapshot() {
      try {
        var r = await fetch(API + '/api/suggestedTasks');
        if (!r.ok) return;
        var d = await r.json().catch(function () { return {}; });
        teamSuggestedTasksSnapshot = {
          suggestedTasks: Array.isArray(d.suggestedTasks) ? d.suggestedTasks : [],
          updatedAt: Number(d.updatedAt) || 0,
        };
      } catch (_) {}
      renderSuggestedTasksList();
      renderMissionsList();
    }

    function startTeamActivityFeed() {
      if (teamActivityPollTimer) return;
      fetchTeamActivityFeed();
      fetchTeamContextFeed();
      fetchTeamMetricsFeed();
      fetchMissionsSnapshot();
      fetchSuggestedTasksSnapshot();
      fetchLlmUsage();
      if (typeof fetchMc2PendingApprovals === 'function') fetchMc2PendingApprovals();
      teamActivityPollTimer = setInterval(function () {
        fetchTeamActivityFeed();
        fetchTeamContextFeed();
        fetchTeamMetricsFeed();
        fetchMissionsSnapshot();
        fetchSuggestedTasksSnapshot();
        fetchLlmUsage();
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
        if (btn.closest('#page-team')) return;
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
    var teamTopTabMissionsEl = document.getElementById('team-top-tab-missions');
    if (teamTopTabRosterEl) {
      teamTopTabRosterEl.addEventListener('click', function () { setTeamTopTab('roster'); });
    }
    if (teamTopTabMissionsEl) {
      teamTopTabMissionsEl.addEventListener('click', function () { setTeamTopTab('missions'); });
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

    var teamMissionsRefreshEl = document.getElementById('team-missions-refresh');
    if (teamMissionsRefreshEl) {
      teamMissionsRefreshEl.addEventListener('click', function () { fetchMissionsSnapshot(); });
    }

    (function wireMissionDeleteButton() {
      var deleteBtn = document.getElementById('team-mission-delete-btn');
      var modal = document.getElementById('team-mission-delete-modal');
      var cancelBtn = document.getElementById('team-mission-delete-cancel');
      var confirmBtn = document.getElementById('team-mission-delete-confirm');
      var descEl = document.getElementById('team-mission-delete-desc');
      var itemsEl = document.getElementById('team-mission-delete-items');
      if (!deleteBtn || !modal) return;

      function showDeleteModal(mission) {
        if (!mission) return;
        var taskCount = countMissionTasks(mission.tasks || []);
        var suggestedCount = (Array.isArray(teamSuggestedTasksSnapshot.suggestedTasks)
          ? teamSuggestedTasksSnapshot.suggestedTasks
          : []).filter(function (t) {
            var ids = Array.isArray(t.relatedMissionIds) ? t.relatedMissionIds : [];
            return ids.indexOf(String(mission.id || '')) >= 0;
          }).length;
        descEl.textContent = 'You are about to permanently delete "' + escapeHtml(mission.title || 'Untitled mission') + '". This cannot be undone.';
        itemsEl.innerHTML = [
          '<li><strong>Mission record</strong> — all objectives, progress, plan steps, and history</li>',
          taskCount > 0 ? '<li><strong>' + taskCount + ' task' + (taskCount === 1 ? '' : 's') + '</strong> embedded in this mission (including any delegated tasks)</li>' : '',
          '<li><strong>Mission memory</strong> — the persistent memory log (memory.md) for this mission</li>',
          suggestedCount > 0 ? '<li><strong>' + suggestedCount + ' AI suggested task' + (suggestedCount === 1 ? '' : 's') + '</strong> linked exclusively to this mission</li>' : '',
          '<li><strong>Activity log entries older than today</strong> — pruned from the inbox/outbox history</li>',
        ].filter(Boolean).join('');
        modal.dataset.pendingMissionId = String(mission.id || '');
        modal.style.display = 'flex';
        confirmBtn.disabled = false;
      }

      deleteBtn.addEventListener('click', function () {
        var missions = Array.isArray(teamMissionsSnapshot.missions) ? teamMissionsSnapshot.missions : [];
        var mission = missions.find(function (g) { return String(g.id || '') === selectedTeamMissionId; });
        if (!mission) { alert('Select a mission first.'); return; }
        showDeleteModal(mission);
      });

      cancelBtn && cancelBtn.addEventListener('click', function () {
        modal.style.display = 'none';
        delete modal.dataset.pendingMissionId;
      });

      modal.addEventListener('click', function (e) {
        if (e.target === modal) {
          modal.style.display = 'none';
          delete modal.dataset.pendingMissionId;
        }
      });

      confirmBtn && confirmBtn.addEventListener('click', async function () {
        var id = modal.dataset.pendingMissionId;
        if (!id) return;
        confirmBtn.disabled = true;
        confirmBtn.textContent = 'Deleting…';
        try {
          var resp = await fetch(API + '/api/missions/' + encodeURIComponent(id), { method: 'DELETE' });
          if (resp.ok) {
            modal.style.display = 'none';
            delete modal.dataset.pendingMissionId;
            selectedTeamMissionId = '';
            await fetchMissionsSnapshot();
            await fetchSuggestedTasksSnapshot();
          } else {
            var body = await resp.json().catch(function () { return {}; });
            alert('Delete failed: ' + (body.error || resp.status));
          }
        } catch (err) {
          alert('Delete failed: ' + String(err && err.message || err));
        }
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Delete permanently';
      });
    }());
    var teamSuggestedTasksRefreshEl = document.getElementById('team-suggestedTasks-refresh');
    if (teamSuggestedTasksRefreshEl) {
      teamSuggestedTasksRefreshEl.addEventListener('click', function () { fetchSuggestedTasksSnapshot(); });
    }
    var mc2SuggestedTasksRefreshEl = document.getElementById('mc2-suggestedTasks-refresh');
    if (mc2SuggestedTasksRefreshEl) {
      mc2SuggestedTasksRefreshEl.addEventListener('click', function () { fetchSuggestedTasksSnapshot(); });
    }
    var teamMissionCreateEl = document.getElementById('team-mission-create');
    if (teamMissionCreateEl) {
      teamMissionCreateEl.addEventListener('click', async function () {
        var titleEl = document.getElementById('team-mission-title');
        var objectiveEl = document.getElementById('team-mission-objective');
        var ownerEl = document.getElementById('team-mission-owner');
        var title = titleEl ? String(titleEl.value || '').trim() : '';
        var objective = objectiveEl ? String(objectiveEl.value || '').trim() : '';
        var ownerAgentId = ownerEl ? String(ownerEl.value || '').trim() : 'main';
        if (!objective) {
          if (objectiveEl) objectiveEl.focus();
          return;
        }
        teamMissionCreateEl.disabled = true;
        try {
          var resp = await fetch(API + '/api/missions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: title, objective: objective, ownerAgentId: ownerAgentId }),
          });
          if (resp.ok) {
            if (titleEl) titleEl.value = '';
            if (objectiveEl) objectiveEl.value = '';
            await fetchMissionsSnapshot();
            setTeamTopTab('missions');
          }
        } catch (_) {}
        teamMissionCreateEl.disabled = false;
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
