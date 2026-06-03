function mc2BindTimelineScrollSpy(viewEl) {
      if (!viewEl) return;
      viewEl.addEventListener('scroll', function () {
        if (mc2TimelineScrollRaf) return;
        mc2TimelineScrollRaf = requestAnimationFrame(function () {
          mc2TimelineScrollRaf = 0;
          mc2SyncTimelineHighlightForScroll();
        });
      }, { passive: true });
    }
    mc2BindTimelineScrollSpy(document.getElementById('mc2-view-activity'));
    mc2BindTimelineScrollSpy(document.getElementById('mc2-view-context'));
    try {
      wireClick('agent-create-modal-cancel', closeAgentCreateModal);
      wireClick('agent-create-modal-submit', function () { submitAgentCreateModal(true); });
      var agentCreateModal = document.getElementById('agent-create-modal');
      if (agentCreateModal) {
        agentCreateModal.addEventListener('click', function (e) {
          if (e.target && e.target.id === 'agent-create-modal') closeAgentCreateModal();
        });
      }
      var agentCreateCard = document.querySelector('#agent-create-modal .modal-card');
      if (agentCreateCard) {
        agentCreateCard.addEventListener('click', function (e) { e.stopPropagation(); });
      }
      var agentCreateTitleInput = document.getElementById('agent-create-modal-title-input');
      if (agentCreateTitleInput) {
        agentCreateTitleInput.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            submitAgentCreateModal(true);
          }
        });
      }
      wireClick('agent-edit-modal-cancel', closeAgentEditModal);
      wireClick('agent-edit-modal-submit', submitAgentEditModal);
      wireClick('agent-edit-modal-md-save', async function () {
        var agentId = agentEditorState.modal.agentId;
        if (!agentId || !agentEditorState.modal.mdFile) return;
        showAgentEditorError('', 'modal');
        try {
          await saveAgentEditorMdFile(agentId, 'modal');
        } catch (err) {
          showAgentEditorError(err.message || String(err), 'modal');
        }
      });
      wireClick('team-agent-back', function () { location.hash = '#team'; });
      wireClick('team-agent-save', submitTeamAgentPage);
      wireClick('team-agent-md-save', async function () {
        var agentId = agentEditorState.page.agentId;
        if (!agentId || !agentEditorState.page.mdFile) return;
        showAgentEditorError('', 'page');
        try {
          await saveAgentEditorMdFile(agentId, 'page');
        } catch (err) {
          showAgentEditorError(err.message || String(err), 'page');
        }
      });
      var agentEditModal = document.getElementById('agent-edit-modal');
      if (agentEditModal) {
        agentEditModal.addEventListener('click', function (e) {
          if (e.target && e.target.id === 'agent-edit-modal') closeAgentEditModal();
        });
      }
      var agentEditCard = document.querySelector('#agent-edit-modal .modal-card');
      if (agentEditCard) {
        agentEditCard.addEventListener('click', function (e) { e.stopPropagation(); });
      }
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && agentEditModalOpen) closeAgentEditModal();
        else if (e.key === 'Escape' && agentCreateModalOpen) closeAgentCreateModal();
        else if (e.key === 'Escape' && teamPageFullscreen) setTeamPageFullscreen(false);
      });
      wireClick('chat-new-btn', function () {
        closeChatHistory();
        saveCurrentSession();
        currentSessionId = newSessionId();
        chatMessages = [];
        chatMessagesByAgent[selectedChatAgentId] = [];
        renderChatMessages();
        var chatInput = document.getElementById('chat-input');
        if (chatInput) chatInput.focus();
      });
      wireClick('chat-history-btn', function (e) {
        e.stopPropagation();
        toggleChatHistory();
      });
      document.addEventListener('click', function (e) {
        var panel = document.getElementById('chat-history-panel');
        var btn = document.getElementById('chat-history-btn');
        if (panel && panel.classList.contains('open') && !panel.contains(e.target) && e.target !== btn) {
          closeChatHistory();
        }
      });
    } catch (err) {
      console.error('[dashboard] modal/chat bind failed:', err);
    }

    if (typeof fetchChatAgents === 'function') fetchChatAgents();
    (function () {
      AGENT_MAP_PREFIXES.forEach(function (mapConfig) {
        var canvas = document.getElementById(mapConfig.prefix + '-canvas');
        if (!canvas || typeof ResizeObserver === 'undefined') return;
        var prefix = mapConfig.prefix;
        var redrawTimer;
        new ResizeObserver(function () {
          clearTimeout(redrawTimer);
          redrawTimer = setTimeout(function () {
            fitAgentMapToContainer(prefix);
            var layout = agentMapLastLayouts[prefix];
            if (layout) drawAgentMapArrows(agentMapData, layout, agentMapEls(prefix), prefix === 'agent-map' ? 'agent' : 'team');
          }, 80);
        }).observe(canvas);
      });
    })();
