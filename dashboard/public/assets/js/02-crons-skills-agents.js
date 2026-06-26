function renderCronsTable(rows, emptyText, opts) {
      opts = opts || {};
      if (!rows.length) return '<p class="empty">' + escapeHtml(emptyText) + '</p>';
function renderSystemCronVariant(row) {
            var expr = row.expr || row.schedule || '—';
            var enabled = row.enabled !== false;
            var scheduleHuman = row.scheduleHuman || expr;
            var tech = Array.isArray(row.technicalDetails) ? row.technicalDetails : [];
            var variantTech = tech.filter(function (line) {
              return !/^Path:\s/i.test(line);
            });
            var techHtml = '<div class="crons-system-tech crons-system-tech-variant">' +
              '<span class="crons-system-tech-line">Cron: <code>' + escapeHtml(expr) + '</code></span>' +
              variantTech.map(function (line) {
                return '<span class="crons-system-tech-line">' + escapeHtml(line) + '</span>';
              }).join('') +
              '</div>';
            return '<div class="crons-system-variant' + (enabled ? '' : ' crons-system-variant-off') + '">' +
              '<div class="crons-system-meta-line crons-system-variant-meta">' +
              '<span class="badge ' + (enabled ? 'enabled' : 'disabled') + '">' + (enabled ? 'On' : 'Off') + '</span>' +
              '<span class="crons-system-meta-sep">·</span>' +
              '<span class="crons-system-schedule">' + escapeHtml(scheduleHuman) + '</span>' +
              '</div>' +
              techHtml +
              '</div>';
          }

          function renderSystemCronGroup(group) {
            var entries = group.entries || [];
            var primary = group.primary || entries[0] || {};
            var name = primary.name || 'Cron job';
            var purpose = primary.purpose || primary.description || '';
            var err = primary.descriptionError || '';
            var scriptLabel = primary.scriptLabel || '—';
            var sharedTech = Array.isArray(primary.technicalDetails)
              ? primary.technicalDetails.filter(function (line) { return /^Path:\s/i.test(line); })
              : [];
            var countLabel = entries.length > 1 ? ('<span class="crons-system-count">' + entries.length + ' schedules</span>') : '';
            var groupOff = entries.every(function (e) { return e.enabled === false; });
            var variantsHtml = entries.length > 1
              ? ('<div class="crons-system-variants">' + entries.map(renderSystemCronVariant).join('') + '</div>')
              : renderSystemCronVariant(entries[0] || primary);
            return '<div class="crons-system-group' + (groupOff ? ' crons-system-group-off' : '') + '">' +
              '<div class="crons-system-name">' + escapeHtml(name) + countLabel + '</div>' +
              (purpose ? '<p class="crons-system-purpose">' + escapeHtml(purpose) + '</p>' : '') +
              (err && !purpose ? '<p class="crons-system-purpose crons-system-purpose-muted">' + escapeHtml(err) + '</p>' : '') +
              '<code class="crons-system-script">' + escapeHtml(scriptLabel) + '</code>' +
              (sharedTech.length ? ('<div class="crons-system-tech crons-system-tech-shared">' +
                sharedTech.map(function (line) {
                  return '<span class="crons-system-tech-line">' + escapeHtml(line) + '</span>';
                }).join('') +
                '</div>') : '') +
              variantsHtml +
              '</div>';
          }

          function systemCronGroupKey(row) {
            return String(row.scriptPath || row.scriptLabel || row.command || row.id || '').trim().toLowerCase();
          }

          function groupSystemCrons(rows) {
            var map = new Map();
            rows.forEach(function (row) {
              var key = systemCronGroupKey(row);
              if (!map.has(key)) map.set(key, []);
              map.get(key).push(row);
            });
            return Array.from(map.values()).map(function (entries) {
              var sorted = entries.slice().sort(function (a, b) {
                if (!!a.enabled !== !!b.enabled) return a.enabled ? -1 : 1;
                return String(a.expr || '').localeCompare(String(b.expr || ''));
              });
              var primary = sorted.find(function (e) { return e.purpose; })
                || sorted.find(function (e) { return e.enabled; })
                || sorted[0];
              return { entries: sorted, primary: primary };
            }).sort(function (a, b) {
              var aOn = a.entries.some(function (e) { return e.enabled; });
              var bOn = b.entries.some(function (e) { return e.enabled; });
              if (aOn !== bOn) return aOn ? -1 : 1;
              return String(a.primary.name || '').localeCompare(String(b.primary.name || ''));
            });
          }

      if (opts.system) {
        var groups = groupSystemCrons(rows);
        return '<div class="crons-system-list">' +
          groups.map(renderSystemCronGroup).join('') +
          '</div>';
      }
      return '<table class="crons-table"><thead><tr><th>Name</th><th>Enabled</th><th>Schedule</th><th>Detail</th></tr></thead><tbody>' +
        rows.map(function (row) {
          return '<tr><td>' + escapeHtml(row.name || row.id || '—') + '</td><td><span class="badge ' + (row.enabled ? 'enabled' : 'disabled') + '">' + (row.enabled ? 'On' : 'Off') + '</span></td><td><code class="crons-expr">' + escapeHtml(row.schedule || row.expr || '—') + '</code></td><td>' + escapeHtml(row.detail || row.message || '—') + '</td></tr>';
        }).join('') + '</tbody></table>';
    }

    async function fetchCrons() {
      const r = await fetch(API + '/api/crons');
      const d = await r.json();
      const scheduledEl = document.getElementById('crons-scheduled-list');
      const systemEl = document.getElementById('crons-system-list');
      if (!scheduledEl || !systemEl) return;
      const jobs = d.jobs || [];
      const scheduledRows = jobs.map(function (j) {
        const s = j.schedule || {};
        const sched = s.kind === 'cron' ? (s.expr || '') : (s.at || '');
        return {
          id: j.id,
          name: j.name || j.id,
          enabled: j.enabled !== false,
          schedule: sched,
          detail: (j.message || '').slice(0, 80) + (j.message && j.message.length > 80 ? '…' : ''),
        };
      });
      scheduledEl.innerHTML = renderCronsTable(scheduledRows, 'No scheduled crons.');
      const systemRows = Array.isArray(d.system) ? d.system : [];
      var crontab = d.crontab || {};
      var metaEl = document.getElementById('crons-system-meta');
      if (metaEl) {
        if (crontab.skillRequired) {
          metaEl.hidden = false;
          metaEl.textContent = crontab.error || ('Enable the ' + crontab.skillRequired + ' skill on the Skills page.');
        } else if (crontab.error) {
          metaEl.hidden = false;
          metaEl.textContent = 'Could not read crontab: ' + crontab.error;
        } else if (crontab.user) {
          metaEl.hidden = false;
          metaEl.textContent = 'User: ' + crontab.user + ' (crontab -l)';
        } else {
          metaEl.hidden = true;
          metaEl.textContent = '';
        }
      }
      var systemEmpty = crontab && crontab.skillRequired
        ? (crontab.error || 'Enable the read skill to view system crontab.')
        : crontab && crontab.error
        ? 'Could not read crontab — ' + crontab.error
        : 'No entries in crontab -l (empty or comments only).';
      systemEl.innerHTML = renderCronsTable(systemRows, systemEmpty, { system: true });
    }

    function escapeHtml(s) {
      const div = document.createElement('div');
      div.textContent = s;
      return div.innerHTML;
    }

    let skillsDirty = false;
    let currentEnabled = [];

    let currentSkillId = null;

    async function fetchSkills() {
      const r = await fetch(API + '/api/skills');
      const d = await r.json();
      currentEnabled = d.enabled || [];
      const list = d.skills || [];
      const el = document.getElementById('skills-list');
      el.innerHTML = list.map(s => {
        const checked = currentEnabled.includes(s.id) ? ' checked' : '';
        const desc = (s.description || '').trim();
        const descHtml = desc ? '<div class="skill-desc">' + escapeHtml(desc) + '</div>' : '';
        const cs = s.configStatus;
        const configBadge = cs === 'ok' ? '<span class="skill-config-badge ok" title="Credentials configured">configured</span>'
          : cs === 'ok-legacy' ? '<span class="skill-config-badge ok-legacy" title="Token found in config.json — move to secrets.json for better security">token in config</span>'
          : cs === 'missing' ? '<span class="skill-config-badge missing" title="Credentials not set — see SKILL.md for setup">needs setup</span>'
          : cs === 'unchecked' ? '<span class="skill-config-badge unchecked" title="Uses gog CLI auth — run \'gog auth\' if not yet authenticated">gog auth</span>'
          : '';
        return '<div class="skill-item"><div class="skill-row" data-id="' + escapeHtml(s.id) + '"><div><span class="skill-id">' + escapeHtml(s.id) + '</span>' + configBadge + descHtml + '</div><label onclick="event.stopPropagation()"><input type="checkbox" data-id="' + escapeHtml(s.id) + '"' + checked + '> Enabled</label></div>' +
          '<div class="skill-doc-inline" data-id="' + escapeHtml(s.id) + '"><h3>Doc: ' + escapeHtml(s.id) + '</h3><p class="skill-meta skill-doc-desc" style="margin:0 0 0.5rem 0;"></p><textarea class="skill-doc-textarea" spellcheck="false"></textarea><div style="margin-top:0.75rem;"><button class="skill-doc-save-btn">Save doc</button><span class="skill-doc-saved" style="margin-left:0.75rem; color: var(--green); font-size:0.85rem; display:none;">Saved.</span></div></div></div>';
      }).join('');
      el.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.addEventListener('change', () => { skillsDirty = true; document.getElementById('skills-save').style.display = 'block'; });
      });
      el.querySelectorAll('.skill-row').forEach(row => {
        row.addEventListener('click', (e) => { if (!e.target.closest('label')) openSkillDoc(row.dataset.id, row.closest('.skill-item')); });
      });
      el.querySelectorAll('.skill-doc-save-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const panel = btn.closest('.skill-doc-inline');
          const id = panel && panel.dataset.id;
          if (!id) return;
          const content = panel.querySelector('.skill-doc-textarea').value;
          const r = await fetch(API + '/api/skills/' + encodeURIComponent(id) + '/doc', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content }) });
          if (r.ok) {
            const savedEl = panel.querySelector('.skill-doc-saved');
            if (savedEl) { savedEl.style.display = 'inline'; setTimeout(() => { savedEl.style.display = 'none'; }, 2000); }
          }
        });
      });
      document.getElementById('skills-save').style.display = 'none';
      skillsDirty = false;
    }

    async function openSkillDoc(id, skillItem) {
      currentSkillId = id;
      const listEl = document.getElementById('skills-list');
      listEl.querySelectorAll('.skill-doc-inline').forEach(p => p.classList.remove('open'));
      const panel = skillItem ? skillItem.querySelector('.skill-doc-inline') : listEl.querySelector('.skill-doc-inline[data-id="' + id + '"]');
      if (!panel) return;
      const r = await fetch(API + '/api/skills/' + encodeURIComponent(id) + '/doc');
      if (!r.ok) return;
      const d = await r.json();
      panel.querySelector('.skill-doc-desc').textContent = d.description || '';
      panel.querySelector('.skill-doc-textarea').value = d.content || '';
      panel.classList.add('open');
    }

    wireEl('skills-save', 'click', async () => {
      const boxes = document.querySelectorAll('#skills-list input[type="checkbox"]:checked');
      const enabled = Array.from(boxes).map(b => b.dataset.id);
      const r = await fetch(API + '/api/skills', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
      if (r.ok) { skillsDirty = false; document.getElementById('skills-save').style.display = 'none'; }
    });

    var selectedAgentId = 'main';
    var selectedAgentMdFile = null;
    var agentSkillsDirty = false;

    async function fetchAgentsPage() {
      var r = await fetch(API + '/api/agents');
      var d = await r.json();
      var list = d.agents || [];
      if (!list.some(function (a) { return a.id === selectedAgentId; })) selectedAgentId = list.length ? list[0].id : 'main';
      var ul = document.getElementById('agents-list');
      if (!ul) return;
      ul.innerHTML = list.map(function (a) {
        var selected = a.id === selectedAgentId ? 'selected' : '';
        return '<li class="' + selected + '"><button type="button" class="link" data-agent-id="' + escapeHtml(a.id) + '">' + escapeHtml(a.id) + '</button></li>';
      }).join('');
      ul.querySelectorAll('button[data-agent-id]').forEach(function (btn) {
        btn.addEventListener('click', function () { selectAgent(btn.getAttribute('data-agent-id')); });
      });
      if (selectedAgentId) await selectAgent(selectedAgentId);
    }

    async function selectAgent(agentId) {
      selectedAgentId = agentId || 'main';
      document.querySelectorAll('#agents-list li').forEach(function (li) {
        var b = li.querySelector('button[data-agent-id]');
        li.classList.toggle('selected', b && b.getAttribute('data-agent-id') === selectedAgentId);
      });
      document.getElementById('agent-detail-title').textContent = 'Agent: ' + selectedAgentId;
      document.getElementById('agent-detail-meta').textContent = selectedAgentId === 'main'
        ? 'Default agent created automatically.'
        : 'Custom agent for routing specific groups/chats.';
      var delBtn = document.getElementById('agent-delete-btn');
      if (delBtn) {
        delBtn.disabled = selectedAgentId === 'main';
        delBtn.title = selectedAgentId === 'main' ? 'Default main agent cannot be deleted' : '';
      }
      await loadAgentSkills(selectedAgentId);
      await loadAgentMdFiles(selectedAgentId);
    }

    async function loadAgentSkills(agentId) {
      var all = await fetch(API + '/api/skills').then(function (r) { return r.json(); });
      var cfg = await fetch(API + '/api/agents/' + encodeURIComponent(agentId) + '/config').then(function (r) { return r.json(); });
      var enabled = (cfg.skills && Array.isArray(cfg.skills.enabled)) ? cfg.skills.enabled : (all.enabled || []);
      var list = all.skills || [];
      var el = document.getElementById('agent-skills-list');
      el.innerHTML = list.map(function (s) {
        var checked = enabled.includes(s.id) ? ' checked' : '';
        return '<div class="skill-item"><div class="skill-row"><div><span class="skill-id">' + escapeHtml(s.id) + '</span><div class="skill-desc">' + escapeHtml((s.description || '').trim()) + '</div></div><label><input type="checkbox" data-agent-skill="' + escapeHtml(s.id) + '"' + checked + '> Enabled</label></div></div>';
      }).join('');
      el.querySelectorAll('input[data-agent-skill]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          agentSkillsDirty = true;
          document.getElementById('agent-skills-save').style.display = 'inline-block';
        });
      });
      document.getElementById('agent-skills-save').style.display = 'none';
      agentSkillsDirty = false;
    }

    async function loadAgentMdFiles(agentId) {
      var r = await fetch(API + '/api/agents/' + encodeURIComponent(agentId) + '/md');
      var d = await r.json();
      var files = d.files || [];
      var filesEl = document.getElementById('agent-md-files');
      filesEl.innerHTML = files.map(function (f) {
        return '<button type="button" class="agent-md-btn" data-agent-file="' + escapeHtml(f.id) + '" style="background:var(--card); border:1px solid var(--border); color:var(--muted); font:inherit; font-size:0.85rem; padding:0.35rem 0.75rem; border-radius:4px; cursor:pointer; margin-top:0;">' + escapeHtml(f.label) + '</button>';
      }).join('');
      filesEl.querySelectorAll('.agent-md-btn').forEach(function (btn) {
        btn.addEventListener('click', function () { selectAgentMdFile(agentId, btn.getAttribute('data-agent-file')); });
      });
      if (files.length > 0) await selectAgentMdFile(agentId, files[0].id);
    }

    async function selectAgentMdFile(agentId, fileId) {
      selectedAgentMdFile = fileId;
      document.querySelectorAll('.agent-md-btn').forEach(function (btn) {
        var active = btn.getAttribute('data-agent-file') === fileId;
        btn.style.color = active ? 'var(--accent)' : 'var(--muted)';
        btn.style.borderColor = active ? 'var(--accent)' : 'var(--border)';
      });
      document.getElementById('agent-md-editor').style.display = 'block';
      document.getElementById('agent-md-label').textContent = 'Agent file: ' + fileId;
      var r = await fetch(API + '/api/agents/' + encodeURIComponent(agentId) + '/md/' + encodeURIComponent(fileId));
      var d = await r.json();
      document.getElementById('agent-md-textarea').value = d.content || '';
    }

    function normalizeAgentIdInput(raw) {
      return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    }

    async function createAgentViaApi(name, fromAgentId, title) {
      var body = { id: name };
      if (fromAgentId) body.fromAgentId = fromAgentId;
      if (title && String(title).trim()) body.title = String(title).trim();
      var r = await fetch(API + '/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) {
        throw new Error(d.error || ('Create failed (' + r.status + ')'));
      }
      return d;
    }

    function agentDisplayLabel(a) {
      var id = String((a && a.id) || 'main');
      var title = (a && a.title) ? String(a.title).trim() : '';
      return title ? title + ' (' + id + ')' : id;
    }

    function agentCardShortName(a) {
      var title = (a && a.title) ? String(a.title).trim() : '';
      if (title) return title;
      var id = String((a && a.id) || 'main');
      return id.charAt(0).toUpperCase() + id.slice(1);
    }

    function getStateEmoji(state) {
      return formatAgentStateDisplay(state).text.split(' ')[0] || '⚪';
    }

    function getStateTextLabel(state) {
      var text = formatAgentStateDisplay(state).text;
      var sp = text.indexOf(' ');
      return sp >= 0 ? text.slice(sp + 1) : text;
    }

    function agentCardActiveCount(ctx, metrics) {
      var active = Number(metrics && metrics.activeTasks);
      if (Number.isFinite(active) && active > 0) return active;
      var s = String((ctx && ctx.state) || 'idle').toLowerCase();
      if (s === 'blocked') s = 'waiting';
      return (s === 'working' || s === 'waiting') ? 1 : 0;
    }

    function isAgentContextActive(agentId) {
      var ctx = (teamAgentContextSnapshot.agents || {})[String(agentId || '').trim()] || { state: 'idle' };
      var s = String(ctx.state || 'idle').toLowerCase();
      if (s === 'blocked') s = 'waiting';
      return s !== 'idle';
    }

    function getTeamAgentsForView(agents) {
      var list = Array.isArray(agents) ? agents.slice() : [];
      if (!teamViewActiveOnly) return list;
      return list.filter(function (a) { return isAgentContextActive(a && a.id); });
    }

    function setTeamViewActiveOnly(enabled) {
      teamViewActiveOnly = !!enabled;
      var input = document.getElementById('team-view-active-only');
      if (input) input.checked = teamViewActiveOnly;
      renderTeamAgentCards();
      renderAgentMapForPrefix({ prefix: 'team-map', mode: 'edit-page' });
      renderAgentContextOverview();
    }

    var agentCreateModalOpen = false;

    async function populateAgentCreateFromSelect(preselectId) {
      var select = document.getElementById('agent-create-modal-from');
      if (!select) return;
      try {
        var r = await fetch(API + '/api/agents');
        var d = await r.json();
        var agents = Array.isArray(d.agents) ? d.agents : [{ id: 'main' }];
        var nonMain = agents.find(function(a) { return String(a.id) !== 'main'; });
        var preferred = preselectId
          || (selectedChatAgentId !== 'main' ? selectedChatAgentId : null)
          || (nonMain ? nonMain.id : null)
          || 'main';
        select.innerHTML = agents.map(function (a) {
          var id = String(a.id || 'main');
          var selected = id === preferred ? ' selected' : '';
          return '<option value="' + escapeHtml(id) + '"' + selected + '>' + escapeHtml(agentDisplayLabel(a)) + '</option>';
        }).join('');
      } catch (_) {
        select.innerHTML = '<option value="main" selected>main</option>';
      }
    }

    function showAgentCreateModalError(msg) {
      var el = document.getElementById('agent-create-modal-error');
      if (!el) return;
      if (msg) {
        el.textContent = msg;
        el.classList.add('visible');
      } else {
        el.textContent = '';
        el.classList.remove('visible');
      }
    }

    async function openAgentCreateModal(opts) {
      opts = opts || {};
      var modal = document.getElementById('agent-create-modal');
      var titleInput = document.getElementById('agent-create-modal-title-input');
      if (!modal || !titleInput) return;
      showAgentCreateModalError('');
      titleInput.value = '';
      await populateAgentCreateFromSelect(opts.fromAgentId);
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      agentCreateModalOpen = true;
      setTimeout(function () { titleInput.focus(); }, 0);
    }

    function closeAgentCreateModal() {
      var modal = document.getElementById('agent-create-modal');
      if (!modal) return;
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      agentCreateModalOpen = false;
      showAgentCreateModalError('');
    }

    async function submitAgentCreateModal(switchChatToNew) {
      var titleInput = document.getElementById('agent-create-modal-title-input');
      var fromSelect = document.getElementById('agent-create-modal-from');
      var submitBtn = document.getElementById('agent-create-modal-submit');
      if (!titleInput || !fromSelect) return;
      var title = titleInput.value.trim();
      if (!title) {
        showAgentCreateModalError('Enter a name for the agent.');
        titleInput.focus();
        return;
      }
      var normalized = normalizeAgentIdInput(title);
      if (!normalized) {
        showAgentCreateModalError('Name must contain at least one letter or number.');
        titleInput.focus();
        return;
      }
      if (normalized === 'main') {
        showAgentCreateModalError('"main" is reserved. Choose a different name.');
        titleInput.focus();
        return;
      }
      var fromAgentId = (fromSelect.value || 'main').trim() || 'main';
      if (submitBtn) submitBtn.disabled = true;
      showAgentCreateModalError('');
      try {
        var d = await createAgentViaApi(normalized, fromAgentId, title);
        closeAgentCreateModal();
        selectedAgentId = d.id || normalized;
        if (switchChatToNew) selectedChatAgentId = d.id || normalized;
        await fetchAgentsPage();
        await fetchChatAgents();
        if (switchChatToNew) setChatAgent(selectedChatAgentId);
      } catch (err) {
        showAgentCreateModalError(err.message || String(err));
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    }

    var agentEditModalOpen = false;
    var agentEditorState = {
      modal: { agentId: '', mdFile: '', mdDirty: false, llmModels: [] },
      page: { agentId: '', mdFile: '', mdDirty: false, llmModels: [] },
    };

    function formatLlmModelLabel(model, index) {
      var provider = String((model && model.provider) || ('Model ' + (index + 1))).trim();
      var modelName = String((model && model.model) || '').trim();
      if (modelName && modelName.toLowerCase() !== provider.toLowerCase()) return provider + ' · ' + modelName;
      return provider;
    }

    function findLlmPriorityModelIndex(models) {
      if (!Array.isArray(models) || !models.length) return 0;
      var idx = models.findIndex(function (m) {
        return m && (m.priority === true || m.priority === 1 || String(m.priority).toLowerCase() === 'true');
      });
      return idx >= 0 ? idx : 0;
    }

    function renderAgentEditorLlmModelPicker(scope, models, selectedIndex) {
      var dom = agentEditorDom(scope);
      if (!dom.llmModelsWrap || !dom.llmModels) return;
      var mode = dom.llmPriority ? dom.llmPriority.value : 'system';
      if (mode !== 'custom') {
        dom.llmModelsWrap.hidden = true;
        return;
      }
      if (!models.length) {
        dom.llmModelsWrap.hidden = true;
        if (dom.llmPriorityHint) {
          dom.llmPriorityHint.textContent = 'No models configured. Set up project LLM models first in Config.';
        }
        return;
      }
      dom.llmModelsWrap.hidden = false;
      var radioName = scope === 'page' ? 'team-agent-llm-priority-model' : 'agent-edit-modal-llm-priority-model';
      dom.llmModels.innerHTML = models.map(function (m, i) {
        var checked = i === selectedIndex ? ' checked' : '';
        var title = escapeHtml(formatLlmModelLabel(m, i));
        var modelName = String((m && m.model) || '').trim();
        var provider = String((m && m.provider) || '').trim();
        var desc = modelName && modelName.toLowerCase() !== provider.toLowerCase()
          ? modelName
          : (provider === 'lmstudio' || provider === 'ollama' ? 'Local model' : (provider || 'Model'));
        return '<label class="agent-edit-tile agent-edit-llm-tile">' +
          '<input type="radio" class="agent-edit-tile-input" name="' + radioName + '" value="' + i + '"' + checked + '>' +
          '<span class="agent-edit-tile-check agent-edit-llm-check" aria-hidden="true">●</span>' +
          '<span class="agent-edit-tile-title">' + title + '</span>' +
          '<span class="agent-edit-tile-desc">' + escapeHtml(desc) + '</span>' +
          '</label>';
      }).join('');
    }

    function syncAgentEditorLlmPriorityUi(scope) {
      var dom = agentEditorDom(scope);
      var state = agentEditorState[scope];
      var mode = dom.llmPriority ? String(dom.llmPriority.value || 'system') : 'system';
      if (mode === 'custom') {
        var selected = findLlmPriorityModelIndex(state.llmModels);
        renderAgentEditorLlmModelPicker(scope, state.llmModels, selected);
        if (dom.llmPriorityHint && state.llmModels.length) {
          dom.llmPriorityHint.textContent = 'Pick which model this agent tries first. Other models remain as fallbacks.';
        }
        return;
      }
      if (dom.llmModelsWrap) dom.llmModelsWrap.hidden = true;
      if (!dom.llmPriorityHint) return;
      fetch(API + '/api/config').then(function (r) { return r.json(); }).then(function (d) {
        dom.llmPriorityHint.textContent = describeProjectLlmPriority((d && d.llm && d.llm.models) || []);
      }).catch(function () {
        dom.llmPriorityHint.textContent = 'Inherits model priority from the project LLM settings.';
      });
    }

    function describeProjectLlmPriority(models) {
      if (!Array.isArray(models) || !models.length) return 'No project models configured.';
      var priorityEntry = models.find(function (m) {
        return m.priority === true || m.priority === 1 || String(m.priority).toLowerCase() === 'true';
      }) || models[0];
      var label = priorityEntry.model || priorityEntry.provider || 'default';
      if (priorityEntry.provider && priorityEntry.model && priorityEntry.model !== priorityEntry.provider) {
        label = priorityEntry.provider + ' / ' + priorityEntry.model;
      }
      return 'Project priority: ' + label + '.';
    }

    function syncAgentEditorLlmPriorityHint(scope) {
      syncAgentEditorLlmPriorityUi(scope);
    }

    function renderAgentCardMenuButton(agentId) {
      var id = escapeHtml(agentId);
      return '<div class="agent-card-menu">' +
        '<button type="button" class="agent-card-menu-btn" data-agent-menu="' + id + '" aria-label="Agent options" aria-haspopup="true" title="Options">⋮</button>' +
        '<div class="agent-card-menu-popover" role="menu" hidden>' +
          '<button type="button" class="agent-card-menu-item" data-agent-edit="' + id + '" role="menuitem">Edit agent</button>' +
        '</div>' +
      '</div>';
    }

    function closeAllAgentCardMenus() {
      document.querySelectorAll('.agent-card-menu-popover').forEach(function (el) {
        el.hidden = true;
      });
    }

    function wireAgentCardMenus(root) {
      if (!root) return;
      root.querySelectorAll('.agent-card-menu-btn').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          e.preventDefault();
          var wrap = btn.closest('.agent-card-menu');
          var pop = wrap && wrap.querySelector('.agent-card-menu-popover');
          if (!pop) return;
          var willOpen = pop.hidden;
          closeAllAgentCardMenus();
          pop.hidden = !willOpen;
        });
      });
      root.querySelectorAll('.agent-card-menu-item[data-agent-edit]').forEach(function (item) {
        item.addEventListener('click', function (e) {
          e.stopPropagation();
          e.preventDefault();
          closeAllAgentCardMenus();
          var aid = item.getAttribute('data-agent-edit');
          if (aid) openAgentEditModal(aid);
        });
      });
    }

    if (!window._agentCardMenuDocBound) {
      window._agentCardMenuDocBound = true;
      document.addEventListener('click', function () { closeAllAgentCardMenus(); });
    }

    function agentEditorDom(scope) {
      var p = scope === 'page' ? 'team-agent' : 'agent-edit-modal';
      return {
        title: document.getElementById(p + '-title'),
        id: document.getElementById(p + '-id'),
        heading: document.getElementById(p + '-heading'),
        llmPriority: document.getElementById(p + '-llm-priority'),
        llmPriorityHint: document.getElementById(p + '-llm-priority-hint'),
        llmModelsWrap: document.getElementById(p + '-llm-custom-wrap'),
        llmModels: document.getElementById(p + '-llm-models'),
        mdFiles: document.getElementById(p + '-md-files'),
        mdEditor: document.getElementById(p + '-md-editor'),
        mdLabel: document.getElementById(p + '-md-label'),
        mdTextarea: document.getElementById(p + '-md-textarea'),
        mdSaved: document.getElementById(p + '-md-saved'),
        skills: document.getElementById(p + '-skills'),
        inboundWrap: document.getElementById(p + '-inbound-wrap'),
        inbound: document.getElementById(p + '-inbound'),
        links: document.getElementById(p + '-links'),
        error: document.getElementById(p + '-error'),
      };
    }

    function showAgentEditorError(msg, scope) {
      var el = agentEditorDom(scope).error;
      if (!el) return;
      if (msg) {
        el.textContent = msg;
        el.classList.add('visible');
      } else {
        el.textContent = '';
        el.classList.remove('visible');
      }
    }

    async function loadAgentEditorMdFiles(agentId, scope) {
      var dom = agentEditorDom(scope);
      var state = agentEditorState[scope];
      if (!dom.mdFiles) return;
      state.mdFile = '';
      state.mdDirty = false;
      if (dom.mdSaved) dom.mdSaved.style.display = 'none';
      if (dom.mdEditor) dom.mdEditor.style.display = 'none';
      var r = await fetch(API + '/api/agents/' + encodeURIComponent(agentId) + '/md');
      var d = await r.json();
      var files = d.files || AGENT_IDENTITY_FILE_ORDER.map(function (id) {
        return { id: id, label: IDENTITY_FILE_LABELS[id] || id, exists: false };
      });
      dom.mdFiles.innerHTML = files.map(function (f) {
        var missing = f.exists === false ? ' · new' : '';
        return '<button type="button" class="agent-edit-md-btn" data-agent-edit-file="' + escapeHtml(f.id) + '">' +
          escapeHtml(f.label || IDENTITY_FILE_LABELS[f.id] || f.id) + missing + '</button>';
      }).join('');
      dom.mdFiles.querySelectorAll('.agent-edit-md-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          selectAgentEditorMdFile(agentId, btn.getAttribute('data-agent-edit-file'), scope);
        });
      });
      if (files.length > 0) await selectAgentEditorMdFile(agentId, files[0].id, scope);
    }

    async function selectAgentEditorMdFile(agentId, fileId, scope) {
      if (!fileId) return;
      var dom = agentEditorDom(scope);
      var state = agentEditorState[scope];
      state.mdFile = fileId;
      state.mdDirty = false;
      if (dom.mdSaved) dom.mdSaved.style.display = 'none';
      if (dom.mdFiles) {
        dom.mdFiles.querySelectorAll('.agent-edit-md-btn').forEach(function (btn) {
          btn.classList.toggle('active', btn.getAttribute('data-agent-edit-file') === fileId);
        });
      }
      if (dom.mdEditor) dom.mdEditor.style.display = 'block';
      if (dom.mdLabel) dom.mdLabel.textContent = (IDENTITY_FILE_LABELS[fileId] || fileId) + ' · ' + fileId;
      if (dom.mdTextarea) {
        dom.mdTextarea.value = '';
        dom.mdTextarea.oninput = function () { state.mdDirty = true; };
      }
      try {
        var r = await fetch(API + '/api/agents/' + encodeURIComponent(agentId) + '/md/' + encodeURIComponent(fileId));
        if (!r.ok) throw new Error('Failed to load');
        var data = await r.json();
        if (dom.mdTextarea) dom.mdTextarea.value = data.content || '';
        state.mdDirty = false;
      } catch (_) {
        if (dom.mdTextarea) dom.mdTextarea.value = '';
      }
    }

    async function saveAgentEditorMdFile(agentId, scope) {
      var dom = agentEditorDom(scope);
      var state = agentEditorState[scope];
      if (!agentId || !state.mdFile || !dom.mdTextarea) return true;
      var r = await fetch(API + '/api/agents/' + encodeURIComponent(agentId) + '/md/' + encodeURIComponent(state.mdFile), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: dom.mdTextarea.value }),
      });
      if (!r.ok) {
        var d = await r.json().catch(function () { return {}; });
        throw new Error(d.error || 'Failed to save identity file');
      }
      state.mdDirty = false;
      if (dom.mdSaved) {
        dom.mdSaved.style.display = 'inline';
        setTimeout(function () { dom.mdSaved.style.display = 'none'; }, 2000);
      }
      return true;
    }

    function showAgentEditModalError(msg) {
      showAgentEditorError(msg, 'modal');
    }

    function renderAgentEditSkillTile(skill, enabled) {
      var sid = escapeHtml(skill.id);
      var desc = escapeHtml((skill.description || '').trim());
      var checked = enabled.includes(skill.id) ? ' checked' : '';
      return '<label class="agent-edit-tile agent-edit-skill-tile">' +
        '<input type="checkbox" class="agent-edit-tile-input" data-edit-skill="' + sid + '"' + checked + '>' +
        '<span class="agent-edit-tile-check" aria-hidden="true">✓</span>' +
        '<span class="agent-edit-tile-title">' + sid + '</span>' +
        (desc ? '<span class="agent-edit-tile-desc">' + desc + '</span>' : '') +
        '</label>';
    }

    function renderAgentEditPeerTile(agent, allow) {
      var tid = escapeHtml(agent.id);
      var title = (agent.title && String(agent.title).trim()) ? escapeHtml(String(agent.title).trim()) : tid;
      var checked = allow.includes(agent.id) ? ' checked' : '';
      var sub = title !== tid ? '<span class="agent-edit-tile-desc">' + tid + '</span>' : '';
      return '<label class="agent-edit-tile agent-edit-peer-tile">' +
        '<input type="checkbox" class="agent-edit-tile-input" data-edit-link="' + tid + '"' + checked + '>' +
        '<span class="agent-edit-tile-check" aria-hidden="true">✓</span>' +
        '<span class="agent-edit-tile-title">' + title + '</span>' +
        sub +
        '</label>';
    }

    async function loadAgentEditor(agentId, scope) {
      var dom = agentEditorDom(scope);
      var state = agentEditorState[scope];
      state.agentId = agentId || 'main';
      showAgentEditorError('', scope);
      var cfg = await fetch(API + '/api/agents/' + encodeURIComponent(agentId) + '/config').then(function (r) { return r.json(); });
      var projectCfg = await fetch(API + '/api/config').then(function (r) { return r.json(); });
      var skillsResp = await fetch(API + '/api/skills').then(function (r) { return r.json(); });
      var agentsResp = await fetch(API + '/api/agents').then(function (r) { return r.json(); });
      state.llmModels = (Array.isArray(cfg.llm && cfg.llm.models) && cfg.llm.models.length)
        ? cfg.llm.models.slice()
        : (Array.isArray(projectCfg.llm && projectCfg.llm.models) ? projectCfg.llm.models.slice() : []);
      if (dom.id) dom.id.value = agentId;
      if (dom.title) dom.title.value = (cfg.title && String(cfg.title).trim()) ? String(cfg.title).trim() : '';
      if (dom.llmPriority) {
        var priorityMode = (cfg.llm && cfg.llm.priorityMode === 'custom') ? 'custom' : 'system';
        dom.llmPriority.value = priorityMode;
        dom.llmPriority.onchange = function () { syncAgentEditorLlmPriorityUi(scope); };
      }
      syncAgentEditorLlmPriorityUi(scope);
      if (dom.heading) dom.heading.textContent = (scope === 'page' ? 'Team agent: ' : 'Edit agent: ') + agentId;
      await loadAgentEditorMdFiles(agentId, scope);
      var enabled = (cfg.skills && Array.isArray(cfg.skills.enabled)) ? cfg.skills.enabled.slice() : (skillsResp.enabled || []).slice();
      var list = (skillsResp.skills || []).filter(function (s) { return s.id !== 'agent-send' && s.id !== 'background-tasks'; });
      if (dom.skills) {
        dom.skills.innerHTML = list.map(function (s) {
          return renderAgentEditSkillTile(s, enabled);
        }).join('');
      }
      var messaging = cfg.agentMessaging || {};
      var allow = Array.isArray(messaging.allow) ? messaging.allow : [];
      var inboundFrom = (agentsResp.agents || []).filter(function (a) {
        var peerAllow = Array.isArray(a.agentMessaging && a.agentMessaging.allow) ? a.agentMessaging.allow : [];
        return a.id !== agentId && peerAllow.indexOf(agentId) !== -1;
      }).map(function (a) { return a.title && String(a.title).trim() ? String(a.title).trim() + ' (' + a.id + ')' : a.id; });
      if (dom.inboundWrap && dom.inbound) {
        if (inboundFrom.length) {
          dom.inboundWrap.style.display = '';
          dom.inbound.textContent = inboundFrom.join(', ');
        } else {
          dom.inboundWrap.style.display = 'none';
          dom.inbound.textContent = '';
        }
      }
      var others = (agentsResp.agents || []).filter(function (a) { return a.id !== agentId; });
      if (dom.links) {
        if (!others.length) {
          dom.links.innerHTML = '<p class="skill-meta" style="margin:0;">No other agents yet.</p>';
        } else {
          dom.links.innerHTML = others.map(function (a) {
            return renderAgentEditPeerTile(a, allow);
          }).join('');
        }
      }
      return dom;
    }

    async function submitAgentEditor(scope, opts) {
      opts = opts || {};
      var state = agentEditorState[scope];
      var agentId = state.agentId;
      if (!agentId) return;
      var dom = agentEditorDom(scope);
      var submitBtn = opts.submitBtn || null;
      var enabled = [];
      if (dom.skills) {
        dom.skills.querySelectorAll('input[data-edit-skill]:checked').forEach(function (cb) {
          enabled.push(cb.getAttribute('data-edit-skill'));
        });
      }
      var allow = [];
      if (dom.links) {
        dom.links.querySelectorAll('input[data-edit-link]:checked').forEach(function (cb) {
          allow.push(cb.getAttribute('data-edit-link'));
        });
      }
      var patch = {
        title: dom.title ? dom.title.value : '',
        skills: { enabled: enabled },
        agentMessaging: { allow: allow },
      };
      if (dom.llmPriority) {
        var mode = dom.llmPriority.value === 'custom' ? 'custom' : 'system';
        patch.llm = { priorityMode: mode };
        if (mode === 'custom') {
          var baseModels = (agentEditorState[scope].llmModels || []).map(function (m) {
            return Object.assign({}, m);
          });
          var selected = findLlmPriorityModelIndex(baseModels);
          if (dom.llmModels) {
            var picked = dom.llmModels.querySelector('input[type="radio"]:checked');
            if (picked) selected = Number(picked.value) || 0;
          }
          patch.llm.models = baseModels.map(function (m, i) {
            var copy = Object.assign({}, m);
            if (i === selected) copy.priority = true;
            else delete copy.priority;
            return copy;
          });
        }
      }
      if (submitBtn) submitBtn.disabled = true;
      showAgentEditorError('', scope);
      try {
        if (state.mdDirty && state.mdFile) {
          await saveAgentEditorMdFile(agentId, scope);
        }
        var r = await fetch(API + '/api/agents/' + encodeURIComponent(agentId) + '/config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(d.error || ('Save failed (' + r.status + ')'));
        if (opts.onSuccess) await opts.onSuccess();
      } catch (err) {
        showAgentEditorError(err.message || String(err), scope);
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    }

    async function openAgentEditModal(agentId) {
      var modal = document.getElementById('agent-edit-modal');
      if (!modal) return;
      try {
        var dom = await loadAgentEditor(agentId, 'modal');
        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
        agentEditModalOpen = true;
        setTimeout(function () { if (dom.title) dom.title.focus(); }, 0);
      } catch (err) {
        window.alert('Could not load agent: ' + (err.message || err));
      }
    }

    function closeAgentEditModal() {
      var modal = document.getElementById('agent-edit-modal');
      if (!modal) return;
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      agentEditModalOpen = false;
      agentEditorState.modal = { agentId: '', mdFile: '', mdDirty: false };
      showAgentEditorError('', 'modal');
    }

    async function submitAgentEditModal() {
      var submitBtn = document.getElementById('agent-edit-modal-submit');
      await submitAgentEditor('modal', {
        submitBtn: submitBtn,
        onSuccess: async function () {
          closeAgentEditModal();
          await fetchChatAgents();
          if (typeof fetchAgentsPage === 'function') await fetchAgentsPage();
          await fetchAgentMapData();
        },
      });
    }

    function openTeamAgentPage(agentId) {
      openAgentEditModal(agentId);
    }

    function openTeamPage() {
      history.pushState(null, '', '/team');
      if (typeof dashboardRouteFromPath === 'function') dashboardRouteFromPath();
      else if (typeof dashboardRouteFromHash === 'function') dashboardRouteFromHash();
    }

    function setTeamPageFullscreen(on) {
      teamPageFullscreen = !!on;
      document.body.classList.toggle('team-page-fullscreen', teamPageFullscreen);
      var btn = document.getElementById('team-page-fullscreen-btn');
      if (btn) {
        btn.setAttribute('aria-pressed', teamPageFullscreen ? 'true' : 'false');
        btn.title = teamPageFullscreen ? 'Exit full screen' : 'Full screen';
        btn.setAttribute('aria-label', btn.title);
      }
      try {
        if (teamPageFullscreen) sessionStorage.setItem('teamPageFullscreen', '1');
        else sessionStorage.removeItem('teamPageFullscreen');
      } catch (e) {}
    }

    function toggleTeamPageFullscreen() {
      setTeamPageFullscreen(!teamPageFullscreen);
    }

    async function loadTeamAgentPage(agentId) {
      if (!agentId) agentId = 'main';
      try {
        var dom = await loadAgentEditor(agentId, 'page');
        setTimeout(function () { if (dom.title) dom.title.focus(); }, 0);
      } catch (err) {
        showAgentEditorError('Could not load agent: ' + (err.message || err), 'page');
      }
    }

    async function submitTeamAgentPage() {
      var submitBtn = document.getElementById('team-agent-save');
      await submitAgentEditor('page', {
        submitBtn: submitBtn,
        onSuccess: async function () {
          await fetchChatAgents();
          if (typeof fetchAgentsPage === 'function') await fetchAgentsPage();
        },
      });
    }

    wireEl('agent-create-btn', 'click', async function () {
      var input = document.getElementById('agent-create-name');
      var rawName = (input && input.value) ? input.value.trim() : '';
      if (!rawName) return;
      var id = normalizeAgentIdInput(rawName);
      if (!id) return;
      try {
        var d = await createAgentViaApi(id, 'main', rawName);
        selectedAgentId = d.id || id;
        if (input) input.value = '';
        await fetchAgentsPage();
        await fetchChatAgents();
      } catch (err) {
        window.alert('Create failed: ' + (err.message || err));
      }
    });

    wireEl('agent-delete-btn', 'click', async function () {
      if (!selectedAgentId || selectedAgentId === 'main') return;
      var ok = window.confirm('Delete agent "' + selectedAgentId + '"? This removes its config and identity files.');
      if (!ok) return;
      var r = await fetch(API + '/api/agents/' + encodeURIComponent(selectedAgentId) + '?confirm=true', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true })
      });
      if (!r.ok) {
        var err = await r.json().catch(function () { return {}; });
        window.alert('Delete failed: ' + (err.error || r.status));
        return;
      }
      selectedAgentId = 'main';
      await fetchAgentsPage();
      await fetchChatAgents();
    });

    wireEl('agent-skills-save', 'click', async function () {
      var checked = document.querySelectorAll('#agent-skills-list input[data-agent-skill]:checked');
      var enabled = Array.from(checked).map(function (x) { return x.getAttribute('data-agent-skill'); });
      var cfgRes = await fetch(API + '/api/agents/' + encodeURIComponent(selectedAgentId) + '/config');
      var cfg = await cfgRes.json();
      cfg.skills = cfg.skills || {};
      cfg.skills.enabled = enabled;
      var save = await fetch(API + '/api/agents/' + encodeURIComponent(selectedAgentId) + '/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skills: cfg.skills })
      });
      if (save.ok) {
        document.getElementById('agent-skills-save').style.display = 'none';
        agentSkillsDirty = false;
      }
    });

    wireEl('agent-md-save', 'click', async function () {
      if (!selectedAgentMdFile || !selectedAgentId) return;
      var content = document.getElementById('agent-md-textarea').value;
      var r = await fetch(API + '/api/agents/' + encodeURIComponent(selectedAgentId) + '/md/' + encodeURIComponent(selectedAgentMdFile), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: content })
      });
      if (r.ok) {
        var el = document.getElementById('agent-md-saved');
        el.style.display = 'inline';
        setTimeout(function () { el.style.display = 'none'; }, 2000);
      }
    });

    let groupSkillsDirty = false;
    let selectedGroupId = 'default';

    async function fetchGroups() {
      try {
        var ul = document.getElementById('groups-list');
        if (!ul) return;
        var oldHint = document.getElementById('groups-path-hint');
        if (oldHint) oldHint.remove();
        var r = await fetch(API + '/api/groups');
        var d = await r.json().catch(function () { return {}; });
        var groups = Array.isArray(d.groups) ? d.groups : [];
        if (d.error) console.error('[groups]', d.error);
        ul.innerHTML =
          '<li class="' + (selectedGroupId === 'default' ? 'selected' : '') + '"><button type="button" class="link" data-id="default">Default settings</button></li>' +
          groups.map(function (g) {
            return '<li class="' + (selectedGroupId === (g && g.id) ? 'selected' : '') + '"><button type="button" class="link" data-id="' + escapeHtml(String((g && g.id) || '')) + '">' + escapeHtml(String((g && g.label) || (g && g.id) || '')) + '</button></li>';
          }).join('');
        if (groups.length === 0 && (d._path || d.error) && ul.parentNode) {
          var hint = document.createElement('p');
          hint.id = 'groups-path-hint';
          hint.className = 'skill-meta';
          hint.style.marginTop = '0.5rem';
          hint.textContent = d.error ? ('Error: ' + d.error + (d._path ? ' (path: ' + d._path + ')' : '')) : ('No groups yet. Server reading: ' + (d._path || ''));
          ul.parentNode.insertBefore(hint, ul.nextSibling);
        }
        ul.querySelectorAll('button.link').forEach(function (btn) {
          btn.addEventListener('click', function () { selectGroup(btn.getAttribute('data-id')); });
        });
        selectGroup(selectedGroupId);
      } catch (e) {
        console.error('[groups]', e);
        var ul = document.getElementById('groups-list');
        if (ul) ul.innerHTML = '<li><button type="button" class="link" data-id="default">Default settings</button></li><li class="skill-meta">Error loading groups.</li>';
      }
    }

    var selectedGroupTab = 'skills';
    function setGroupTab(tab) {
      selectedGroupTab = tab;
      document.querySelectorAll('#groups-detail-sub-nav button[data-group-tab]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-group-tab') === tab);
      });
      document.querySelectorAll('#groups-detail-content .group-sub-panel').forEach(function (p) {
        p.classList.toggle('active',
          (p.id === 'groups-detail-skills' && tab === 'skills') ||
          (p.id === 'groups-detail-agent' && tab === 'agent') ||
          (p.id === 'groups-detail-history' && tab === 'history')
        );
      });
      if (tab === 'history') loadGroupHistory(selectedGroupId);
      if (tab === 'agent') loadGroupAgent(selectedGroupId);
    }
    function selectGroup(id) {
      selectedGroupId = id;
      document.querySelectorAll('#groups-list li').forEach(function (li) {
        var btn = li.querySelector('button.link');
        li.classList.toggle('selected', btn && btn.getAttribute('data-id') === id);
      });
      var titleEl = document.getElementById('groups-detail-title');
      var metaEl = document.getElementById('groups-detail-meta');
      var subNavEl = document.getElementById('groups-detail-sub-nav');
      var skillsEl = document.getElementById('groups-detail-skills');
      titleEl.textContent = id === 'default' ? 'Default group settings' : ('Group ' + id);
      subNavEl.style.display = id ? 'flex' : 'none';
      setGroupTab(selectedGroupTab);
      loadGroupSkills(id);
      loadGroupAgent(id);
      if (id !== 'default') {
        fetch(API + '/api/groups/' + encodeURIComponent(id))
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) {
            if (d && d.chatLogPath) metaEl.textContent = 'Chat log: ' + d.chatLogPath;
            else metaEl.textContent = '';
          })
          .catch(function () { metaEl.textContent = ''; });
      } else {
        metaEl.textContent = 'Used as default restrictions for groups.';
      }
    }
    function timeAgo(isoStr) {
      if (!isoStr) return '—';
      var d = new Date(isoStr);
      if (isNaN(d.getTime())) return '—';
      var sec = Math.floor((Date.now() - d.getTime()) / 1000);
      if (sec < 60) return sec + 's ago';
      if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
      if (sec < 86400) return Math.floor(sec / 3600) + 'h ago';
      if (sec < 2592000) return Math.floor(sec / 86400) + 'd ago';
      if (sec < 31536000) return Math.floor(sec / 2592000) + 'mo ago';
      return Math.floor(sec / 31536000) + 'y ago';
    }
    async function loadGroupHistory(groupId) {
      var statsEl = document.getElementById('history-stats');
      var filesEl = document.getElementById('history-log-files');
      if (groupId === 'default') {
        statsEl.innerHTML = '<p class="skill-meta">Default settings have no chat log. Add the bot to a Telegram group and chat to see history here.</p>';
        filesEl.innerHTML = '';
        return;
      }
      try {
        var r = await fetch(API + '/api/groups/' + encodeURIComponent(groupId) + '/history');
        var d = await r.json();
        if (d.message) {
          statsEl.innerHTML = '<p class="skill-meta">' + escapeHtml(d.message) + '</p>';
          filesEl.innerHTML = '';
          return;
        }
        var first = d.firstActivity ? new Date(d.firstActivity).toLocaleString() : '—';
        var last = d.lastActivity ? new Date(d.lastActivity).toLocaleString() : '—';
        var ago = timeAgo(d.lastActivity);
        statsEl.innerHTML =
          '<div class="history-stat"><span class="label">First activity</span><br>' + escapeHtml(first) + '</div>' +
          '<div class="history-stat"><span class="label">Last activity</span><br>' + escapeHtml(last) + '</div>' +
          '<div class="history-stat"><span class="label">How long ago</span><br>' + escapeHtml(ago) + '</div>' +
          '<div class="history-stat"><span class="label">Total exchanges</span><br>' + (typeof d.totalExchanges === 'number' ? d.totalExchanges : '—') + '</div>';
        if (!d.logFiles || d.logFiles.length === 0) {
          filesEl.innerHTML = '<p class="skill-meta">No log files yet.</p>';
        } else {
          filesEl.innerHTML = '<table><thead><tr><th>File</th><th>Last modified</th><th>Exchanges</th></tr></thead><tbody>' +
            d.logFiles.map(function (f) {
              var mtime = f.mtimeISO ? new Date(f.mtimeISO).toLocaleString() : '—';
              var count = f.exchanges != null ? f.exchanges : (f.error ? '—' : '—');
              return '<tr><td>' + escapeHtml(f.name) + '</td><td>' + escapeHtml(mtime) + '</td><td>' + escapeHtml(String(count)) + '</td></tr>';
            }).join('') + '</tbody></table>';
        }
      } catch (e) {
        statsEl.innerHTML = '<p class="skill-meta">Error loading history.</p>';
        filesEl.innerHTML = '';
      }
    }

    async function loadGroupSkills(groupId) {
      var r = await fetch(API + '/api/groups/' + encodeURIComponent(groupId) + '/skills');
      var d = await r.json();
      var enabled = d.enabled || [];
      var list = d.skills || [];
      var el = document.getElementById('group-skills-list');
      el.innerHTML = list.map(function (s) {
        var checked = enabled.includes(s.id) ? ' checked' : '';
        var desc = (s.description || '').trim();
        var descHtml = desc ? '<div class="skill-desc">' + escapeHtml(desc) + '</div>' : '';
        return '<div class="skill-item"><div class="skill-row" data-id="' + escapeHtml(s.id) + '"><div><span class="skill-id">' + escapeHtml(s.id) + '</span>' + descHtml + '</div><label onclick="event.stopPropagation()"><input type="checkbox" data-id="' + escapeHtml(s.id) + '"' + checked + '> Enabled</label></div><div class="skill-doc-inline" data-id="' + escapeHtml(s.id) + '"><h3>Doc: ' + escapeHtml(s.id) + '</h3><p class="skill-meta skill-doc-desc" style="margin:0 0 0.5rem 0;"></p><textarea class="skill-doc-textarea" spellcheck="false"></textarea><div style="margin-top:0.75rem;"><button type="button" class="skill-doc-save-btn">Save doc</button><span class="skill-doc-saved" style="margin-left:0.75rem; color: var(--green); font-size:0.85rem; display:none;">Saved.</span></div></div></div>';
      }).join('');
      el.querySelectorAll('input[type="checkbox"]').forEach(function (cb) {
        cb.addEventListener('change', function () { groupSkillsDirty = true; document.getElementById('group-skills-save').style.display = 'block'; });
      });
      el.querySelectorAll('.skill-row').forEach(function (row) {
        row.addEventListener('click', function (e) { if (!e.target.closest('label')) openGroupSkillDoc(row.getAttribute('data-id'), row.closest('.skill-item')); });
      });
      el.querySelectorAll('.skill-doc-save-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var panel = btn.closest('.skill-doc-inline');
          var skillId = panel && panel.getAttribute('data-id');
          if (!skillId) return;
          var content = panel.querySelector('.skill-doc-textarea').value;
          fetch(API + '/api/skills/' + encodeURIComponent(skillId) + '/doc', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: content }) }).then(function (r) {
            if (r.ok) { var saved = panel.querySelector('.skill-doc-saved'); if (saved) { saved.style.display = 'inline'; setTimeout(function () { saved.style.display = 'none'; }, 2000); } }
          });
        });
      });
      document.getElementById('group-skills-save').style.display = 'none';
      groupSkillsDirty = false;
    }

    async function openGroupSkillDoc(id, skillItem) {
      var listEl = document.getElementById('group-skills-list');
      listEl.querySelectorAll('.skill-doc-inline').forEach(function (p) { p.classList.remove('open'); });
      var panel = skillItem ? skillItem.querySelector('.skill-doc-inline') : listEl.querySelector('.skill-doc-inline[data-id="' + id + '"]');
      if (!panel) return;
      var r = await fetch(API + '/api/skills/' + encodeURIComponent(id) + '/doc');
      if (!r.ok) return;
      var d = await r.json();
      panel.querySelector('.skill-doc-desc').textContent = d.description || '';
      panel.querySelector('.skill-doc-textarea').value = d.content || '';
      panel.classList.add('open');
    }

    wireEl('group-skills-save', 'click', async function () {
      var boxes = document.querySelectorAll('#group-skills-list input[type="checkbox"]:checked');
      var enabled = Array.from(boxes).map(function (b) { return b.getAttribute('data-id'); });
      var r = await fetch(API + '/api/groups/' + encodeURIComponent(selectedGroupId) + '/skills', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: enabled }) });
      if (r.ok) { groupSkillsDirty = false; document.getElementById('group-skills-save').style.display = 'none'; }
    });
    document.querySelectorAll('#groups-detail-sub-nav button[data-group-tab]').forEach(function (btn) {
      btn.addEventListener('click', function () { setGroupTab(btn.getAttribute('data-group-tab')); });
    });

    async function loadGroupAgent(groupId) {
      try {
        var [cfgRes, agentsRes] = await Promise.all([
          fetch(API + '/api/groups/' + encodeURIComponent(groupId) + '/config'),
          fetch(API + '/api/agents')
        ]);
        var cfg = await cfgRes.json();
        var agentsData = await agentsRes.json();
        var agentId = cfg && cfg.agentId ? cfg.agentId : 'main';
        var agents = (agentsData && agentsData.agents) ? agentsData.agents : [];
        var select = document.getElementById('group-agent-select');
        select.innerHTML = agents.map(function (a) {
          var selected = a.id === agentId ? ' selected' : '';
          return '<option value="' + escapeHtml(a.id) + '"' + selected + '>' + escapeHtml(a.id) + '</option>';
        }).join('');
      } catch (_) {}
    }

    wireEl('group-agent-save', 'click', async function () {
      var select = document.getElementById('group-agent-select');
      var agentId = select && select.value ? select.value : 'main';
      var r = await fetch(API + '/api/groups/' + encodeURIComponent(selectedGroupId) + '/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: agentId })
      });
      if (r.ok) {
        var saved = document.getElementById('group-agent-saved');
        saved.style.display = 'inline';
        setTimeout(function () { saved.style.display = 'none'; }, 2000);
        loadGroupSkills(selectedGroupId);
      }
    });

    function renderTideChecklistItems(items) {
      var el = document.getElementById('config-tide-checklist-items');
      if (!el) return;
      if (!items.length) {
        el.innerHTML = '<p class="skill-meta">No items yet.</p>';
        return;
      }
      el.innerHTML = items.map(function (it) {
        return '<div class="skill-item" style="margin-bottom:0.5rem;"><div class="skill-row">' +
          '<div><span class="skill-id">' + escapeHtml(it.id) + '</span>' +
          '<div class="skill-desc">' + escapeHtml(it.prompt || it.label) + '</div></div>' +
          '<label><input type="checkbox" data-tide-item-enable="' + escapeHtml(it.id) + '"' + (it.enabled ? ' checked' : '') + '> On</label>' +
          '<button type="button" data-tide-item-remove="' + escapeHtml(it.id) + '" style="margin-left:0.5rem; font-size:0.75rem;">Remove</button>' +
          '</div></div>';
      }).join('');
      el.querySelectorAll('input[data-tide-item-enable]').forEach(function (cb) {
        cb.addEventListener('change', function () {
          var id = cb.getAttribute('data-tide-item-enable');
          var item = tideChecklistCache.items.find(function (x) { return x.id === id; });
          if (item) item.enabled = cb.checked;
          saveTideChecklistFromCache();
        });
      });
      el.querySelectorAll('button[data-tide-item-remove]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var id = btn.getAttribute('data-tide-item-remove');
          tideChecklistCache.items = tideChecklistCache.items.filter(function (x) { return x.id !== id; });
          saveTideChecklistFromCache();
        });
      });
    }

    function readTideChecklistUiPayload() {
      return {
        tideEnabled: !!(document.getElementById('config-tide-enabled') && document.getElementById('config-tide-enabled').checked),
        enabled: !!(document.getElementById('config-tide-checklist-enabled') && document.getElementById('config-tide-checklist-enabled').checked),
        triggers: {
          onRestart: !!(document.getElementById('config-tide-trigger-restart') && document.getElementById('config-tide-trigger-restart').checked),
          onCycle: !!(document.getElementById('config-tide-trigger-cycle') && document.getElementById('config-tide-trigger-cycle').checked),
          onFollowUp: !!(document.getElementById('config-tide-trigger-followup') && document.getElementById('config-tide-trigger-followup').checked),
        },
        items: (tideChecklistCache && tideChecklistCache.items) ? tideChecklistCache.items : [],
      };
    }

    async function saveTideChecklistFromCache() {
      var payload = readTideChecklistUiPayload();
      var r = await fetch(API + '/api/tide/checklist', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error('Save failed');
      var d = await r.json();
      applyTideChecklistUi(d);
      if (configCache) {
        configCache.tide = configCache.tide || {};
        configCache.tide.enabled = !!d.tideEnabled;
        configCache.tide.checklist = d.checklist;
        document.getElementById('full-config').value = JSON.stringify(configCache, null, 2);
      }
    }

    function applyTideChecklistUi(d) {
      if (!d) return;
      var tideEnabled = document.getElementById('config-tide-enabled');
      if (tideEnabled) tideEnabled.checked = !!d.tideEnabled;
      var checklistEnabled = document.getElementById('config-tide-checklist-enabled');
      if (checklistEnabled) checklistEnabled.checked = !!(d.checklist && d.checklist.enabled);
      var trigRestart = document.getElementById('config-tide-trigger-restart');
      var trigCycle = document.getElementById('config-tide-trigger-cycle');
      var trigFollow = document.getElementById('config-tide-trigger-followup');
      var triggers = (d.checklist && d.checklist.triggers) || {};
      if (trigRestart) trigRestart.checked = !!triggers.onRestart;
      if (trigCycle) trigCycle.checked = !!triggers.onCycle;
      if (trigFollow) trigFollow.checked = !!triggers.onFollowUp;
      tideChecklistCache = d.checklist || { items: [] };
      renderTideChecklistItems(tideChecklistCache.items || []);
      var lastEl = document.getElementById('config-tide-checklist-last');
      if (lastEl) {
        lastEl.textContent = d.lastRun ? JSON.stringify(d.lastRun, null, 2) : '—';
      }
    }

    async function fetchTideChecklistForConfig() {
      try {
        var r = await fetch(API + '/api/tide/checklist');
        if (!r.ok) throw new Error('Failed to load tide checklist');
        var d = await r.json();
        applyTideChecklistUi(d);
        return d;
      } catch (e) {
        var lastEl = document.getElementById('config-tide-checklist-last');
        if (lastEl) lastEl.textContent = 'Failed to load: ' + (e.message || e);
        return null;
      }
    }

    function wireConfigTideActions() {
      var addBtn = document.getElementById('config-tide-checklist-add');
      if (addBtn && !addBtn.dataset.wired) {
        addBtn.dataset.wired = '1';
        addBtn.addEventListener('click', async function () {
          var labelEl = document.getElementById('config-tide-new-label');
          var promptEl = document.getElementById('config-tide-new-prompt');
          var label = labelEl ? labelEl.value.trim() : '';
          var prompt = promptEl ? promptEl.value.trim() : '';
          if (!label) { alert('Label is required.'); return; }
          if (!tideChecklistCache) tideChecklistCache = { items: [] };
          var item = {
            id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 48),
            label: label,
            prompt: prompt || label,
            enabled: true,
          };
          tideChecklistCache.items = tideChecklistCache.items || [];
          tideChecklistCache.items.push(item);
          if (labelEl) labelEl.value = '';
          if (promptEl) promptEl.value = '';
          try {
            await saveTideChecklistFromCache();
          } catch (e) {
            alert(e.message || 'Add failed');
          }
        });
      }
      var runBtn = document.getElementById('config-tide-checklist-run');
      if (runBtn && !runBtn.dataset.wired) {
        runBtn.dataset.wired = '1';
        runBtn.addEventListener('click', async function () {
          var status = document.getElementById('config-tide-checklist-run-status');
          if (status) status.textContent = 'Running…';
          try {
            var r = await fetch(API + '/api/tide/checklist/run', { method: 'POST' });
            var d = await r.json();
            var lastEl = document.getElementById('config-tide-checklist-last');
            if (d.lastRun && lastEl) lastEl.textContent = JSON.stringify(d.lastRun, null, 2);
            var s = d.summary || d.lastRun || {};
            if (status) status.textContent = (s.passed != null ? s.passed + '/' + s.total + ' passed' : 'Done');
          } catch (e) {
            if (status) status.textContent = 'Failed';
            alert(e.message || 'Run failed');
          }
        });
      }
    }

    var configCache = null;
    var configSkillsList = [];
    var configAgentsList = [];
    var configAgentDrafts = {};
    var configAgentDirtyIds = new Set();
    var configSelectedAgentId = (function () {
      try { return localStorage.getItem('pasture-config-agent') || 'main'; } catch (_) { return 'main'; }
    })();
    var configViewMode = (function () {
      try { return localStorage.getItem('pasture-config-view') || 'ui'; } catch (_) { return 'ui'; }
    })();
    var configActiveSection = (function () {
      try { return localStorage.getItem('pasture-config-section') || 'general'; } catch (_) { return 'general'; }
    })();
    var configToggleWired = false;
    var CONFIG_LLM_PROVIDERS = ['lmstudio', 'ollama', 'openai', 'anthropic', 'grok', 'xai', 'together', 'deepseek'];

    function configNum(val, fallback) {
      var n = Number(val);
      return Number.isFinite(n) ? n : fallback;
    }

    function configBoolInput(id, checked, label) {
      return '<label><input type="checkbox" id="' + id + '"' + (checked ? ' checked' : '') + '> ' + escapeHtml(label) + '</label>';
    }

    function configAgentIdentityFromConfig(cfg) {
      cfg = cfg || {};
      return {
        title: typeof cfg.title === 'string' ? cfg.title : '',
        bio: typeof cfg.bio === 'string' ? cfg.bio : '',
        color: typeof cfg.color === 'string' ? cfg.color : '',
      };
    }

    function getConfigAgentIdentity(agentId, rootConfig) {
      if (configAgentDrafts[agentId]) return configAgentDrafts[agentId];
      if (agentId === 'main') return configAgentIdentityFromConfig(rootConfig || {});
      return { title: '', bio: '', color: '' };
    }

    function saveConfigAgentDraftFromUi() {
      var titleEl = document.getElementById('config-agent-title');
      var bioEl = document.getElementById('config-agent-bio');
      var colorEl = document.getElementById('config-agent-color');
      if (!titleEl && !bioEl && !colorEl) return;
      var agentId = configSelectedAgentId || 'main';
      configAgentDrafts[agentId] = {
        title: titleEl ? titleEl.value : '',
        bio: bioEl ? bioEl.value : '',
        color: colorEl ? colorEl.value : '',
      };
      configAgentDirtyIds.add(agentId);
    }

    function applyMainAgentIdentityToConfig(config) {
      var identity = getConfigAgentIdentity('main', config);
      var title = String(identity.title || '').trim();
      var bio = String(identity.bio || '').trim();
      var color = String(identity.color || '').trim();
      if (title) config.title = title; else delete config.title;
      if (bio) config.bio = bio; else delete config.bio;
      if (color) config.color = color; else delete config.color;
      return config;
    }

    async function selectConfigAgent(agentId) {
      saveConfigAgentDraftFromUi();
      agentId = String(agentId || 'main').trim() || 'main';
      if (!configAgentsList.some(function (a) { return a.id === agentId; })) agentId = 'main';
      configSelectedAgentId = agentId;
      try { localStorage.setItem('pasture-config-agent', configSelectedAgentId); } catch (_) {}
      if (!configAgentDrafts[agentId] && agentId !== 'main') {
        try {
          var cfg = await fetch(API + '/api/agents/' + encodeURIComponent(agentId) + '/config').then(function (r) { return r.json(); });
          configAgentDrafts[agentId] = configAgentIdentityFromConfig(cfg);
        } catch (_) {
          configAgentDrafts[agentId] = { title: '', bio: '', color: '' };
        }
      }
      document.querySelectorAll('#config-agents-list li').forEach(function (li) {
        var btn = li.querySelector('button[data-config-agent-id]');
        li.classList.toggle('selected', btn && btn.getAttribute('data-config-agent-id') === configSelectedAgentId);
      });
      var identity = getConfigAgentIdentity(configSelectedAgentId, configCache || {});
      var titleEl = document.getElementById('config-agent-title');
      var bioEl = document.getElementById('config-agent-bio');
      var colorEl = document.getElementById('config-agent-color');
      var headingEl = document.getElementById('config-agent-heading');
      if (titleEl) titleEl.value = identity.title || '';
      if (bioEl) bioEl.value = identity.bio || '';
      if (colorEl) colorEl.value = identity.color || '';
      if (headingEl) headingEl.textContent = 'Agent: ' + configSelectedAgentId;
    }

    function renderConfigAgentsList() {
      var ul = document.getElementById('config-agents-list');
      if (!ul) return;
      var list = configAgentsList.length ? configAgentsList : [{ id: 'main', title: '' }];
      if (!list.some(function (a) { return a.id === configSelectedAgentId; })) configSelectedAgentId = list[0].id;
      ul.innerHTML = list.map(function (a) {
        var selected = a.id === configSelectedAgentId ? 'selected' : '';
        var title = (a.title && String(a.title).trim()) ? String(a.title).trim() : '';
        var titleHtml = title
          ? '<span class="config-agent-card-title">' + escapeHtml(title) + '</span>'
          : '<span class="config-agent-card-title">' + escapeHtml(a.id) + '</span>';
        var idHtml = title
          ? '<span class="config-agent-card-id">' + escapeHtml(a.id) + '</span>'
          : '';
        return '<li class="config-agent-card ' + selected + '">' +
          '<button type="button" class="config-agent-card-btn" data-config-agent-id="' + escapeHtml(a.id) + '">' +
          titleHtml + idHtml +
          '</button></li>';
      }).join('');
      ul.querySelectorAll('button[data-config-agent-id]').forEach(function (btn) {
        btn.addEventListener('click', function () { selectConfigAgent(btn.getAttribute('data-config-agent-id')); });
      });
    }

    function configTextField(id, label, value, placeholder, type) {
      type = type || 'text';
      return '<div class="field"><label for="' + id + '">' + escapeHtml(label) + '</label>' +
        '<input type="' + type + '" id="' + id + '" value="' + escapeHtml(value == null ? '' : String(value)) + '"' +
        (placeholder ? ' placeholder="' + escapeHtml(placeholder) + '"' : '') + '></div>';
    }

    function configTileCard(title, bodyHtml, wide) {
      return '<div class="config-tile-card' + (wide ? ' config-tile-card-wide' : '') + '">' +
        (title ? '<h4 class="config-tile-card-title">' + escapeHtml(title) + '</h4>' : '') +
        bodyHtml + '</div>';
    }

    function configTilesGrid(html, extraClass) {
      return '<div class="config-tiles-grid' + (extraClass ? ' ' + extraClass : '') + '">' + html + '</div>';
    }

    function configSectionPanel(id, label, bodyHtml, isActive) {
      return '<div class="config-section-panel' + (isActive ? ' active' : '') + '" data-config-section-panel="' + id + '" role="tabpanel"' +
        (isActive ? '' : ' hidden') + '>' +
        '<div class="config-section-body">' + bodyHtml + '</div></div>';
    }

    function setConfigSection(section) {
      configActiveSection = section || 'general';
      try { localStorage.setItem('pasture-config-section', configActiveSection); } catch (_) {}
      document.querySelectorAll('#config-ui-section-nav button[data-config-section]').forEach(function (b) {
        var on = b.getAttribute('data-config-section') === configActiveSection;
        b.classList.toggle('active', on);
        b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      document.querySelectorAll('#config-ui-sections .config-section-panel').forEach(function (p) {
        var on = p.getAttribute('data-config-section-panel') === configActiveSection;
        p.classList.toggle('active', on);
        p.hidden = !on;
      });
    }

    function renderConfigUi(config) {
      var agents = config.agents || {};
      var defaults = agents.defaults || {};
      var llm = config.llm || {};
      var models = Array.isArray(llm.models) ? llm.models : [];
      var skills = config.skills || {};
      var enabled = Array.isArray(skills.enabled) ? skills.enabled : [];
      var search = skills.search || {};
      var github = skills.github || {};
      var gog = skills.gog || {};
      var channels = config.channels || {};
      var whatsapp = channels.whatsapp || {};
      var telegram = channels.telegram || {};
      var tide = config.tide || {};
      var owner = config.owner || {};
      var agentMessaging = config.agentMessaging || {};
      var retrospective = config.retrospective || {};
      var systemPulse = config.systemPulse || {};
      var priorityIdx = models.findIndex(function (m) {
        return m && (m.priority === true || m.priority === 1 || String(m.priority).toLowerCase() === 'true');
      });
      var skillsHtml = configSkillsList.length
        ? configSkillsList.map(function (s) {
          var on = enabled.indexOf(s.id) >= 0;
          return '<label class="config-skill-chip"><input type="checkbox" data-config-skill="' + escapeHtml(s.id) + '"' + (on ? ' checked' : '') + '> ' + escapeHtml(s.id) + '</label>';
        }).join('')
        : enabled.map(function (id) {
          return '<label class="config-skill-chip"><input type="checkbox" data-config-skill="' + escapeHtml(id) + '" checked> ' + escapeHtml(id) + '</label>';
        }).join('') || '<p class="empty">No skills found.</p>';
      var modelsHtml = models.map(function (m, i) {
        var provider = (m && m.provider) || '';
        var priorityChecked = i === priorityIdx ? ' checked' : '';
        return '<div class="config-tile-card config-model-card" data-config-model="' + i + '">' +
          '<h4 class="config-tile-card-title">Model ' + (i + 1) + '</h4>' +
          '<div class="form-row"><div class="field"><label>Provider</label><select data-f="provider">' +
          CONFIG_LLM_PROVIDERS.map(function (p) {
            return '<option value="' + p + '"' + (p === provider ? ' selected' : '') + '>' + p + '</option>';
          }).join('') +
          '</select></div></div>' +
          '<div class="field"><label>Model name</label><input type="text" data-f="model" value="' + escapeHtml(m.model || '') + '" placeholder="gpt-4o, local"></div>' +
          '<div class="field"><label>Base URL (local)</label><input type="text" data-f="baseUrl" value="' + escapeHtml(m.baseUrl || '') + '" placeholder="http://127.0.0.1:1234/v1"></div>' +
          '<div class="field"><label>API key env var</label><input type="text" data-f="apiKey" value="' + escapeHtml(m.apiKey || '') + '" placeholder="LLM_1_API_KEY"></div>' +
          '<div class="form-row config-priority-row"><label><input type="radio" name="config-llm-priority" value="' + i + '"' + priorityChecked + '> Priority (use first)</label></div>' +
          '<button type="button" class="config-model-remove link-btn" data-remove-model="' + i + '">Remove model</button>' +
          '</div>';
      }).join('');
      var allowLines = Array.isArray(agentMessaging.allow) ? agentMessaging.allow.join('\n') : '';
      var tideCooldown = tide.silenceCooldownMinutes != null ? tide.silenceCooldownMinutes : tide.intervalMinutes;
      var checklist = tide.checklist || {};
      var checklistTriggers = checklist.triggers || {};
      var CONFIG_SECTIONS = [
        { id: 'general', label: 'General' },
        { id: 'agents', label: 'Agents' },
        { id: 'llm', label: 'LLM' },
        { id: 'skills', label: 'Skills' },
        { id: 'channels', label: 'Channels' },
        { id: 'owner', label: 'Owner' },
        { id: 'tide', label: 'Tide' },
        { id: 'messaging', label: 'Messaging' },
        { id: 'retrospective', label: 'Retrospective' },
        { id: 'pulse', label: 'Pulse' }
      ];
      var activeSection = CONFIG_SECTIONS.some(function (s) { return s.id === configActiveSection; })
        ? configActiveSection : 'general';
      var generalBody = configTilesGrid(
        configTileCard('Overview',
          '<p class="skill-meta" style="margin:0;">Project-wide settings live in the other tabs. Agent roster and per-agent display settings are under <strong>Agents</strong>.</p>') +
        configTileCard('Tips',
          '<p class="skill-meta" style="margin:0;">Use <strong>JSON</strong> mode for keys not shown in the UI. Click <strong>Save</strong> to write <code>config.json</code>.</p>')
      );
      var selectedIdentity = getConfigAgentIdentity(configSelectedAgentId, config);
      var agentsBody =
        configTilesGrid(
          configTileCard('Defaults (all agents)',
            configTextField('config-user-timezone', 'User timezone', defaults.userTimezone || '', 'auto or America/New_York') +
            '<div class="field"><label for="config-time-format">Time format</label><select id="config-time-format">' +
            ['auto', '12h', '24h', '12', '24'].map(function (v) {
              var sel = String(defaults.timeFormat || 'auto') === v ? ' selected' : '';
              var label = v === '12' ? '12h (legacy)' : v === '24' ? '24h (legacy)' : v;
              return '<option value="' + v + '"' + sel + '>' + label + '</option>';
            }).join('') +
            '</select></div>' +
            configTextField('config-session-reset-hour', 'Session reset hour (0–23)', defaults.sessionResetHour != null ? defaults.sessionResetHour : 3, '', 'number')) +
          configTileCard('Help',
            '<p class="skill-meta" style="margin:0;">Full skill and identity file editing is on the <strong>Agents</strong> page.</p>')
        ) +
        configTileCard('Agent roster',
          '<p class="skill-meta" style="margin:0 0 0.5rem 0;">Select an agent to edit display name, bio, and accent color.</p>' +
          '<ul id="config-agents-list" class="config-agents-list"></ul>', true) +
        configTileCard('Identity',
          '<p id="config-agent-heading" class="skill-meta" style="margin:0 0 0.5rem 0;">Agent: ' + escapeHtml(configSelectedAgentId) + '</p>' +
          configTextField('config-agent-title', 'Display name', selectedIdentity.title || '', 'CEO') +
          '<div class="field"><label for="config-agent-bio">Bio / personality</label><textarea id="config-agent-bio" rows="3">' + escapeHtml(selectedIdentity.bio || '') + '</textarea></div>' +
          configTextField('config-agent-color', 'Accent color', selectedIdentity.color || '', '#ef4444', 'color'), true);
      var llmBody =
        configTilesGrid(
          configTileCard('Limits',
            configTextField('config-llm-max-tokens', 'Max tokens', llm.maxTokens != null ? llm.maxTokens : 2048, '', 'number')) +
          configTileCard('Priority',
            '<p class="skill-meta" style="margin:0;">Select one priority model below. Local models are used as fallback when cloud is unavailable.</p>')
        ) +
        '<div id="config-llm-models" class="config-tiles-grid config-models-grid">' + modelsHtml + '</div>' +
        '<button type="button" id="config-llm-add-model" class="link-btn">+ Add model</button>';
      var skillsBody = configTilesGrid(
        configTileCard('Enabled skills',
          '<div class="config-skills-grid">' + skillsHtml + '</div>', true) +
        configTileCard('Search',
          configTextField('config-search-provider', 'Search provider', search.provider || 'brave', 'brave') +
          configTextField('config-search-count', 'Search result count', search.count != null ? search.count : 8, '', 'number')) +
        configTileCard('GitHub',
          configTextField('config-github-token', 'GitHub token env var', github.token || '', 'GITHUB_TOKEN') +
          configTextField('config-github-repo', 'GitHub default repo', github.defaultRepo || '', 'owner/repo')) +
        configTileCard('Google (gog)',
          configTextField('config-gog-account', 'Google (gog) account', gog.account || '', 'you@gmail.com'))
      );
      var channelsBody = configTilesGrid(
        configTileCard('WhatsApp',
          '<div class="config-check-row">' + configBoolInput('config-whatsapp-enabled', !!whatsapp.enabled, 'WhatsApp enabled') + '</div>') +
        configTileCard('Telegram',
          '<div class="config-check-row">' + configBoolInput('config-telegram-enabled', !!telegram.enabled, 'Telegram enabled') + '</div>' +
          configTextField('config-telegram-token', 'Telegram bot token env var', telegram.botToken || '', 'TELEGRAM_BOT_TOKEN'))
      );
      var ownerBody = configTilesGrid(
        configTileCard('WhatsApp',
          configTextField('config-owner-whatsapp', 'WhatsApp JID', owner.whatsappJid || '', '1234567890@s.whatsapp.net')) +
        configTileCard('Telegram',
          configTextField('config-owner-telegram', 'Telegram user ID', owner.telegramUserId != null ? owner.telegramUserId : '', '123456789', 'number'))
      );
      var tideBody =
        configTilesGrid(
          configTileCard('Follow-ups',
            '<p class="skill-meta" style="margin:0 0 0.5rem 0;">Follow-ups run as agent turns.</p>' +
            '<div class="config-check-row">' + configBoolInput('config-tide-enabled', !!tide.enabled, 'Tide enabled') + '</div>' +
            configTextField('config-tide-cooldown', 'Silence cooldown (minutes)', tideCooldown != null ? tideCooldown : 30, '', 'number') +
            configTextField('config-tide-inactive-start', 'Quiet hours start', tide.inactiveStart || '23:00', '23:00') +
            configTextField('config-tide-inactive-end', 'Quiet hours end', tide.inactiveEnd || '06:00', '06:00') +
            configTextField('config-tide-jid', 'Target JID (optional)', tide.jid || '', '')) +
          configTileCard('Checklist triggers',
            '<p class="skill-meta" style="margin:0 0 0.5rem 0;">Checklist requires Tide enabled for automatic runs.</p>' +
            '<div class="config-check-row">' + configBoolInput('config-tide-checklist-enabled', !!checklist.enabled, 'Checklist enabled') + '</div>' +
            '<div class="config-tide-actions">' +
            '<button type="button" id="config-tide-checklist-run">Run now</button>' +
            '<span id="config-tide-checklist-run-status" class="skill-meta"></span>' +
            '</div>' +
            '<div class="config-check-row">' + configBoolInput('config-tide-trigger-restart', !!checklistTriggers.onRestart, 'On daemon restart') + '</div>' +
            '<div class="config-check-row">' + configBoolInput('config-tide-trigger-cycle', !!checklistTriggers.onCycle, 'On health-check cycle') + '</div>' +
            '<div class="config-check-row">' + configBoolInput('config-tide-trigger-followup', !!checklistTriggers.onFollowUp, 'On follow-up (per chat)') + '</div>')
        ) +
        configTileCard('Checklist items',
          '<div id="config-tide-checklist-items"></div>' +
          '<div class="config-tide-add">' +
          '<input type="text" id="config-tide-new-label" placeholder="Short label" />' +
          '<textarea id="config-tide-new-prompt" placeholder="Prompt for the agent (what to check). Defaults to label if empty." rows="2"></textarea>' +
          '<button type="button" id="config-tide-checklist-add">Add item</button>' +
          '</div>', true) +
        configTileCard('Last run',
          '<pre id="config-tide-checklist-last" class="config-json-editable config-tide-last-run">—</pre>', true);
      var messagingBody = configTilesGrid(
        configTileCard('Allowed agents',
          '<div class="field"><label for="config-agent-allow">One agent id per line</label><textarea id="config-agent-allow" rows="4">' + escapeHtml(allowLines) + '</textarea></div>') +
        configTileCard('Limits',
          configTextField('config-agent-max-depth', 'Max delegation depth', agentMessaging.maxDepth != null ? agentMessaging.maxDepth : 2, '', 'number') +
          configTextField('config-agent-max-calls', 'Max calls per turn', agentMessaging.maxCallsPerTurn != null ? agentMessaging.maxCallsPerTurn : 5, '', 'number'))
      );
      var retrospectiveBody = configTilesGrid(
        configTileCard('Reflector',
          '<div class="config-check-row">' + configBoolInput('config-retro-enabled', !!retrospective.enabled, 'Retrospective enabled') + '</div>' +
          configTextField('config-retro-agent', 'Reflector agent ID', retrospective.reflectorAgentId || 'reflector', 'reflector') +
          configTextField('config-retro-threshold', 'Low score threshold', retrospective.lowScoreThreshold != null ? retrospective.lowScoreThreshold : 6, '', 'number') +
          configTextField('config-retro-lookback', 'Lookback days', retrospective.lookbackDays != null ? retrospective.lookbackDays : 7, '', 'number')) +
        configTileCard('Schedule',
          configTextField('config-retro-nightly-hour', 'Nightly hour (0–23)', retrospective.nightlyHour != null ? retrospective.nightlyHour : 2, '', 'number') +
          configTextField('config-retro-weekly-day', 'Weekly day (0=Sun)', retrospective.weeklyDay != null ? retrospective.weeklyDay : 0, '', 'number') +
          configTextField('config-retro-weekly-hour', 'Weekly hour (0–23)', retrospective.weeklyHour != null ? retrospective.weeklyHour : 3, '', 'number'))
      );
      var pulseBody = configTilesGrid(
        configTileCard('Switches',
          '<div class="config-check-row">' + configBoolInput('config-pulse-enabled', !!systemPulse.enabled, 'System pulse enabled') + '</div>' +
          '<div class="config-check-row">' + configBoolInput('config-pulse-notify', systemPulse.healthNotify !== false, 'Health notify') + '</div>' +
          '<div class="config-check-row">' + configBoolInput('config-pulse-dry-run', !!systemPulse.dryRun, 'Dry run') + '</div>') +
        configTileCard('Intervals',
          configTextField('config-pulse-health-interval', 'Health interval (minutes)', systemPulse.healthIntervalMinutes != null ? systemPulse.healthIntervalMinutes : 45, '', 'number') +
          configTextField('config-pulse-pattern-interval', 'Pattern interval (hours)', systemPulse.patternIntervalHours != null ? systemPulse.patternIntervalHours : 8, '', 'number')) +
        configTileCard('Patterns',
          configTextField('config-pulse-max-patterns', 'Max patterns per run', systemPulse.maxPatternsPerRun != null ? systemPulse.maxPatternsPerRun : 2, '', 'number') +
          configTextField('config-pulse-confidence', 'Self-edit confidence threshold', systemPulse.selfEditConfidenceThreshold != null ? systemPulse.selfEditConfidenceThreshold : 0.7, '', 'number'))
      );
      var sectionBodies = {
        general: generalBody,
        agents: agentsBody,
        llm: llmBody,
        skills: skillsBody,
        channels: channelsBody,
        owner: ownerBody,
        tide: tideBody,
        messaging: messagingBody,
        retrospective: retrospectiveBody,
        pulse: pulseBody
      };
      var navHtml = CONFIG_SECTIONS.map(function (s) {
        var on = s.id === activeSection;
        return '<button type="button" data-config-section="' + s.id + '" role="tab"' +
          (on ? ' class="active" aria-selected="true"' : ' aria-selected="false"') + '>' + escapeHtml(s.label) + '</button>';
      }).join('');
      var panelsHtml = CONFIG_SECTIONS.map(function (s) {
        return configSectionPanel(s.id, s.label, sectionBodies[s.id], s.id === activeSection);
      }).join('');
      var nav = document.getElementById('config-ui-section-nav');
      var container = document.getElementById('config-ui-sections');
      if (!container) return;
      if (nav) nav.innerHTML = navHtml;
      container.innerHTML = panelsHtml;
      setConfigSection(activeSection);
      renderConfigAgentsList();
      wireConfigUiActions();
      if (tideChecklistCache) renderTideChecklistItems(tideChecklistCache.items || []);
    }

    function wireConfigUiActions() {
      document.querySelectorAll('#config-ui-section-nav button[data-config-section]').forEach(function (btn) {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', function () { setConfigSection(btn.getAttribute('data-config-section')); });
      });
      var addBtn = document.getElementById('config-llm-add-model');
      if (addBtn && !addBtn.dataset.wired) {
        addBtn.dataset.wired = '1';
        addBtn.addEventListener('click', function () {
          var base = configCache || {};
          var merged = collectConfigFromUi(base);
          merged.llm = merged.llm || {};
          var models = Array.isArray(merged.llm.models) ? merged.llm.models.slice() : [];
          models.push({ provider: 'openai', model: 'gpt-4o', apiKey: 'LLM_1_API_KEY' });
          merged.llm.models = models;
          configCache = merged;
          renderConfigUi(merged);
        });
      }
      document.querySelectorAll('.config-model-remove').forEach(function (btn) {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', function () {
          var idx = Number(btn.getAttribute('data-remove-model'));
          var base = configCache || {};
          var merged = collectConfigFromUi(base);
          var models = Array.isArray(merged.llm && merged.llm.models) ? merged.llm.models.slice() : [];
          if (idx >= 0 && idx < models.length) models.splice(idx, 1);
          merged.llm = merged.llm || {};
          merged.llm.models = models;
          configCache = merged;
          renderConfigUi(merged);
        });
      });
      wireConfigTideActions();
      var agentTitleEl = document.getElementById('config-agent-title');
      var agentBioEl = document.getElementById('config-agent-bio');
      var agentColorEl = document.getElementById('config-agent-color');
      [agentTitleEl, agentBioEl, agentColorEl].forEach(function (el) {
        if (!el || el.dataset.wired) return;
        el.dataset.wired = '1';
        el.addEventListener('input', function () { saveConfigAgentDraftFromUi(); });
        el.addEventListener('change', function () { saveConfigAgentDraftFromUi(); });
      });
    }

    function collectConfigFromUi(base) {
      saveConfigAgentDraftFromUi();
      var config = JSON.parse(JSON.stringify(base || {}));
      applyMainAgentIdentityToConfig(config);
      config.agents = config.agents || {};
      config.agents.defaults = config.agents.defaults || {};
      var tzEl = document.getElementById('config-user-timezone');
      if (tzEl) config.agents.defaults.userTimezone = tzEl.value.trim() || 'auto';
      var tfEl = document.getElementById('config-time-format');
      if (tfEl) config.agents.defaults.timeFormat = tfEl.value || 'auto';
      var resetHourEl = document.getElementById('config-session-reset-hour');
      if (resetHourEl) {
        var hour = configNum(resetHourEl.value, 3);
        if (hour >= 0 && hour <= 23) config.agents.defaults.sessionResetHour = hour;
      }

      var maxTokEl = document.getElementById('config-llm-max-tokens');
      var modelCards = document.querySelectorAll('#config-llm-models .config-model-card');
      var priorityRadio = document.querySelector('input[name="config-llm-priority"]:checked');
      var priorityIdx = priorityRadio ? Number(priorityRadio.value) : -1;
      var models = Array.from(modelCards).map(function (card, i) {
        var providerEl = card.querySelector('[data-f="provider"]');
        var modelEl = card.querySelector('[data-f="model"]');
        var baseUrlEl = card.querySelector('[data-f="baseUrl"]');
        var apiKeyEl = card.querySelector('[data-f="apiKey"]');
        var o = {
          provider: providerEl ? providerEl.value.trim() || 'openai' : 'openai',
          model: modelEl ? modelEl.value.trim() || 'gpt-4o' : 'gpt-4o',
          apiKey: apiKeyEl ? apiKeyEl.value.trim() || 'LLM_1_API_KEY' : 'LLM_1_API_KEY',
        };
        var baseUrl = baseUrlEl ? baseUrlEl.value.trim() : '';
        if (baseUrl) o.baseUrl = baseUrl;
        if (i === priorityIdx) o.priority = true;
        return o;
      });
      config.llm = config.llm || {};
      config.llm.maxTokens = maxTokEl ? configNum(maxTokEl.value, 2048) : (config.llm.maxTokens || 2048);
      config.llm.models = models;

      config.skills = config.skills || {};
      var enabled = [];
      document.querySelectorAll('[data-config-skill]').forEach(function (cb) {
        if (cb.checked) enabled.push(cb.getAttribute('data-config-skill'));
      });
      config.skills.enabled = enabled;
      var searchProvider = document.getElementById('config-search-provider');
      var searchCount = document.getElementById('config-search-count');
      if (searchProvider || searchCount) {
        config.skills.search = config.skills.search || {};
        if (searchProvider) config.skills.search.provider = searchProvider.value.trim() || 'brave';
        if (searchCount) config.skills.search.count = configNum(searchCount.value, 8);
      }
      var ghToken = document.getElementById('config-github-token');
      var ghRepo = document.getElementById('config-github-repo');
      if (ghToken && ghToken.value.trim()) {
        config.skills.github = config.skills.github || {};
        config.skills.github.token = ghToken.value.trim();
      }
      if (ghRepo && ghRepo.value.trim()) {
        config.skills.github = config.skills.github || {};
        config.skills.github.defaultRepo = ghRepo.value.trim();
      }
      var gogAccount = document.getElementById('config-gog-account');
      if (gogAccount && gogAccount.value.trim()) {
        config.skills.gog = config.skills.gog || {};
        config.skills.gog.account = gogAccount.value.trim();
      }

      config.channels = config.channels || {};
      config.channels.whatsapp = { enabled: !!(document.getElementById('config-whatsapp-enabled') && document.getElementById('config-whatsapp-enabled').checked) };
      var tgEnabled = document.getElementById('config-telegram-enabled');
      var tgToken = document.getElementById('config-telegram-token');
      config.channels.telegram = {
        enabled: !!(tgEnabled && tgEnabled.checked),
        botToken: tgToken ? tgToken.value.trim() || 'TELEGRAM_BOT_TOKEN' : 'TELEGRAM_BOT_TOKEN',
      };

      var ownerWa = document.getElementById('config-owner-whatsapp');
      var ownerTg = document.getElementById('config-owner-telegram');
      if ((ownerWa && ownerWa.value.trim()) || (ownerTg && ownerTg.value.trim())) {
        config.owner = config.owner || {};
        if (ownerWa && ownerWa.value.trim()) config.owner.whatsappJid = ownerWa.value.trim();
        if (ownerTg && ownerTg.value.trim()) config.owner.telegramUserId = configNum(ownerTg.value, 0);
      }

      var tideEnabled = document.getElementById('config-tide-enabled');
      var tideCooldown = document.getElementById('config-tide-cooldown');
      config.tide = config.tide || {};
      if (tideEnabled) config.tide.enabled = !!tideEnabled.checked;
      if (tideCooldown) {
        var mins = configNum(tideCooldown.value, 30);
        config.tide.silenceCooldownMinutes = mins;
        if ('intervalMinutes' in config.tide) config.tide.intervalMinutes = mins;
      }
      var tideStart = document.getElementById('config-tide-inactive-start');
      var tideEnd = document.getElementById('config-tide-inactive-end');
      var tideJid = document.getElementById('config-tide-jid');
      if (tideStart) config.tide.inactiveStart = tideStart.value.trim() || '23:00';
      if (tideEnd) config.tide.inactiveEnd = tideEnd.value.trim() || '06:00';
      if (tideJid) config.tide.jid = tideJid.value.trim();
      var checklistEnabled = document.getElementById('config-tide-checklist-enabled');
      var trigRestart = document.getElementById('config-tide-trigger-restart');
      var trigCycle = document.getElementById('config-tide-trigger-cycle');
      var trigFollow = document.getElementById('config-tide-trigger-followup');
      if (checklistEnabled || trigRestart || trigCycle || trigFollow || tideChecklistCache) {
        config.tide.checklist = config.tide.checklist || {};
        if (checklistEnabled) config.tide.checklist.enabled = !!checklistEnabled.checked;
        config.tide.checklist.triggers = {
          onRestart: !!(trigRestart && trigRestart.checked),
          onCycle: !!(trigCycle && trigCycle.checked),
          onFollowUp: !!(trigFollow && trigFollow.checked),
        };
        if (tideChecklistCache && Array.isArray(tideChecklistCache.items)) {
          config.tide.checklist.items = tideChecklistCache.items;
        }
      }

      var allowEl = document.getElementById('config-agent-allow');
      config.agentMessaging = config.agentMessaging || {};
      if (allowEl) {
        config.agentMessaging.allow = allowEl.value.split(/\r?\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      }
      var maxDepthEl = document.getElementById('config-agent-max-depth');
      var maxCallsEl = document.getElementById('config-agent-max-calls');
      if (maxDepthEl) config.agentMessaging.maxDepth = configNum(maxDepthEl.value, 2);
      if (maxCallsEl) config.agentMessaging.maxCallsPerTurn = configNum(maxCallsEl.value, 5);

      config.retrospective = config.retrospective || {};
      var retroEnabled = document.getElementById('config-retro-enabled');
      if (retroEnabled) config.retrospective.enabled = !!retroEnabled.checked;
      var retroAgent = document.getElementById('config-retro-agent');
      if (retroAgent) config.retrospective.reflectorAgentId = retroAgent.value.trim() || 'reflector';
      var retroThreshold = document.getElementById('config-retro-threshold');
      if (retroThreshold) config.retrospective.lowScoreThreshold = configNum(retroThreshold.value, 6);
      var retroLookback = document.getElementById('config-retro-lookback');
      if (retroLookback) config.retrospective.lookbackDays = configNum(retroLookback.value, 7);
      var retroNightly = document.getElementById('config-retro-nightly-hour');
      if (retroNightly) config.retrospective.nightlyHour = configNum(retroNightly.value, 2);
      var retroWeeklyDay = document.getElementById('config-retro-weekly-day');
      if (retroWeeklyDay) config.retrospective.weeklyDay = configNum(retroWeeklyDay.value, 0);
      var retroWeeklyHour = document.getElementById('config-retro-weekly-hour');
      if (retroWeeklyHour) config.retrospective.weeklyHour = configNum(retroWeeklyHour.value, 3);

      config.systemPulse = config.systemPulse || {};
      var pulseEnabled = document.getElementById('config-pulse-enabled');
      var pulseNotify = document.getElementById('config-pulse-notify');
      var pulseDry = document.getElementById('config-pulse-dry-run');
      if (pulseEnabled) config.systemPulse.enabled = !!pulseEnabled.checked;
      if (pulseNotify) config.systemPulse.healthNotify = !!pulseNotify.checked;
      if (pulseDry) config.systemPulse.dryRun = !!pulseDry.checked;
      var pulseHealth = document.getElementById('config-pulse-health-interval');
      if (pulseHealth) config.systemPulse.healthIntervalMinutes = configNum(pulseHealth.value, 45);
      var pulsePattern = document.getElementById('config-pulse-pattern-interval');
      if (pulsePattern) config.systemPulse.patternIntervalHours = configNum(pulsePattern.value, 8);
      var pulseMax = document.getElementById('config-pulse-max-patterns');
      if (pulseMax) config.systemPulse.maxPatternsPerRun = configNum(pulseMax.value, 2);
      var pulseConf = document.getElementById('config-pulse-confidence');
      if (pulseConf) config.systemPulse.selfEditConfidenceThreshold = configNum(pulseConf.value, 0.7);

      return config;
    }

    function applyConfigViewMode() {
      var uiPanel = document.getElementById('config-ui-panel');
      var jsonPanel = document.getElementById('config-json-panel');
      var uiBtn = document.querySelector('[data-config-view="ui"]');
      var jsonBtn = document.querySelector('[data-config-view="json"]');
      if (!uiPanel || !jsonPanel) return;
      var isJson = configViewMode === 'json';
      uiPanel.hidden = isJson;
      jsonPanel.hidden = !isJson;
      if (uiBtn) {
        uiBtn.classList.toggle('active', !isJson);
        uiBtn.setAttribute('aria-selected', !isJson ? 'true' : 'false');
      }
      if (jsonBtn) {
        jsonBtn.classList.toggle('active', isJson);
        jsonBtn.setAttribute('aria-selected', isJson ? 'true' : 'false');
      }
    }

    function syncConfigJsonFromUi() {
      if (!configCache) return;
      var merged = collectConfigFromUi(configCache);
      configCache = merged;
      document.getElementById('full-config').value = JSON.stringify(merged, null, 2);
    }

    function setConfigViewMode(mode) {
      var errEl = document.getElementById('config-error');
      var next = mode === 'json' ? 'json' : 'ui';
      if (next === configViewMode) return;
      errEl.style.display = 'none';
      errEl.textContent = '';
      if (next === 'json') {
        try {
          syncConfigJsonFromUi();
        } catch (e) {
          errEl.textContent = 'Could not sync UI to JSON: ' + (e.message || 'error');
          errEl.style.display = 'inline';
          return;
        }
      } else {
        var raw = document.getElementById('full-config').value.trim();
        try {
          var parsed = raw ? JSON.parse(raw) : {};
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Config must be a JSON object.');
          configCache = parsed;
          renderConfigUi(parsed);
        } catch (e) {
          errEl.textContent = 'Invalid JSON — fix before switching to UI: ' + (e.message || 'parse error');
          errEl.style.display = 'inline';
          return;
        }
      }
      configViewMode = next;
      try { localStorage.setItem('pasture-config-view', configViewMode); } catch (_) {}
      applyConfigViewMode();
    }

    function wireConfigViewToggle() {
      if (configToggleWired) return;
      configToggleWired = true;
      document.querySelectorAll('[data-config-view]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          setConfigViewMode(btn.getAttribute('data-config-view'));
        });
      });
    }

    async function fetchConfig() {
      var errEl = document.getElementById('config-error');
      wireConfigViewToggle();
      try {
        var results = await Promise.all([
          fetch(API + '/api/config').then(function (r) { return r.json(); }),
          fetch(API + '/api/skills').then(function (r) { return r.json(); }).catch(function () { return { skills: [] }; }),
          fetch(API + '/api/agents').then(function (r) { return r.json(); }).catch(function () { return { agents: [] }; }),
        ]);
        configCache = results[0];
        configSkillsList = results[1].skills || [];
        configAgentsList = (results[2].agents || []).map(function (a) {
          return { id: a.id, title: a.title || '' };
        });
        if (!configAgentsList.some(function (a) { return a.id === 'main'; })) {
          configAgentsList.unshift({ id: 'main', title: configCache.title || '' });
        }
        if (!configAgentsList.some(function (a) { return a.id === configSelectedAgentId; })) {
          configSelectedAgentId = configAgentsList[0] ? configAgentsList[0].id : 'main';
        }
        configAgentDrafts = { main: configAgentIdentityFromConfig(configCache) };
        configAgentDirtyIds = new Set();
        if (configSelectedAgentId !== 'main') {
          try {
            var selCfg = await fetch(API + '/api/agents/' + encodeURIComponent(configSelectedAgentId) + '/config').then(function (r) { return r.json(); });
            configAgentDrafts[configSelectedAgentId] = configAgentIdentityFromConfig(selCfg);
          } catch (_) {
            configAgentDrafts[configSelectedAgentId] = { title: '', bio: '', color: '' };
          }
        }
        document.getElementById('full-config').value = JSON.stringify(configCache, null, 2);
        renderConfigUi(configCache);
        await fetchTideChecklistForConfig();
        applyConfigViewMode();
        errEl.style.display = 'none';
        errEl.textContent = '';
      } catch (e) {
        errEl.textContent = 'Failed to load config.';
        errEl.style.display = 'inline';
      }
    }

    wireEl('config-save', 'click', async function () {
      var textarea = document.getElementById('full-config');
      var savedEl = document.getElementById('config-saved');
      var errEl = document.getElementById('config-error');
      savedEl.style.display = 'none';
      errEl.style.display = 'none';
      errEl.textContent = '';
      var config;
      try {
        if (configViewMode === 'ui') {
          config = collectConfigFromUi(configCache || {});
        } else {
          var raw = textarea.value.trim();
          config = raw ? JSON.parse(raw) : {};
          if (typeof config !== 'object' || config === null || Array.isArray(config)) {
            throw new Error('Config must be a JSON object.');
          }
        }
      } catch (e) {
        errEl.textContent = e.message || 'Invalid config.';
        errEl.style.display = 'inline';
        return;
      }
      try {
        var r = await fetch(API + '/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
        if (!r.ok) {
          var d = await r.json().catch(function () { return {}; });
          throw new Error(d.error || 'Save failed');
        }
        var d = await r.json();
        configCache = d;
        configAgentDrafts.main = configAgentIdentityFromConfig(d);
        var dirtyAgents = Array.from(configAgentDirtyIds).filter(function (id) { return id && id !== 'main'; });
        for (var i = 0; i < dirtyAgents.length; i++) {
          var agentId = dirtyAgents[i];
          var draft = configAgentDrafts[agentId];
          if (!draft) continue;
          var patchBody = {
            title: String(draft.title || '').trim(),
            bio: String(draft.bio || '').trim(),
            color: String(draft.color || '').trim(),
          };
          var pr = await fetch(API + '/api/agents/' + encodeURIComponent(agentId) + '/config', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patchBody),
          });
          if (!pr.ok) {
            var pd = await pr.json().catch(function () { return {}; });
            throw new Error(pd.error || 'Failed to save agent ' + agentId);
          }
          var savedCfg = await pr.json();
          configAgentDrafts[agentId] = configAgentIdentityFromConfig(savedCfg);
          var listAgent = configAgentsList.find(function (a) { return a.id === agentId; });
          if (listAgent) listAgent.title = savedCfg.title || '';
        }
        configAgentDirtyIds = new Set();
        textarea.value = JSON.stringify(d, null, 2);
        renderConfigUi(d);
        await fetchTideChecklistForConfig();
        savedEl.style.display = 'inline';
        setTimeout(function () { savedEl.style.display = 'none'; }, 2500);
      } catch (e) {
        errEl.textContent = e.message || 'Failed to save config.';
        errEl.style.display = 'inline';
      }
    });

    var testRawResults = {};
    var testInputsCache = {};
    var testStatusMap = {};
    var testListCache = [];
    var activeTestId = null;
    var activeTestGroup = 'all';
    var activeStatusFilter = 'all';
    var activeSearchQuery = '';
    var activeCaseIdx = null;
    var testRunBusy = false;
    var TEST_GROUP_ORDER = [
      'Core Skills',
      'Agent-to-Agent',
      'User Skills',
      'Memory & Workspace',
      'Utilities & Infra',
      'Other Tests',
    ];
    var TEST_GROUP_BY_ID = {
      'agent': 'Agent-to-Agent',
      'agent-config': 'Agent-to-Agent',
      'agent-map-ui': 'Agent-to-Agent',
      'agent-send': 'Agent-to-Agent',
      'agent-team': 'Agent-to-Agent',
      'background-tasks': 'Agent-to-Agent',
      'chat-session': 'Agent-to-Agent',
      'conversation-context': 'Agent-to-Agent',
      'intent-planner': 'Agent-to-Agent',
      'retrospective': 'Agent-to-Agent',
      'session-bootstrap': 'Agent-to-Agent',
      'basic': 'Core Skills',
      'edit': 'Core Skills',
      'e2e-expect': 'Core Skills',
      'go-read': 'Core Skills',
      'go-write': 'Core Skills',
      'output-parse': 'Core Skills',
      'read': 'Core Skills',
      'search': 'Core Skills',
      'vision': 'Core Skills',
      'write': 'Core Skills',
      'apply-patch': 'Core Skills',
      'apply-patch-unit': 'Core Skills',
      'browser': 'Core Skills',
      'calendar-skill': 'User Skills',
      'cron': 'User Skills',
      'github-skill': 'User Skills',
      'gmail-skill': 'User Skills',
      'gog': 'User Skills',
      'home-assistant': 'User Skills',
      'home-assistant-format': 'User Skills',
      'speech': 'User Skills',
      'telegram-send': 'User Skills',
      'fixture-state': 'Memory & Workspace',
      'me': 'Memory & Workspace',
      'memory': 'Memory & Workspace',
      'memory-index-files': 'Memory & Workspace',
      'workspace-chat-days': 'Memory & Workspace',
      'workspace-path': 'Memory & Workspace',
      'credential-utils': 'Utilities & Infra',
      'dry-run': 'Utilities & Infra',
      'server-inspect': 'Utilities & Infra',
      'skill-install': 'Utilities & Infra',
      'test-output-parse': 'Utilities & Infra',
      'tide': 'Utilities & Infra',
      'tide-checklist': 'Utilities & Infra',
      'update-build': 'Utilities & Infra',
    };

    function getTestGroupName(testId) {
      return TEST_GROUP_BY_ID[testId] || 'Other Tests';
    }

    function groupTestsByCategory(tests) {
      var buckets = {};
      TEST_GROUP_ORDER.forEach(function (name) { buckets[name] = []; });
      tests.forEach(function (t) {
        var groupName = getTestGroupName(t.id);
        if (!buckets[groupName]) buckets[groupName] = [];
        buckets[groupName].push(t);
      });
      return TEST_GROUP_ORDER.filter(function (name) { return buckets[name] && buckets[name].length; }).map(function (name) {
        return { name: name, tests: buckets[name] };
      });
    }

    function getVisibleTests(tests) {
      var filtered = activeTestGroup === 'all' ? tests.slice() : tests.filter(function (t) { return getTestGroupName(t.id) === activeTestGroup; });
      if (activeSearchQuery) {
        var q = activeSearchQuery.toLowerCase();
        filtered = filtered.filter(function (t) { return (t.name || t.id).toLowerCase().indexOf(q) >= 0; });
      }
      if (activeStatusFilter === 'fail') filtered = filtered.filter(function (t) { return testStatusMap[t.id] === false; });
      else if (activeStatusFilter === 'notrun') filtered = filtered.filter(function (t) { return testStatusMap[t.id] === undefined; });
      return filtered;
    }

    function updateRunSummary() {
      var el = document.getElementById('test-run-summary');
      if (!el) return;
      var tests = testListCache;
      var done = tests.filter(function (t) { return testStatusMap[t.id] !== undefined; });
      if (!done.length) { el.className = 'test-run-summary'; return; }
      var passed = done.filter(function (t) { return !!testStatusMap[t.id]; }).length;
      var failed = done.filter(function (t) { return !testStatusMap[t.id]; }).length;
      var notRun = tests.length - done.length;
      el.innerHTML = tests.length + ' tests · ' +
        '<span class="s-pass">' + passed + ' passed</span> · ' +
        '<span class="s-fail">' + failed + ' failed</span> · ' +
        notRun + ' not run';
      el.className = 'test-run-summary visible';
    }

    function getStatusIcon(testId) {
      if (testStatusMap[testId] === undefined) return '<span class="test-status-icon notrun">○</span>';
      return testStatusMap[testId]
        ? '<span class="test-status-icon pass">✓</span>'
        : '<span class="test-status-icon fail">✕</span>';
    }

    function renderTestSidebarHtml(tests) {
      var visible = getVisibleTests(tests);
      if (!visible.length) return '<p class="skill-meta" style="padding:0.65rem 0.75rem; margin:0; font-style:italic;">No tests match.</p>';
      return groupTestsByCategory(visible).map(function (group) {
        var groupItems = group.tests.map(function (t) {
          var tid = escapeHtml(t.id);
          var name = escapeHtml(t.name || t.id);
          return '<div class="test-sidebar-item' + (t.id === activeTestId ? ' active' : '') + '" data-test-id="' + tid + '">' +
            getStatusIcon(t.id) +
            '<span class="test-sidebar-name" title="' + name + '">' + name + '</span>' +
            '<button type="button" class="test-run-hover" data-test-id="' + tid + '" title="Run ' + name + '">▶</button>' +
            '</div>';
        }).join('');
        return '<div class="test-sidebar-group">' +
          '<div class="test-sidebar-group-title">' + escapeHtml(group.name) + '</div>' +
          groupItems +
          '</div>';
      }).join('');
    }

    function bindSidebarHandlers(sidebar) {
      sidebar.querySelectorAll('.test-sidebar-item').forEach(function (item) {
        item.addEventListener('click', function (e) {
          if (e.target.classList.contains('test-run-hover')) return;
          showTestDetail(item.getAttribute('data-test-id'));
        });
      });
      sidebar.querySelectorAll('.test-run-hover').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var tid = btn.getAttribute('data-test-id');
          showTestDetail(tid);
          runTest(tid);
        });
      });
    }

    function refreshTestSidebar() {
      var sidebar = document.getElementById('test-sidebar');
      if (!sidebar) return;
      sidebar.innerHTML = renderTestSidebarHtml(testListCache);
      bindSidebarHandlers(sidebar);
      var visibleTests = getVisibleTests(testListCache);
      var visibleHasActive = visibleTests.some(function (t) { return t.id === activeTestId; });
      var nextId = visibleHasActive ? activeTestId : (visibleTests[0] ? visibleTests[0].id : null);
      if (nextId) showTestDetail(nextId);
    }

    function setTestRunBusy(busy) {
      testRunBusy = busy;
      document.querySelectorAll('.test-run-hover').forEach(function (b) { b.disabled = busy; });
      var runAll = document.getElementById('test-run-all');
      if (runAll) runAll.disabled = busy;
      var runSkill = document.getElementById('test-run-skill');
      if (runSkill) runSkill.disabled = busy;
    }

    function countCases(inputs) {
      if (!inputs) return 0;
      return inputs.reduce(function (n, g) { return n + (g.messages || []).length; }, 0);
    }

    function getCaseAt(inputs, idx) {
      var n = 0;
      for (var gi = 0; gi < inputs.length; gi++) {
        var msgs = inputs[gi].messages || [];
        for (var mi = 0; mi < msgs.length; mi++) {
          if (n === idx) return { name: inputs[gi].group || null, input: msgs[mi] };
          n++;
        }
      }
      return null;
    }

    function buildCasesSection(testId, inputs) {
      var parsed = testRawResults[testId] ? parseTestOutput(testRawResults[testId]) : null;
      var html = '<div class="test-cases-section">';
      html += '<div class="test-cases-label">Test Cases</div>';
      if (!inputs) {
        html += '<div style="padding:0.5rem 1rem; font-size:0.82rem; color:var(--muted);">Loading…</div>';
      } else {
        var total = countCases(inputs);
        if (!total) {
          html += '<div style="padding:0.5rem 1rem; font-size:0.82rem; color:var(--muted); font-style:italic;">No test cases defined.</div>';
        } else {
          var idx = 0;
          inputs.forEach(function (g) {
            (g.messages || []).forEach(function (m) {
              var caseName = g.group || ('Case ' + (idx + 1));
              var entry = parsed && parsed.entries[idx];
              var iconClass, icon;
              if (!entry) { icon = '○'; iconClass = 'notrun'; }
              else if (entry.pass) { icon = '●'; iconClass = 'pass'; }
              else { icon = '●'; iconClass = 'fail'; }
              var isActive = activeCaseIdx === idx;
              html += '<div class="test-case-row' + (isActive ? ' active' : '') + '" data-case-idx="' + idx + '">' +
                '<span class="test-status-icon ' + iconClass + '">' + icon + '</span>' +
                '<span class="test-case-row-num">' + (idx + 1) + '</span>' +
                '<span class="test-case-row-name">' + escapeHtml(caseName) + '</span>' +
                '</div>';
              idx++;
            });
          });
        }
      }
      html += '</div>';
      return html;
    }

    function buildCaseDetail(testId, idx) {
      var inputs = testInputsCache[testId];
      if (!inputs || idx == null) return '';
      var c = getCaseAt(inputs, idx);
      if (!c) return '';
      var parsed = testRawResults[testId] ? parseTestOutput(testRawResults[testId]) : null;
      var entry = parsed && parsed.entries[idx];
      var caseName = c.name || ('Case ' + (idx + 1));

      var html = '<div class="test-case-detail-inner">';
      html += '<div class="test-case-detail-heading">Case ' + (idx + 1) + ' \u2014 ' + escapeHtml(caseName) + '</div>';

      html += '<div class="test-case-field"><div class="test-case-field-label">Input</div>' +
        '<div class="test-case-field-value">' + escapeHtml(c.input) + '</div></div>';

      if (entry) {
        var statusText = entry.pass ? '✓ Passed' : '✕ Failed';
        var barClass = entry.pass ? 'pass' : 'fail';
        if (entry.durationMs) statusText += ' · ' + (entry.durationMs / 1000).toFixed(1) + ' s';
        html += '<div class="test-case-result-bar ' + barClass + '">' + escapeHtml(statusText) + '</div>';
        var outputText = entry.output || entry.reply;
        if (outputText) {
          html += '<div class="test-case-field"><div class="test-case-field-label">Actual response</div>' +
            '<div class="test-case-field-value ' + (entry.pass ? 'actual-pass' : 'actual-fail') + '">' + escapeHtml(outputText) + '</div></div>';
        }
        if (entry.skillsCalled) {
          html += '<div class="test-case-field"><div class="test-case-field-label">Tool calls</div>' +
            '<div class="test-case-field-value">' + escapeHtml(entry.skillsCalled) + '</div></div>';
        }
        if (entry.judge) {
          html += '<div class="test-case-field"><div class="test-case-field-label">Detail</div>' +
            '<div class="test-case-field-value">' + escapeHtml(entry.judge) + '</div></div>';
        }
        html += '<div class="test-case-detail-actions">' +
          '<button type="button" class="test-run-case-btn" style="font-size:0.78rem;">Run again</button>' +
          '</div>';
      } else {
        html += '<div class="test-case-result-bar notrun">Not run yet</div>';
        html += '<div class="test-case-detail-actions">' +
          '<button type="button" class="test-run-case-btn" style="font-size:0.78rem;">Run test</button>' +
          '</div>';
      }
      html += '</div>';
      return html;
    }

    function selectCase(testId, idx) {
      activeCaseIdx = idx;
      document.querySelectorAll('.test-case-row').forEach(function (row) {
        row.classList.toggle('active', parseInt(row.getAttribute('data-case-idx'), 10) === idx);
      });
      var detailEl = document.getElementById('test-case-detail');
      if (detailEl) {
        detailEl.innerHTML = buildCaseDetail(testId, idx);
        var btn = detailEl.querySelector('.test-run-case-btn');
        if (btn) btn.addEventListener('click', function () { runTest(testId); });
      }
    }

    function bindCaseRowHandlers(testId) {
      document.querySelectorAll('.test-case-row').forEach(function (row) {
        row.addEventListener('click', function () {
          selectCase(testId, parseInt(row.getAttribute('data-case-idx'), 10));
        });
      });
    }

    function buildConfigFields(testId) {
      var test = testListCache.find(function (t) { return t.id === testId; });
      if (!test) return '';
      var fields = [];
      if (test.agent) fields.push(['Agent', test.agent]);
      if (test.model) fields.push(['Model', test.model]);
      if (test.skills) fields.push(['Skills', Array.isArray(test.skills) ? test.skills.join(', ') : test.skills]);
      if (test.timeout) fields.push(['Timeout', test.timeout + 'ms']);
      if (test.fixture) fields.push(['Fixture', test.fixture]);
      if (test.env) fields.push(['Environment', JSON.stringify(test.env)]);
      if (!fields.length) return '<div style="color:var(--muted); font-size:0.82rem; font-style:italic;">No configuration details available.</div>';
      return fields.map(function (f) {
        return '<div class="test-case-field"><div class="test-case-field-label">' + escapeHtml(f[0]) + '</div>' +
          '<div class="test-case-field-value">' + escapeHtml(String(f[1])) + '</div></div>';
      }).join('');
    }

    function updateSidebarStatus(testId, passed) {
      testStatusMap[testId] = passed;
      var item = document.querySelector('.test-sidebar-item[data-test-id="' + testId + '"]');
      if (item) {
        var icon = item.querySelector('.test-status-icon');
        if (icon) {
          icon.className = 'test-status-icon ' + (passed ? 'pass' : 'fail');
          icon.textContent = passed ? '✓' : '✕';
        }
      }
      updateRunSummary();
    }

    function showTestDetail(testId) {
      activeTestId = testId;
      activeCaseIdx = null;
      document.querySelectorAll('.test-sidebar-item').forEach(function (el) {
        el.classList.toggle('active', el.getAttribute('data-test-id') === testId);
      });

      var detailArea = document.getElementById('test-detail-area');
      if (!detailArea) return;

      var test = testListCache.find(function (t) { return t.id === testId; }) || { id: testId, name: testId };
      var groupName = getTestGroupName(testId);
      var inputs = testInputsCache[testId];
      var caseCount = countCases(inputs);
      var testName = test.name || testId;
      var metaParts = [groupName];
      if (caseCount > 0) metaParts.push(caseCount + ' case' + (caseCount !== 1 ? 's' : ''));

      var html = '<div class="test-detail-header">';
      html += '<div class="test-detail-title-area">';
      html += '<div class="test-detail-name">' + escapeHtml(testName) + '</div>';
      html += '<div class="test-detail-meta" id="test-detail-meta">' + escapeHtml(metaParts.join(' · ')) + '</div>';
      html += '</div>';
      html += '<div class="test-detail-actions">';
      html += '<button type="button" id="test-run-skill" style="font-size:0.8rem;"' + (testRunBusy ? ' disabled' : '') + '>Run test</button>';
      html += '<button type="button" id="test-settings-btn" style="font-size:0.8rem;">Settings</button>';
      html += '</div>';
      html += '</div>';
      html += '<div class="test-detail-scroll" id="test-detail-scroll">';
      html += buildCasesSection(testId, inputs);
      html += '<div id="test-case-detail" class="test-case-detail"></div>';
      html += '</div>';

      detailArea.innerHTML = html;

      var runBtn = document.getElementById('test-run-skill');
      if (runBtn) runBtn.addEventListener('click', function () { runTest(testId); });

      var settingsBtn = document.getElementById('test-settings-btn');
      if (settingsBtn) {
        settingsBtn.addEventListener('click', function () {
          var existing = document.getElementById('test-settings-panel');
          if (existing) { existing.remove(); return; }
          var panel = document.createElement('div');
          panel.id = 'test-settings-panel';
          panel.className = 'test-settings-panel';
          panel.innerHTML = '<div class="test-settings-panel-title">Configuration</div>' + buildConfigFields(testId);
          var header = detailArea.querySelector('.test-detail-header');
          if (header) header.insertAdjacentElement('afterend', panel);
        });
      }

      bindCaseRowHandlers(testId);

      if (!inputs) {
        fetch(API + '/api/tests/inputs/' + encodeURIComponent(testId))
          .then(function (r) { return r.json(); })
          .then(function (d) {
            testInputsCache[testId] = d.messages || [];
            if (activeTestId !== testId) return;
            var scroll = document.getElementById('test-detail-scroll');
            if (scroll) {
              var section = scroll.querySelector('.test-cases-section');
              if (section) section.outerHTML = buildCasesSection(testId, testInputsCache[testId]);
              bindCaseRowHandlers(testId);
            }
            var metaEl = document.getElementById('test-detail-meta');
            if (metaEl) {
              var count = countCases(testInputsCache[testId]);
              var parts = [groupName];
              if (count > 0) parts.push(count + ' case' + (count !== 1 ? 's' : ''));
              metaEl.textContent = parts.join(' · ');
            }
          })
          .catch(function () {});
      }
    }

    function brainEdgeLevel(strength) {
      var n = Number(strength) || 0;
      if (n >= 78) return 'strong';
      if (n >= 52) return 'medium';
      return 'weak';
    }

    function brainHash(text) {
      var h = 2166136261;
      var s = String(text || '');
      for (var i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
      }
      return h >>> 0;
    }

    function brainSeededRandom(seed) {
      var t = seed + 0x6D2B79F5;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }

    function brainScatterPoint(seed, idx, width, height, marginX, marginY) {
      var angle = idx * 2.399963229728653 + brainSeededRandom(seed) * Math.PI * 2;
      var radius = Math.sqrt(brainSeededRandom(seed ^ 0x9E3779B9));
      var cx = width / 2;
      var cy = height / 2;
      var rx = Math.max(1, width / 2 - marginX);
      var ry = Math.max(1, height / 2 - marginY);
      return {
        x: Math.max(marginX, Math.min(width - marginX, cx + Math.cos(angle) * radius * rx)),
        y: Math.max(marginY, Math.min(height - marginY, cy + Math.sin(angle) * radius * ry)),
      };
    }

    function brainMeshPositions(terms, width, height) {
      var w = Math.max(320, width || 900);
      var h = Math.max(260, height || 520);
      var weights = (terms || []).map(function (term) { return Math.max(1, Number(term.weight) || 1); });
      var minWeight = weights.reduce(function (min, weight) { return Math.min(min, weight); }, 100);
      var maxWeight = weights.reduce(function (max, weight) { return Math.max(max, weight); }, 1);
      var span = Math.max(1, maxWeight - minWeight);
      return terms.map(function (term, idx) {
        var weight = Number(term.weight) || 1;
        var seed = brainHash((term.text || '') + ':' + idx);
        var normalized = maxWeight === minWeight ? (weight <= 1 ? 0 : 1 - idx / Math.max(1, terms.length - 1)) : (Math.max(1, weight) - minWeight) / span;
        var tieBreak = weight <= 1 ? 0 : (brainSeededRandom(seed ^ 0xA511E9B3) - 0.5) * 0.9;
        var font = weight <= 1 ? 10 : 10.2 + Math.pow(Math.max(0, Math.min(1, normalized)), 0.58) * 17.8 + tieBreak;
        font = Math.max(10, Math.min(29, font));
        var point = brainScatterPoint(seed, idx, w, h, 28, 18);
        return {
          term: term,
          x: point.x,
          y: point.y,
          font: font,
          cellW: Math.max(56, Math.min(118, String(term.text || '').length * font * 0.58 + 10)),
          cellH: font + 8,
        };
      });
    }

    function brainConnectionGraph(connections) {
      var graph = {};
      (connections || []).forEach(function (c) {
        var from = String(c.from || '');
        var to = String(c.to || '');
        if (!from || !to) return;
        var strength = Number(c.strength) || 1;
        if (!graph[from]) graph[from] = [];
        if (!graph[to]) graph[to] = [];
        graph[from].push({ text: to, strength: strength });
        graph[to].push({ text: from, strength: strength });
      });
      Object.keys(graph).forEach(function (key) {
        graph[key].sort(function (a, b) { return b.strength - a.strength; });
      });
      return graph;
    }

    function brainRelationMap(selectedText, connections) {
      var map = {};
      if (!selectedText) return map;
      map[selectedText] = { depth: 0, strength: 100 };
      var graph = brainConnectionGraph(connections);
      (graph[selectedText] || []).forEach(function (n) {
        map[n.text] = { depth: 1, strength: Math.max(Number(map[n.text]?.strength) || 0, n.strength) };
      });
      (graph[selectedText] || []).forEach(function (n) {
        (graph[n.text] || []).forEach(function (second) {
          if (second.text === selectedText) return;
          var strength = Math.round(Math.min(n.strength, second.strength) * 0.72);
          var prev = map[second.text];
          if (!prev || prev.depth > 2 || (prev.depth === 2 && strength > prev.strength)) {
            map[second.text] = { depth: 2, strength: strength };
          }
        });
      });
      return map;
    }

    function drawBrainMeshCanvas(canvas, terms, connections, selectedText) {
      if (!canvas) return;
      var rect = canvas.getBoundingClientRect();
      var width = Math.max(320, Math.floor(rect.width));
      var height = Math.max(260, Math.floor(rect.height));
      var scale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(width * scale);
      canvas.height = Math.floor(height * scale);
      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, width, height);
      var positions = brainMeshPositions(terms || [], width, height);
      var byText = {};
      positions.forEach(function (pos) { byText[pos.term.text] = pos; });
      canvas.setAttribute('data-brain-word-count', String(positions.length));
      var selectedLinks = brainRelationMap(selectedText, connections);
      (connections || []).slice(0, 1600).forEach(function (c) {
        var a = byText[c.from];
        var b = byText[c.to];
        if (!a || !b) return;
        var strength = Math.max(1, Math.min(100, Number(c.strength) || 1));
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineWidth = 0.35 + (strength / 100) * 0.55;
        ctx.strokeStyle = 'rgba(100,116,139,' + (0.055 + (strength / 100) * 0.075).toFixed(3) + ')';
        ctx.stroke();
      });
      if (selectedText) {
        (connections || []).forEach(function (c) {
          var fromRel = selectedLinks[c.from];
          var toRel = selectedLinks[c.to];
          var visible = fromRel && toRel && Math.max(fromRel.depth, toRel.depth) <= 2;
          if (visible) {
            var a = byText[c.from];
            var b = byText[c.to];
            if (!a || !b) return;
            var level = brainEdgeLevel(c.strength);
            var maxDepth = Math.max(fromRel.depth, toRel.depth);
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.lineWidth = maxDepth === 1 ? (level === 'strong' ? 2.5 : level === 'medium' ? 1.7 : 1.1) : 0.8;
            ctx.strokeStyle = maxDepth === 1 ? 'rgba(148,163,184,0.72)' : 'rgba(100,116,139,0.42)';
            ctx.stroke();
          }
        });
      }
      positions.forEach(function (pos) {
        var text = String(pos.term.text || '');
        var rel = selectedText && selectedLinks[text];
        var selected = rel && rel.depth === 0;
        var alpha = selectedText ? (rel ? (rel.depth === 2 ? 0.56 : 0.96) : 0.11) : 0.48;
        var hue = selected ? '255,255,255' : '219,234,254';
        ctx.font = pos.font.toFixed(2) + 'px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(' + hue + ',' + alpha + ')';
        var label = text.length > 16 ? text.slice(0, 15) + '…' : text;
        ctx.fillText(label, pos.x, pos.y, pos.cellW - 8);
      });
      canvas._brainMeshPositions = positions;
    }

    function nearestBrainMeshTerm(canvas, x, y) {
      var positions = canvas && canvas._brainMeshPositions ? canvas._brainMeshPositions : [];
      var best = null;
      var bestD = Infinity;
      positions.forEach(function (pos) {
        if (Math.abs(pos.x - x) > pos.cellW / 2 + 8 || Math.abs(pos.y - y) > pos.cellH / 2 + 8) return;
        var dx = pos.x - x;
        var dy = pos.y - y;
        var d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = pos;
        }
      });
      return best ? best.term.text : '';
    }

    function renderBrainFocus(selectedText, connections) {
      var focus = document.getElementById('brain-focus');
      if (!focus) return;
      if (!selectedText) {
        focus.hidden = true;
        focus.innerHTML = '';
        return;
      }
      var relationMap = brainRelationMap(selectedText, connections);
      var related = Object.keys(relationMap)
        .filter(function (text) { return text !== selectedText; })
        .map(function (text) { return { text: text, rel: relationMap[text] }; })
        .sort(function (a, b) {
          return a.rel.depth - b.rel.depth || b.rel.strength - a.rel.strength || a.text.localeCompare(b.text);
        })
        .slice(0, 14);
      if (!related.length) {
        focus.hidden = false;
        focus.innerHTML = '<strong>' + escapeHtml(selectedText) + '</strong><span>No mapped connections yet.</span>';
        return;
      }
      focus.hidden = false;
      focus.innerHTML = '<strong>' + escapeHtml(selectedText) + '</strong>' +
        related.map(function (item) {
          var depthLabel = item.rel.depth === 1 ? 'direct' : 'near';
          return '<span class="brain-focus-link brain-focus-depth-' + item.rel.depth + ' brain-focus-' + brainEdgeLevel(item.rel.strength) + '">' +
            escapeHtml(item.text) + ' · ' + depthLabel + ' · ' + escapeHtml(String(item.rel.strength || '')) +
            '</span>';
        }).join('');
    }

    function renderBrainCloud(data) {
      var cloud = document.getElementById('brain-cloud');
      var meta = document.getElementById('brain-meta');
      if (!cloud) return;
      var terms = Array.isArray(data && data.denseTerms) ? data.denseTerms : [];
      var connections = Array.isArray(data && data.denseConnections) ? data.denseConnections : [];
      var stats = data && data.stats ? data.stats : {};
      var sourceCount = [
        stats.memoryFiles ? stats.memoryFiles + ' memory' : '',
        stats.noteFiles ? stats.noteFiles + ' notes' : '',
        stats.historyDays ? stats.historyDays + ' days' : '',
        stats.exchanges ? stats.exchanges + ' exchanges' : '',
        terms.length ? terms.length + ' words' : '',
      ].filter(Boolean).join(' · ');
      if (meta) meta.textContent = sourceCount || 'No memory or history found';
      if (!terms.length) {
        cloud.innerHTML = '<p class="empty">No brain cloud yet.</p>';
        renderBrainFocus('', []);
        return;
      }
      var rect = cloud.getBoundingClientRect();
      cloud.style.minHeight = Math.max(520, Math.round(rect.height || 520)) + 'px';
      cloud.innerHTML = '<canvas class="brain-mesh-canvas" aria-label="Brain word mesh"></canvas>';
      var meshCanvas = cloud.querySelector('.brain-mesh-canvas');
      drawBrainMeshCanvas(meshCanvas, terms, connections, '');
      var hoverTimer = null;
      var pendingHover = '';
      var activeHover = '';

      function clearBrainHover() {
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = null;
        pendingHover = '';
        activeHover = '';
        drawBrainMeshCanvas(meshCanvas, terms, connections, '');
        renderBrainFocus('', connections);
      }

      function applyBrainHover(term) {
        if (!term) {
          clearBrainHover();
          return;
        }
        activeHover = term;
        drawBrainMeshCanvas(meshCanvas, terms, connections, term);
        renderBrainFocus('', connections);
      }

      if (meshCanvas) {
        meshCanvas.addEventListener('mousemove', function (event) {
          var cr = meshCanvas.getBoundingClientRect();
          var selected = nearestBrainMeshTerm(meshCanvas, event.clientX - cr.left, event.clientY - cr.top);
          if (selected === activeHover || selected === pendingHover) return;
          if (hoverTimer) clearTimeout(hoverTimer);
          pendingHover = selected;
          if (!selected) {
            clearBrainHover();
            return;
          }
          hoverTimer = setTimeout(function () {
            if (pendingHover) applyBrainHover(pendingHover);
            hoverTimer = null;
            pendingHover = '';
          }, 160);
        });
        meshCanvas.addEventListener('mouseleave', function () {
          clearBrainHover();
        });
      }
      renderBrainFocus('', connections);
    }

    async function fetchBrainCloud(refresh) {
      var cloud = document.getElementById('brain-cloud');
      if (!cloud) return;
      var rangeEl = document.getElementById('brain-range');
      var sourceEl = document.getElementById('brain-source');
      var range = rangeEl ? rangeEl.value : 'all';
      var source = sourceEl ? sourceEl.value : 'all';
      var hasGraph = !!cloud.querySelector('.brain-mesh-canvas');
      if (!hasGraph || refresh) {
        cloud.innerHTML = '<p class="empty">Loading brain map...</p>';
      }
      var meta = document.getElementById('brain-meta');
      if (meta && hasGraph && !refresh) meta.textContent = 'Checking cached brain map...';
      try {
        var url = API + '/api/brain/cloud?range=' + encodeURIComponent(range) + '&source=' + encodeURIComponent(source);
        if (refresh) url += '&refresh=1';
        var r = await fetch(url);
        var d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Brain cloud failed');
        renderBrainCloud(d);
      } catch (e) {
        cloud.innerHTML = '<p class="empty">Could not load brain cloud.</p>';
        var meta = document.getElementById('brain-meta');
        if (meta) meta.textContent = e && e.message ? e.message : 'Request failed';
      }
    }

    function setBrainImportStatus(text, isError) {
      var el = document.getElementById('brain-meta');
      if (!el) return;
      el.textContent = text || 'Memory and history cloud';
      el.classList.toggle('error', !!isError);
    }

    function guessBrainImportProvider(fileName) {
      var name = String(fileName || '').toLowerCase();
      if (name.indexOf('chatgpt') >= 0 || name.indexOf('openai') >= 0) return 'chatgpt';
      if (name.indexOf('grok') >= 0 || name.indexOf('xai') >= 0) return 'grok';
      if (name.indexOf('claude') >= 0 || name.indexOf('anthropic') >= 0) return 'claude';
      if (name.indexOf('gemini') >= 0 || name.indexOf('google') >= 0) return 'gemini';
      if (name.indexOf('perplexity') >= 0) return 'perplexity';
      if (name.indexOf('copilot') >= 0 || name.indexOf('bing') >= 0) return 'copilot';
      return 'other';
    }

    async function importBrainFiles(files) {
      var submit = document.getElementById('brain-import-submit');
      var input = document.getElementById('brain-import-file');
      var list = Array.prototype.slice.call(files || []);
      if (!list.length) {
        return;
      }
      if (submit) submit.disabled = true;
      setBrainImportStatus('Importing ' + list.length + ' file' + (list.length === 1 ? '' : 's') + '...');
      var imported = 0;
      var messages = 0;
      try {
        for (var i = 0; i < list.length; i++) {
          var file = list[i];
          setBrainImportStatus('Reading ' + (file.name || 'export') + '...');
          var content = await file.text();
          var r = await fetch(API + '/api/brain/import-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              provider: guessBrainImportProvider(file.name),
              filename: file.name || '',
              content: content,
            }),
          });
          var d = await r.json();
          if (!r.ok) throw new Error(d.error || 'Import failed');
          imported += Number(d.conversations || 0);
          messages += Number(d.messages || 0);
        }
        var summary = 'Imported ' + imported + ' conversation' + (imported === 1 ? '' : 's') +
          ' · ' + messages + ' messages';
        setBrainImportStatus(summary);
        fetchBrainCloud(true);
      } catch (e) {
        setBrainImportStatus(e && e.message ? e.message : 'Import failed', true);
      } finally {
        if (submit) submit.disabled = false;
        if (input) input.value = '';
      }
    }

    wireEl('brain-refresh', 'click', function () { fetchBrainCloud(true); });
    wireEl('brain-range', 'change', function () { fetchBrainCloud(true); });
    wireEl('brain-source', 'change', function () { fetchBrainCloud(true); });
    wireEl('brain-import-file', 'change', function (e) {
      importBrainFiles(e && e.target && e.target.files ? e.target.files : []);
    });
    wireEl('brain-import-submit', 'click', function () {
      var input = document.getElementById('brain-import-file');
      if (input) input.click();
    });

    async function fetchTests() {
      try {
        var r = await fetch(API + '/api/tests');
        var d = await r.json();
        testListCache = d.tests || [];
        refreshTestSidebar();
      } catch (e) {
        var sidebar = document.getElementById('test-sidebar');
        if (sidebar) sidebar.innerHTML = '<p class="error" style="padding:0.5rem;">Failed to load tests.</p>';
      }
    }

    function setTestOutput(testId, result, passed) {
      testRawResults[testId] = result;
      updateSidebarStatus(testId, passed);
      if (activeTestId === testId) {
        // Refresh case rows to update status icons
        var scroll = document.getElementById('test-detail-scroll');
        if (scroll) {
          var section = scroll.querySelector('.test-cases-section');
          if (section) section.outerHTML = buildCasesSection(testId, testInputsCache[testId]);
          bindCaseRowHandlers(testId);
          // Re-select case if one was open
          if (activeCaseIdx !== null) selectCase(testId, activeCaseIdx);
        }
      }
    }

    async function runTest(id) {
      var statusEl = document.getElementById('test-run-status');
      if (statusEl) statusEl.textContent = 'Running ' + id + '…';
      setTestRunBusy(true);
      try {
        var r = await fetch(API + '/api/tests/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ testId: id }) });
        var d = await r.json();
        var results = d.results || [];
        if (results.length) {
          var passed = results[0].exitCode === 0;
          setTestOutput(id, results[0], passed);
        }
        if (statusEl) statusEl.textContent = results.every(function (x) { return x.exitCode === 0; }) ? 'Done (passed).' : 'Done (some failed).';
      } catch (e) {
        var err = 'Error: ' + (e.message || 'Request failed');
        setTestOutput(id, { stdout: err, stderr: '', exitCode: 1, durationMs: 0 }, false);
        if (statusEl) statusEl.textContent = err;
      }
      setTestRunBusy(false);
    }

    async function runAllTests() {
      var statusEl = document.getElementById('test-run-status');
      if (statusEl) statusEl.textContent = 'Running all tests…';
      setTestRunBusy(true);
      try {
        var r = await fetch(API + '/api/tests/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ testId: 'all' }) });
        var d = await r.json();
        var results = d.results || [];
        results.forEach(function (x) {
          setTestOutput(x.testId, x, x.exitCode === 0);
        });
        var passedCount = results.filter(function (x) { return x.exitCode === 0; }).length;
        if (statusEl) statusEl.textContent = 'Done: ' + passedCount + '/' + results.length + ' passed.';
      } catch (e) {
        if (statusEl) statusEl.textContent = 'Error: ' + (e.message || '');
      }
      setTestRunBusy(false);
    }

    wireEl('test-run-all', 'click', function () { runAllTests(); });

    var testSearchInput = document.getElementById('test-search');
    if (testSearchInput) {
      testSearchInput.addEventListener('input', function () {
        activeSearchQuery = testSearchInput.value.trim();
        refreshTestSidebar();
      });
    }

    document.querySelectorAll('.test-filter-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        activeStatusFilter = btn.getAttribute('data-filter') || 'all';
        document.querySelectorAll('.test-filter-btn').forEach(function (b) {
          b.classList.toggle('active', b === btn);
        });
        refreshTestSidebar();
      });
    });

    var selectedMemoryFileId = null;
    var selectedMemoryFileReadOnly = false;
    var identityEditorFileId = null;
    var activeTile = 'today';
    var memoryAllLogs = [];
    var memoryAllNotes = [];
    var selectedHistoryId = null;
    var selectedNotesId = null;

    function localDateStr(d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }
    var MEM_TODAY = localDateStr(new Date());
    var MEM_YESTERDAY = localDateStr(new Date(Date.now() - 86400000));
    var MEM_TODAY_ID = 'chat-log/day/' + MEM_TODAY;
    var MEM_YESTERDAY_ID = 'chat-log/day/' + MEM_YESTERDAY;

    function memoryFileLabel(id) {
      if (id === 'MEMORY.md') return 'MEMORY.md';
      if (isMemoryChatDayFile(id)) return id.replace(/^chat-log\/day\//, '');
      if (isMemoryChatLogFile(id)) return id.replace(/^chat-log\//, '').replace(/^group-chat-log\//, 'group /');
      return id;
    }

    function sortMemoryFilesNewestFirst(files) {
      return files.slice().sort(function (a, b) {
        var ta = typeof a.lastActivityMs === 'number' ? a.lastActivityMs : 0;
        var tb = typeof b.lastActivityMs === 'number' ? b.lastActivityMs : 0;
        if (tb !== ta) return tb - ta;
        return String(b.label || b.id || '').localeCompare(String(a.label || a.id || ''));
      });
    }

    function setMemoryTile(tile) {
      activeTile = tile;
      document.querySelectorAll('.memory-tile').forEach(function (btn) {
        btn.classList.toggle('active', btn.getAttribute('data-tile') === tile);
      });
      var panels = ['today','yesterday','longterm','history','notes'];
      panels.forEach(function (t) {
        var el = document.getElementById('mem-panel-' + t);
        if (el) el.classList.toggle('active', t === tile);
      });
      if (tile === 'today') loadMemoryLog(MEM_TODAY_ID, 'mem-today-textarea', function(content) {
        var stat = document.getElementById('mtile-today-stat');
        var lines = content ? content.split('\n').filter(function(l){return l.trim();}).length : 0;
        if (stat) stat.textContent = lines ? lines + ' lines' : 'No chats yet';
      });
      if (tile === 'yesterday') loadMemoryLog(MEM_YESTERDAY_ID, 'mem-yesterday-textarea', null);
      if (tile === 'longterm') loadMemoryMd('MEMORY.md', 'mem-longterm-textarea');
      if (tile === 'history') renderMemoryHistoryList();
      if (tile === 'notes') renderMemoryNotesList();
      history.pushState(null, '', '/memory');
    }

    async function loadMemoryLog(id, textareaId, onLoad) {
      var ta = document.getElementById(textareaId);
      if (!ta) return;
      ta.value = 'Loading…';
      try {
        var r = await fetch(API + '/api/workspace-logs/' + encodeURIComponent(id));
        if (!r.ok) { ta.value = ''; if (onLoad) onLoad(''); return; }
        var d = await r.json();
        ta.value = d.content || '';
        if (onLoad) onLoad(d.content || '');
      } catch(e) { ta.value = ''; if (onLoad) onLoad(''); }
    }

    async function loadMemoryMd(id, textareaId) {
      var ta = document.getElementById(textareaId);
      if (!ta) return;
      ta.value = 'Loading…';
      try {
        var r = await fetch(API + '/api/workspace-md/' + encodeURIComponent(id));
        if (!r.ok) { ta.value = ''; return; }
        var d = await r.json();
        ta.value = d.content || '';
      } catch(e) { ta.value = ''; }
    }

    function renderMemoryHistoryList() {
      var ul = document.getElementById('mem-history-list');
      if (!ul) return;
      var list = memoryAllLogs.filter(function(f) {
        return f.id !== MEM_TODAY_ID && f.id !== MEM_YESTERDAY_ID;
      });
      if (!list.length) {
        ul.innerHTML = '<li class="skill-meta" style="padding:0.25rem 0;">No older history.</li>';
        return;
      }
      ul.innerHTML = list.map(function(f) {
        var label = isMemoryChatDayFile(f.id) ? f.id.replace(/^chat-log\/day\//, '') : memoryFileLabel(f.id);
        return '<li class="' + (selectedHistoryId === f.id ? 'selected' : '') + '"><button type="button" class="link mem-history-btn" data-id="' + escapeHtml(f.id) + '">' + escapeHtml(label) + '</button></li>';
      }).join('');
      ul.querySelectorAll('.mem-history-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { selectHistoryDay(btn.getAttribute('data-id')); });
      });
    }

    async function selectHistoryDay(id) {
      selectedHistoryId = id;
      var titleEl = document.getElementById('mem-history-detail-title');
      var metaEl = document.getElementById('mem-history-detail-meta');
      var ta = document.getElementById('mem-history-textarea');
      if (titleEl) titleEl.textContent = isMemoryChatDayFile(id) ? id.replace(/^chat-log\/day\//, '') : memoryFileLabel(id);
      if (metaEl) metaEl.textContent = id;
      if (ta) ta.value = 'Loading…';
      document.querySelectorAll('.mem-history-btn').forEach(function(btn) {
        var li = btn.closest('li');
        if (li) li.classList.toggle('selected', btn.getAttribute('data-id') === id);
      });
      try {
        var r = await fetch(API + '/api/workspace-logs/' + encodeURIComponent(id));
        if (!r.ok) throw new Error('not found');
        var d = await r.json();
        if (ta) ta.value = d.content || '(empty)';
      } catch(e) { if (ta) ta.value = ''; }
    }

    function renderMemoryNotesList() {
      var ul = document.getElementById('mem-notes-list');
      if (!ul) return;
      var list = memoryAllNotes;
      if (!list.length) {
        ul.innerHTML = '<li class="skill-meta" style="padding:0.25rem 0;">No custom note files.</li>';
        return;
      }
      ul.innerHTML = list.map(function(f) {
        return '<li class="' + (selectedNotesId === f.id ? 'selected' : '') + '"><button type="button" class="link mem-notes-btn" data-id="' + escapeHtml(f.id) + '">' + escapeHtml(f.label || f.id) + '</button></li>';
      }).join('');
      ul.querySelectorAll('.mem-notes-btn').forEach(function(btn) {
        btn.addEventListener('click', function() { selectNotesFile(btn.getAttribute('data-id')); });
      });
    }

    async function selectNotesFile(id) {
      selectedNotesId = id;
      selectedMemoryFileId = id;
      selectedMemoryFileReadOnly = false;
      var titleEl = document.getElementById('mem-notes-detail-title');
      var ta = document.getElementById('mem-notes-textarea');
      var actionsEl = document.getElementById('mem-notes-actions');
      if (titleEl) titleEl.textContent = id;
      if (ta) ta.value = 'Loading…';
      if (actionsEl) actionsEl.style.display = 'flex';
      document.querySelectorAll('.mem-notes-btn').forEach(function(btn) {
        var li = btn.closest('li');
        if (li) li.classList.toggle('selected', btn.getAttribute('data-id') === id);
      });
      try {
        var r = await fetch(API + '/api/workspace-md/' + encodeURIComponent(id));
        if (!r.ok) throw new Error('not found');
        var d = await r.json();
        if (ta) ta.value = d.content || '';
      } catch(e) { if (ta) ta.value = ''; }
    }

    async function fetchMemoryFiles() {
      try {
        var [mdRes, logRes] = await Promise.all([
          fetch(API + '/api/workspace-md'),
          fetch(API + '/api/workspace-logs'),
        ]);
        var mdData = await mdRes.json();
        var logData = await logRes.json();

        memoryAllLogs = sortMemoryFilesNewestFirst(logData.files || []);
        // Notes = everything except MEMORY.md (which is long-term)
        memoryAllNotes = (mdData.files || []).filter(function(f) { return f.id !== 'MEMORY.md'; });

        // Tile stats
        var todayLog = memoryAllLogs.find(function(f) { return f.id === MEM_TODAY_ID; });
        var yestLog = memoryAllLogs.find(function(f) { return f.id === MEM_YESTERDAY_ID; });
        var histCount = memoryAllLogs.filter(function(f) { return f.id !== MEM_TODAY_ID && f.id !== MEM_YESTERDAY_ID; }).length;

        var todayStat = document.getElementById('mtile-today-stat');
        var yestStat = document.getElementById('mtile-yesterday-stat');
        var histStat = document.getElementById('mtile-history-stat');
        var notesStat = document.getElementById('mtile-notes-stat');

        if (todayStat) todayStat.textContent = todayLog ? MEM_TODAY : 'No chats yet';
        if (yestStat) yestStat.textContent = yestLog ? MEM_YESTERDAY : 'No chats';
        if (histStat) histStat.textContent = histCount ? histCount + ' days' : 'No older history';
        if (notesStat) notesStat.textContent = memoryAllNotes.length ? memoryAllNotes.length + ' file' + (memoryAllNotes.length === 1 ? '' : 's') : 'No files';

        // Date labels
        var todayLabel = document.getElementById('mem-today-date-label');
        var yestLabel = document.getElementById('mem-yesterday-date-label');
        if (todayLabel) todayLabel.textContent = MEM_TODAY;
        if (yestLabel) yestLabel.textContent = MEM_YESTERDAY;

        // Re-render active tile if it's one of the list-based ones
        if (activeTile === 'history') renderMemoryHistoryList();
        if (activeTile === 'notes') renderMemoryNotesList();
        // Auto-load today content without re-routing (setMemoryTile would loop via setPage → fetchMemoryFiles)
        if (activeTile === 'today') {
          loadMemoryLog(MEM_TODAY_ID, 'mem-today-textarea', function (content) {
            var stat = document.getElementById('mtile-today-stat');
            var lines = content ? content.split('\n').filter(function (l) { return l.trim(); }).length : 0;
            if (stat) stat.textContent = lines ? lines + ' lines' : 'No chats yet';
          });
        }
      } catch(e) {
        console.error('[memory]', e);
      }
    }

    // Legacy compat: selectMemoryFile is still called from hash navigation
    async function selectMemoryFile(id, readOnly) {
      selectedMemoryFileId = id;
      selectedMemoryFileReadOnly = !!readOnly || isMemoryChatLogFile(id);
      if (!id) return;
      if (id === MEM_TODAY_ID) { setMemoryTile('today'); return; }
      if (id === MEM_YESTERDAY_ID) { setMemoryTile('yesterday'); return; }
      if (id === 'MEMORY.md') { setMemoryTile('longterm'); return; }
      if (isMemoryChatLogFile(id)) { setMemoryTile('history'); await selectHistoryDay(id); return; }
      setMemoryTile('notes'); await selectNotesFile(id);
    }

    // Tile click handlers
    document.querySelectorAll('.memory-tile').forEach(function(btn) {
      btn.addEventListener('click', function() { setMemoryTile(btn.getAttribute('data-tile')); });
    });

    // Long-term save
    wireEl('mem-longterm-save', 'click', async function() {
      var content = document.getElementById('mem-longterm-textarea').value;
      var r = await fetch(API + '/api/workspace-md/MEMORY.md', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: content }) });
      if (r.ok) {
        var savedEl = document.getElementById('mem-longterm-saved');
        if (savedEl) { savedEl.style.display = 'inline'; setTimeout(function(){ savedEl.style.display = 'none'; }, 2000); }
      }
    });

    // Notes save
    wireEl('mem-notes-save', 'click', async function() {
      if (!selectedNotesId) return;
      var content = document.getElementById('mem-notes-textarea').value;
      var r = await fetch(API + '/api/workspace-md/' + encodeURIComponent(selectedNotesId), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: content }) });
      if (r.ok) {
        var savedEl = document.getElementById('mem-notes-saved');
        if (savedEl) { savedEl.style.display = 'inline'; setTimeout(function(){ savedEl.style.display = 'none'; }, 2000); }
      }
    });

    function closeIdentityEditor() {
      var modal = document.getElementById('identity-editor-modal');
      if (!modal) return;
      modal.classList.remove('open');
      modal.setAttribute('aria-hidden', 'true');
      identityEditorFileId = null;
      var savedEl = document.getElementById('identity-editor-modal-saved');
      if (savedEl) savedEl.style.display = 'none';
    }

    function renderHomeIdentityTiles() {
      var grid = document.getElementById('home-identity-tiles');
      if (!grid) return;
      var identityHtml = IDENTITY_FILE_ORDER.map(function (fileId) {
        var label = IDENTITY_FILE_LABELS[fileId] || fileId;
        return '<button type="button" class="soul-tile-link identity-tile-btn" data-file-id="' + escapeHtml(fileId) + '" data-label="' + escapeHtml(label) + '">' +
          '<span class="soul-tile-icon">◇</span>' +
          '<span class="soul-tile-title">' + escapeHtml(label) + '</span>' +
          '<span class="soul-tile-desc">Edit ' + escapeHtml(fileId) + '</span></button>';
      }).join('');
      grid.innerHTML = identityHtml +
        '<a href="#memory" class="soul-tile-link">' +
        '<span class="soul-tile-icon">◇</span>' +
        '<span class="soul-tile-title">Memory</span>' +
        '<span class="soul-tile-desc">Edit MEMORY.md</span></a>';
      grid.querySelectorAll('.identity-tile-btn').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var fileId = btn.getAttribute('data-file-id');
          if (fileId) openIdentityEditor(fileId);
        });
      });
    }

    async function openIdentityEditor(fileId) {
      var label = IDENTITY_FILE_LABELS[fileId] || fileId;
      identityEditorFileId = fileId;
      var modal = document.getElementById('identity-editor-modal');
      var titleEl = document.getElementById('identity-editor-modal-title');
      var metaEl = document.getElementById('identity-editor-modal-meta');
      var textarea = document.getElementById('identity-editor-modal-textarea');
      if (!modal || !titleEl || !metaEl || !textarea) return;
      titleEl.textContent = label;
      metaEl.textContent = 'File: ' + fileId;
      textarea.value = '';
      modal.classList.add('open');
      modal.setAttribute('aria-hidden', 'false');
      try {
        var r = await fetch(API + '/api/workspace-md/' + encodeURIComponent(fileId));
        if (!r.ok) throw new Error('Failed to load');
        var d = await r.json();
        textarea.value = d.content || '';
      } catch (e) {
        textarea.value = '';
      }
      textarea.focus();
    }

    renderHomeIdentityTiles();

    wireClick('identity-editor-modal-cancel', closeIdentityEditor);
    var identityEditorSaveBtn = document.getElementById('identity-editor-modal-save');
    if (identityEditorSaveBtn) identityEditorSaveBtn.addEventListener('click', async function () {
      var id = identityEditorFileId;
      if (!id) return;
      var content = document.getElementById('identity-editor-modal-textarea').value;
      var r = await fetch(API + '/api/workspace-md/' + encodeURIComponent(id), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: content }) });
      if (r.ok) {
        var savedEl = document.getElementById('identity-editor-modal-saved');
        savedEl.style.display = 'inline';
        setTimeout(function () { savedEl.style.display = 'none'; }, 2000);
      }
    });
    var identityEditorModal = document.getElementById('identity-editor-modal');
    if (identityEditorModal) {
      identityEditorModal.addEventListener('click', function (e) {
        if (e.target && e.target.id === 'identity-editor-modal') closeIdentityEditor();
      });
    }
    var identityEditorCard = document.querySelector('#identity-editor-modal .modal-card');
    if (identityEditorCard) {
      identityEditorCard.addEventListener('click', function (e) { e.stopPropagation(); });
    }
