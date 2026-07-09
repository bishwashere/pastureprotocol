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

    async function createAgentViaApi(name, fromAgentId, title, teamName, options) {
      options = options || {};
      var body = { id: name };
      if (fromAgentId) body.fromAgentId = fromAgentId;
      if (title && String(title).trim()) body.title = String(title).trim();
      if (teamName && String(teamName).trim()) body.teamName = String(teamName).trim();
      if (options.isolated === true) body.isolated = true;
      if (options.sharedUserMemory !== undefined) body.sharedUserMemory = options.sharedUserMemory !== false;
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
      var teamInput = document.getElementById('agent-create-modal-team');
      if (!modal || !titleInput) return;
      showAgentCreateModalError('');
      titleInput.value = '';
      if (teamInput) teamInput.value = opts.teamName ? String(opts.teamName) : 'default';
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
      var teamInput = document.getElementById('agent-create-modal-team');
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
      var teamName = teamInput ? (teamInput.value || 'default').trim() : 'default';
      if (submitBtn) submitBtn.disabled = true;
      showAgentCreateModalError('');
      try {
        var d = await createAgentViaApi(normalized, fromAgentId, title, teamName || 'default');
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

    function showTeamsPageError(msg) {
      var el = document.getElementById('teams-page-error');
      if (!el) return;
      if (msg) {
        el.textContent = msg;
        el.classList.add('visible');
      } else {
        el.textContent = '';
        el.classList.remove('visible');
      }
    }

    function teamsOptionHtml(teams, selectedId) {
      return (teams || []).map(function (team) {
        var id = String(team.id || 'default');
        var selected = id === selectedId ? ' selected' : '';
        return '<option value="' + escapeHtml(id) + '"' + selected + '>' + escapeHtml(team.name || id) + ' (' + escapeHtml(id) + ')</option>';
      }).join('');
    }

    function teamsCssEscape(value) {
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value || ''));
      return String(value || '').replace(/["\\]/g, '\\$&');
    }

    function projectOptionHtml(projects, selectedId) {
      var html = '<option value="">No project selected</option>';
      html += (projects || []).map(function (project) {
        var id = String(project.id || '');
        var selected = id === String(selectedId || '') ? ' selected' : '';
        return '<option value="' + escapeHtml(id) + '"' + selected + '>' + escapeHtml(project.name || ('Project ' + id)) + '</option>';
      }).join('');
      return html;
    }

    async function fetchTeamsPage() {
      var grid = document.getElementById('teams-page-grid');
      if (!grid) return;
      showTeamsPageError('');
      try {
        var results = await Promise.all([
          fetch(API + '/api/teams').then(function (r) { return r.json(); }),
          fetch(API + '/api/agents').then(function (r) { return r.json(); }),
          fetch(API + '/api/projects').then(function (r) { return r.json(); }),
        ]);
        var teams = Array.isArray(results[0].teams) ? results[0].teams : [];
        var agents = Array.isArray(results[1].agents) ? results[1].agents : [];
        var projects = Array.isArray(results[2]) ? results[2] : [];
        if (!teams.length) teams = [{ id: 'default', name: 'Default team', members: [] }];
        var agentsByTeam = {};
        agents.forEach(function (agent) {
          var tid = String(agent.teamId || 'default');
          if (!agentsByTeam[tid]) agentsByTeam[tid] = [];
          agentsByTeam[tid].push(agent);
        });
        var projectsByTeam = {};
        var unassignedProjects = [];
        projects.forEach(function (project) {
          var tid = String(project.team_id || '');
          if (!tid) {
            unassignedProjects.push(project);
            return;
          }
          if (!projectsByTeam[tid]) projectsByTeam[tid] = [];
          projectsByTeam[tid].push(project);
        });
        grid.innerHTML = teams.map(function (team) {
          var tid = String(team.id || 'default');
          var members = agentsByTeam[tid] || [];
          var teamProjects = projectsByTeam[tid] || [];
          var memberRows = members.length ? members.map(function (agent) {
            return '<div class="teams-member-row" data-agent-id="' + escapeHtml(agent.id) + '">' +
              '<div><strong>' + escapeHtml(agent.title || agent.id) + '</strong><span>' + escapeHtml(agent.id) + '</span></div>' +
              '<select data-team-move-agent="' + escapeHtml(agent.id) + '">' + teamsOptionHtml(teams, tid) + '</select>' +
              '<button type="button" class="secondary" data-team-move-btn="' + escapeHtml(agent.id) + '">Move</button>' +
            '</div>';
          }).join('') : '<p class="skill-meta">No agents in this team.</p>';
          var projectRows = teamProjects.length ? teamProjects.map(function (project) {
            return '<div class="teams-project-row" data-project-id="' + escapeHtml(project.id) + '">' +
              '<div><strong>' + escapeHtml(project.name || ('Project ' + project.id)) + '</strong><span>' + (project.url ? escapeHtml(project.url) : 'No URL') + '</span></div>' +
              '<select data-team-project-target="' + escapeHtml(project.id) + '">' + teamsOptionHtml(teams, tid) + '</select>' +
              '<button type="button" class="secondary" data-team-project-move="' + escapeHtml(project.id) + '">Switch</button>' +
              '<button type="button" class="secondary" data-team-project-clear="' + escapeHtml(project.id) + '">Unassign</button>' +
            '</div>';
          }).join('') : '<p class="skill-meta">No projects assigned. This team will not run multi-agent work until a project is assigned.</p>';
          return '<section class="card teams-card" data-team-id="' + escapeHtml(tid) + '">' +
            '<div class="teams-card-head">' +
              '<div class="field teams-name-field"><label>Team</label><input data-team-name-input="' + escapeHtml(tid) + '" type="text" value="' + escapeHtml(team.name || tid) + '"></div>' +
              '<button type="button" data-team-rename="' + escapeHtml(tid) + '">Save name</button>' +
            '</div>' +
            '<div class="teams-card-meta">' + members.length + ' agent' + (members.length === 1 ? '' : 's') + ' · ' + teamProjects.length + ' project' + (teamProjects.length === 1 ? '' : 's') + '</div>' +
            '<div class="teams-card-actions">' +
              '<button type="button" class="secondary" data-team-create-agent="' + escapeHtml(tid) + '">Create agent in team</button>' +
            '</div>' +
            '<h3>Agents</h3>' + memberRows +
            '<h3>Projects</h3>' + projectRows +
            '<div class="teams-assign-project"><select data-team-assign-project="' + escapeHtml(tid) + '">' + projectOptionHtml(projects, '') + '</select>' +
            '<button type="button" class="secondary" data-team-assign-project-btn="' + escapeHtml(tid) + '">Assign project</button></div>' +
          '</section>';
        }).join('');
        if (unassignedProjects.length) {
          grid.insertAdjacentHTML('beforeend', '<section class="card teams-card"><h2>Unassigned projects</h2>' +
            unassignedProjects.map(function (project) {
              return '<div class="teams-project-row" data-project-id="' + escapeHtml(project.id) + '">' +
                '<div><strong>' + escapeHtml(project.name || ('Project ' + project.id)) + '</strong><span>Not assigned to a team</span></div>' +
                '<select data-team-project-target="' + escapeHtml(project.id) + '">' + teamsOptionHtml(teams, '') + '</select>' +
                '<button type="button" class="secondary" data-team-project-move="' + escapeHtml(project.id) + '">Assign</button>' +
              '</div>';
            }).join('') + '</section>');
        }
      } catch (err) {
        showTeamsPageError(err.message || String(err));
      }
    }

    async function createTeamFromTeamsPage() {
      var input = document.getElementById('teams-new-name');
      var name = input ? String(input.value || '').trim() : '';
      if (!name) { if (input) input.focus(); return; }
      showTeamsPageError('');
      var r = await fetch(API + '/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name }),
      });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) {
        showTeamsPageError(d.error || 'Could not create team.');
        return;
      }
      if (input) input.value = '';
      await fetchTeamsPage();
    }

    async function createIsolatedAgentFromTeamsPage() {
      var input = document.getElementById('teams-isolated-agent-name');
      var title = input ? String(input.value || '').trim() : '';
      if (!title) { if (input) input.focus(); return; }
      var id = normalizeAgentIdInput(title);
      if (!id || id === 'main') {
        showTeamsPageError('Choose a different agent name.');
        return;
      }
      showTeamsPageError('');
      try {
        await createAgentViaApi(id, 'main', title, id, { isolated: true, sharedUserMemory: false });
        if (input) input.value = '';
        await fetchTeamsPage();
        if (typeof fetchAgentsPage === 'function') await fetchAgentsPage();
        if (typeof fetchChatAgents === 'function') await fetchChatAgents();
      } catch (err) {
        showTeamsPageError(err.message || String(err));
      }
    }

    async function moveAgentToTeam(agentId, teamId) {
      var r = await fetch(API + '/api/teams/' + encodeURIComponent(teamId) + '/agents/' + encodeURIComponent(agentId), { method: 'PUT' });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(d.error || 'Could not move agent.');
    }

    async function assignProjectToTeam(projectId, teamId) {
      var r = await fetch(API + '/api/projects/' + encodeURIComponent(projectId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ team_id: teamId || '' }),
      });
      var d = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(d.error || 'Could not update project.');
    }

    wireClick('teams-create-btn', createTeamFromTeamsPage);
    wireClick('teams-refresh-btn', fetchTeamsPage);
    wireClick('teams-create-isolated-btn', createIsolatedAgentFromTeamsPage);
    document.addEventListener('click', async function (e) {
      var target = e.target;
      if (!target || !target.getAttribute) return;
      var renameTeamId = target.getAttribute('data-team-rename');
      var createAgentTeamId = target.getAttribute('data-team-create-agent');
      var moveAgentId = target.getAttribute('data-team-move-btn');
      var assignTeamId = target.getAttribute('data-team-assign-project-btn');
      var moveProjectId = target.getAttribute('data-team-project-move');
      var clearProjectId = target.getAttribute('data-team-project-clear');
      try {
        if (renameTeamId) {
          var input = document.querySelector('[data-team-name-input="' + teamsCssEscape(renameTeamId) + '"]');
          var name = input ? String(input.value || '').trim() : '';
          var r = await fetch(API + '/api/teams/' + encodeURIComponent(renameTeamId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name }),
          });
          var d = await r.json().catch(function () { return {}; });
          if (!r.ok) throw new Error(d.error || 'Could not rename team.');
          await fetchTeamsPage();
        } else if (createAgentTeamId) {
          await openAgentCreateModal({ teamName: createAgentTeamId });
        } else if (moveAgentId) {
          var sel = document.querySelector('[data-team-move-agent="' + teamsCssEscape(moveAgentId) + '"]');
          var nextTeam = sel ? String(sel.value || 'default') : 'default';
          await moveAgentToTeam(moveAgentId, nextTeam);
          await fetchTeamsPage();
          if (typeof fetchAgentsPage === 'function') await fetchAgentsPage();
          if (typeof fetchChatAgents === 'function') await fetchChatAgents();
        } else if (assignTeamId) {
          var assignSel = document.querySelector('[data-team-assign-project="' + teamsCssEscape(assignTeamId) + '"]');
          var projectId = assignSel ? String(assignSel.value || '') : '';
          if (!projectId) return;
          await assignProjectToTeam(projectId, assignTeamId);
          await fetchTeamsPage();
          if (window.pastureProjectsApi && window.pastureProjectsApi.loadProjects) window.pastureProjectsApi.loadProjects();
        } else if (moveProjectId) {
          var targetSel = document.querySelector('[data-team-project-target="' + teamsCssEscape(moveProjectId) + '"]');
          var targetTeam = targetSel ? String(targetSel.value || '') : '';
          if (!targetTeam) return;
          await assignProjectToTeam(moveProjectId, targetTeam);
          await fetchTeamsPage();
          if (window.pastureProjectsApi && window.pastureProjectsApi.loadProjects) window.pastureProjectsApi.loadProjects();
        } else if (clearProjectId) {
          await assignProjectToTeam(clearProjectId, '');
          await fetchTeamsPage();
          if (window.pastureProjectsApi && window.pastureProjectsApi.loadProjects) window.pastureProjectsApi.loadProjects();
        }
      } catch (err) {
        showTeamsPageError(err.message || String(err));
      }
    });

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
        team: document.getElementById(p + '-team'),
        sharedMemory: document.getElementById(p + '-shared-memory'),
        sharedMemoryHint: document.getElementById(p + '-shared-memory-hint'),
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
      if (dom.team) dom.team.value = (cfg.teamId && String(cfg.teamId).trim()) ? String(cfg.teamId).trim() : 'default';
      if (dom.sharedMemory) {
        var isolated = cfg.isolated === true;
        dom.sharedMemory.checked = !isolated && cfg.sharedUserMemory !== false;
        dom.sharedMemory.disabled = isolated;
        if (dom.sharedMemoryHint) {
          dom.sharedMemoryHint.textContent = isolated
            ? 'Isolated agents use their own memory workspace when calling the memory skill.'
            : 'Allow this normal agent to use the memory skill against global user memory.';
        }
      }
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
      var currentTeamId = (cfg.teamId && String(cfg.teamId).trim()) ? String(cfg.teamId).trim() : 'default';
      var inboundFrom = (agentsResp.agents || []).filter(function (a) {
        if (String(a.teamId || 'default') !== currentTeamId) return false;
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
      var others = (agentsResp.agents || []).filter(function (a) {
        return a.id !== agentId && String(a.teamId || 'default') === currentTeamId;
      });
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
        teamName: dom.team ? (dom.team.value || 'default') : 'default',
        sharedUserMemory: dom.sharedMemory ? (dom.sharedMemory.checked && !dom.sharedMemory.disabled) : true,
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
    var CONFIG_LLM_AUTH_TYPES = ['none', 'api_key', 'bearer_token', 'oauth', 'device_code'];

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

    function configModelAuth(model, index) {
      model = model || {};
      var provider = String(model.provider || '').toLowerCase();
      var isLocal = provider === 'lmstudio' || provider === 'ollama';
      if (model.auth && typeof model.auth === 'object') {
        var auth = JSON.parse(JSON.stringify(model.auth));
        auth.type = String(auth.type || (isLocal ? 'none' : 'api_key')).toLowerCase();
        if (!auth.cache) auth.cache = auth.account || ((provider || 'llm') + '-' + (index + 1));
        return auth;
      }
      if (model.apiKey) return { type: 'api_key', env: model.apiKey };
      return { type: isLocal ? 'none' : 'api_key', env: isLocal ? '' : 'LLM_1_API_KEY' };
    }

    function configAuthFieldsHtml(auth, index) {
      auth = auth || { type: 'api_key' };
      var type = String(auth.type || 'api_key').toLowerCase();
      var typeSelect = '<div class="field"><label>Auth type</label><select data-f="authType">' +
        CONFIG_LLM_AUTH_TYPES.map(function (t) {
          return '<option value="' + t + '"' + (t === type ? ' selected' : '') + '>' + t + '</option>';
        }).join('') +
        '</select></div>';
      var apiFields =
        '<div class="field"><label>Auth env var</label><input type="text" data-f="authEnv" value="' + escapeHtml(auth.env || '') + '" placeholder="LLM_1_API_KEY"></div>' +
        '<div class="field"><label>Bearer token file</label><input type="text" data-f="authFile" value="' + escapeHtml(auth.file || '') + '" placeholder="/path/to/token"></div>';
      var oauthFields =
        '<div class="field"><label>Token cache</label><input type="text" data-f="authCache" value="' + escapeHtml(auth.cache || auth.account || ('llm-' + (index + 1))) + '" placeholder="openai-main"></div>' +
        '<div class="field"><label>OAuth client ID</label><input type="text" data-f="authClientId" value="' + escapeHtml(auth.clientId || '') + '" placeholder="client id"></div>' +
        '<div class="field"><label>OAuth authorize URL</label><input type="text" data-f="authAuthorizationUrl" value="' + escapeHtml(auth.authorizationUrl || '') + '" placeholder="https://provider.example/oauth/authorize"></div>' +
        '<div class="field"><label>OAuth token URL</label><input type="text" data-f="authTokenUrl" value="' + escapeHtml(auth.tokenUrl || '') + '" placeholder="https://provider.example/oauth/token"></div>' +
        '<div class="field"><label>OAuth scope</label><input type="text" data-f="authScope" value="' + escapeHtml(auth.scope || (Array.isArray(auth.scopes) ? auth.scopes.join(' ') : '')) + '" placeholder="openid profile"></div>' +
        '<button type="button" class="config-llm-login link-btn" data-login-model="' + index + '"' + (type === 'oauth' || type === 'device_code' ? '' : ' hidden') + '>Login once</button>';
      return typeSelect + apiFields + oauthFields;
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
        var auth = configModelAuth(m, i);
        return '<div class="config-tile-card config-model-card" data-config-model="' + i + '">' +
          '<h4 class="config-tile-card-title">Model ' + (i + 1) + '</h4>' +
          '<div class="form-row"><div class="field"><label>Provider</label><select data-f="provider">' +
          CONFIG_LLM_PROVIDERS.map(function (p) {
            return '<option value="' + p + '"' + (p === provider ? ' selected' : '') + '>' + p + '</option>';
          }).join('') +
          '</select></div></div>' +
          '<div class="field"><label>Model name</label><input type="text" data-f="model" value="' + escapeHtml(m.model || '') + '" placeholder="gpt-4o, local"></div>' +
          '<div class="field"><label>Base URL (local)</label><input type="text" data-f="baseUrl" value="' + escapeHtml(m.baseUrl || '') + '" placeholder="http://127.0.0.1:1234/v1"></div>' +
          configAuthFieldsHtml(auth, i) +
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
          '<p class="skill-meta" style="margin:0;">Use <strong>JSON</strong> mode for keys not shown in the UI. Click <strong>Save</strong> to write the live runtime config at <code>~/.pasture/config.json</code>.</p>')
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
          models.push({ provider: 'openai', model: 'gpt-4o', auth: { type: 'api_key', env: 'LLM_1_API_KEY' } });
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
      document.querySelectorAll('.config-model-card [data-f="authType"]').forEach(function (select) {
        if (select.dataset.wired) return;
        select.dataset.wired = '1';
        select.addEventListener('change', function () {
          var card = select.closest('.config-model-card');
          var login = card && card.querySelector('.config-llm-login');
          if (login) login.hidden = select.value !== 'oauth' && select.value !== 'device_code';
        });
      });
      document.querySelectorAll('.config-llm-login').forEach(function (btn) {
        if (btn.dataset.wired) return;
        btn.dataset.wired = '1';
        btn.addEventListener('click', async function () {
          var savedEl = document.getElementById('config-saved');
          var errEl = document.getElementById('config-error');
          if (savedEl) savedEl.style.display = 'none';
          if (errEl) {
            errEl.style.display = 'none';
            errEl.textContent = '';
          }
          try {
            var config = collectConfigFromUi(configCache || {});
            var save = await fetch(API + '/api/config', {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(config)
            });
            if (!save.ok) throw new Error('Save failed before login.');
            configCache = await save.json();
            var modelIndex = Number(btn.getAttribute('data-login-model'));
            var r = await fetch(API + '/api/llm-auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ modelIndex: modelIndex })
            });
            var d = await r.json().catch(function () { return {}; });
            if (!r.ok) throw new Error(d.error || 'Login failed');
            window.open(d.url, '_blank', 'noopener');
            if (savedEl) {
              savedEl.textContent = d.method === 'device_code'
                ? ('Login opened. Enter code ' + d.userCode + ' in the new tab.')
                : 'Login opened. Finish it in the new tab.';
              savedEl.style.display = 'inline';
            }
            if (d.method === 'device_code' && d.id) {
              var polls = 0;
              var timer = setInterval(async function () {
                polls += 1;
                try {
                  var sr = await fetch(API + '/api/llm-auth/device/' + encodeURIComponent(d.id));
                  var sd = await sr.json().catch(function () { return {}; });
                  if (sd.status === 'complete') {
                    clearInterval(timer);
                    if (savedEl) {
                      savedEl.textContent = 'LLM login complete.';
                      savedEl.style.display = 'inline';
                    }
                  } else if (sd.status === 'error') {
                    clearInterval(timer);
                    if (errEl) {
                      errEl.textContent = sd.error || 'Device login failed.';
                      errEl.style.display = 'inline';
                    }
                  } else if (polls > 120) {
                    clearInterval(timer);
                  }
                } catch (_) {}
              }, 3000);
            }
          } catch (e) {
            if (errEl) {
              errEl.textContent = e.message || 'Login failed.';
              errEl.style.display = 'inline';
            }
          }
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
        var authTypeEl = card.querySelector('[data-f="authType"]');
        var authEnvEl = card.querySelector('[data-f="authEnv"]');
        var authFileEl = card.querySelector('[data-f="authFile"]');
        var authCacheEl = card.querySelector('[data-f="authCache"]');
        var authClientIdEl = card.querySelector('[data-f="authClientId"]');
        var authAuthorizationUrlEl = card.querySelector('[data-f="authAuthorizationUrl"]');
        var authTokenUrlEl = card.querySelector('[data-f="authTokenUrl"]');
        var authScopeEl = card.querySelector('[data-f="authScope"]');
        var authType = authTypeEl ? authTypeEl.value : 'api_key';
        var auth = { type: authType };
        if (authType === 'api_key') {
          auth.env = authEnvEl ? authEnvEl.value.trim() || 'LLM_1_API_KEY' : 'LLM_1_API_KEY';
        } else if (authType === 'bearer_token') {
          if (authEnvEl && authEnvEl.value.trim()) auth.env = authEnvEl.value.trim();
          if (authFileEl && authFileEl.value.trim()) auth.file = authFileEl.value.trim();
        } else if (authType === 'oauth' || authType === 'device_code') {
          auth.cache = authCacheEl ? authCacheEl.value.trim() || ('llm-' + (i + 1)) : ('llm-' + (i + 1));
          if (authClientIdEl && authClientIdEl.value.trim()) auth.clientId = authClientIdEl.value.trim();
          if (authAuthorizationUrlEl && authAuthorizationUrlEl.value.trim()) auth.authorizationUrl = authAuthorizationUrlEl.value.trim();
          if (authTokenUrlEl && authTokenUrlEl.value.trim()) auth.tokenUrl = authTokenUrlEl.value.trim();
          if (authScopeEl && authScopeEl.value.trim()) auth.scope = authScopeEl.value.trim();
        }
        var o = {
          provider: providerEl ? providerEl.value.trim() || 'openai' : 'openai',
          model: modelEl ? modelEl.value.trim() || 'gpt-4o' : 'gpt-4o',
          auth: auth,
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

    var BRAIN_SETTINGS_DEFAULTS = {
      directRelations: 12,
      secondRelations: 18,
      visibleWords: 0,
      minVisibleConnections: 1,
      minFont: 10,
      maxFont: 46,
    };
    var BRAIN_FOCUS_NEAR_PUSH_MULTIPLIER = 3;
    var brainSettings = loadBrainSettings();
    var brainCloudLastData = null;
    var brainLoadingTimer = null;
    var brainCloudAbortController = null;
    var brainCloudRequestSeq = 0;
    var brainFullscreenResizeTimer = null;

    function clampBrainNumber(value, fallback, min, max) {
      var n = Number(value);
      if (!Number.isFinite(n)) return fallback;
      return Math.max(min, Math.min(max, Math.round(n)));
    }

    function loadBrainSettings() {
      var saved = {};
      try {
        saved = JSON.parse(localStorage.getItem('brainMeshSettings') || '{}') || {};
      } catch (_) {}
      return {
        directRelations: clampBrainNumber(saved.directRelations, BRAIN_SETTINGS_DEFAULTS.directRelations, 1, 40),
        secondRelations: clampBrainNumber(saved.secondRelations, BRAIN_SETTINGS_DEFAULTS.secondRelations, 0, 80),
        visibleWords: clampBrainNumber(saved.visibleWords, BRAIN_SETTINGS_DEFAULTS.visibleWords, 0, 2600),
        minVisibleConnections: clampBrainNumber(saved.minVisibleConnections, BRAIN_SETTINGS_DEFAULTS.minVisibleConnections, 1, 20),
        minFont: clampBrainNumber(saved.minFont, BRAIN_SETTINGS_DEFAULTS.minFont, 6, 30),
        maxFont: clampBrainNumber(saved.maxFont, BRAIN_SETTINGS_DEFAULTS.maxFont, 12, 80),
      };
    }

    function saveBrainSettings() {
      try {
        localStorage.setItem('brainMeshSettings', JSON.stringify(brainSettings));
      } catch (_) {}
    }

    function rerenderBrainCloud() {
      if (brainCloudLastData) renderBrainCloud(brainCloudLastData);
    }

    function syncBrainFullscreenControls() {
      var on = document.body.classList.contains('brain-fullscreen-mode');
      var toggle = document.getElementById('brain-fullscreen-toggle');
      var exit = document.getElementById('brain-fullscreen-exit');
      if (toggle) {
        toggle.textContent = on ? 'Exit fullscreen' : 'Fullscreen';
        toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
      if (exit) exit.hidden = !on;
    }

    function setBrainFullscreenMode(on) {
      var next = !!on;
      if (document.body.classList.contains('brain-fullscreen-mode') === next) {
        syncBrainFullscreenControls();
        return;
      }
      document.body.classList.toggle('brain-fullscreen-mode', next);
      if (next) toggleBrainSettingsPanel(false);
      syncBrainFullscreenControls();
      requestAnimationFrame(function () {
        if (brainCloudLastData) renderBrainCloud(brainCloudLastData);
      });
    }

    window.setBrainFullscreenMode = setBrainFullscreenMode;

    function brainLastGoodKey() {
      return 'brainMeshLastGood:all:v2';
    }

    function saveBrainLastGood(data) {
      var terms = Array.isArray(data && data.denseTerms) ? data.denseTerms : (Array.isArray(data && data.terms) ? data.terms : []);
      if (!terms.length) return;
      try {
        localStorage.setItem(brainLastGoodKey(), JSON.stringify(data));
      } catch (_) {}
    }

    function loadBrainLastGood() {
      try {
        var parsed = JSON.parse(localStorage.getItem(brainLastGoodKey()) || 'null');
        var terms = Array.isArray(parsed && parsed.denseTerms) ? parsed.denseTerms : (Array.isArray(parsed && parsed.terms) ? parsed.terms : []);
        if (terms.length) return parsed;
      } catch (_) {}
      return null;
    }

    function setBrainActionMode(hasGraph) {
      var btn = document.getElementById('brain-refresh');
      if (!btn) return;
      btn.textContent = hasGraph ? 'Refresh' : 'Generate';
      btn.title = hasGraph ? 'Rebuild the brain graph' : 'Generate the brain graph';
    }

    function stopBrainLoadingProgress() {
      if (brainLoadingTimer) {
        clearInterval(brainLoadingTimer);
        brainLoadingTimer = null;
      }
    }

    function updateBrainLoadingProgress(cloud, progress, fallbackLabel) {
      if (!cloud) return;
      var labelEl = cloud.querySelector('.brain-loading-label');
      var detailEl = cloud.querySelector('.brain-loading-detail');
      var bar = cloud.querySelector('.brain-loading-bar');
      var totalChunks = Number(progress && progress.totalChunks) || 0;
      var doneChunks = Number(progress && progress.doneChunks) || 0;
      var totalFiles = Number(progress && progress.totalFiles) || 0;
      var doneFiles = Number(progress && progress.doneFiles) || 0;
      var remainingFiles = Math.max(0, Number(progress && progress.remainingFiles) || Math.max(0, totalFiles - doneFiles));
      var pct = totalChunks > 0 ? Math.max(4, Math.min(100, Math.round((doneChunks / totalChunks) * 100))) : 6;
      if (bar) bar.style.width = pct + '%';
      if (labelEl) {
        labelEl.textContent = progress && progress.phase === 'error'
          ? 'Brain map failed'
          : totalFiles
            ? 'Processing ' + doneFiles + '/' + totalFiles + ' files'
            : (fallbackLabel || 'Generating brain graph');
      }
      if (detailEl) {
        var parts = [];
        if (totalChunks) parts.push(doneChunks + '/' + totalChunks + ' chunks');
        if (totalFiles) parts.push(remainingFiles + ' files remaining');
        if (progress && Number(progress.cacheHits)) parts.push(Number(progress.cacheHits) + ' cached');
        if (progress && Number(progress.generated)) parts.push(Number(progress.generated) + ' generated');
        if (progress && Number(progress.failed)) parts.push(Number(progress.failed) + ' failed');
        if (progress && progress.currentFile) parts.push(String(progress.currentFile).slice(0, 48));
        if (progress && progress.error) parts.push(String(progress.error).slice(0, 96));
        detailEl.textContent = parts.join(' · ') || (
          progress && progress.phase === 'collecting' ? 'Collecting memory and history' :
          progress && progress.phase === 'quality' ? 'Refining graph quality' :
          progress && progress.phase === 'error' ? 'Request failed' :
          'Generate clicked: preparing sources'
        );
      }
    }

    function showBrainLoadingProgress(cloud, label, progressId) {
      if (!cloud) return;
      stopBrainLoadingProgress();
      cloud.innerHTML =
        '<div class="brain-loading" role="status" aria-live="polite">' +
          '<div class="brain-loading-label">' + escapeHtml(label || 'Generating brain graph') + '</div>' +
          '<div class="brain-loading-track" aria-hidden="true">' +
            '<span class="brain-loading-bar" style="width: 6%"></span>' +
          '</div>' +
          '<div class="brain-loading-detail">Generate clicked: preparing sources</div>' +
        '</div>';
      if (!progressId) return;
      brainLoadingTimer = setInterval(async function () {
        try {
          var r = await fetch(API + '/api/brain/progress?id=' + encodeURIComponent(progressId), { cache: 'no-store' });
          var d = await r.json();
          if (r.ok) {
            updateBrainLoadingProgress(cloud, d, label);
            if (d && d.done && d.phase === 'complete') {
              stopBrainLoadingProgress();
              fetchBrainCloud(false);
            }
          }
        } catch (_) {}
      }, 350);
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

    function brainVisibleWordLimit(width, height, total) {
      if (brainSettings.visibleWords > 0) return Math.max(1, Math.min(total || 0, brainSettings.visibleWords));
      var w = Math.max(320, width || 900);
      var h = Math.max(260, height || 520);
      var area = w * h;
      var density = w < 560 ? 4400 : w < 900 ? 3600 : 2300;
      var limit = Math.round(area / density);
      if (w > 1600) limit += Math.round((w - 1600) / 3.2);
      if (w < 560) limit = Math.min(limit, 95);
      else if (w < 900) limit = Math.min(limit, 180);
      return Math.max(45, Math.min(total || 0, limit));
    }

    function brainConnectionDegrees(connections) {
      var degrees = {};
      (connections || []).forEach(function (c) {
        var from = String(c.from || '');
        var to = String(c.to || '');
        if (!from || !to || from === to) return;
        degrees[from] = (degrees[from] || 0) + 1;
        degrees[to] = (degrees[to] || 0) + 1;
      });
      return degrees;
    }

    function brainVisibleTerms(terms, width, height, connections) {
      var list = Array.isArray(terms) ? terms : [];
      var degrees = brainConnectionDegrees(connections || []);
      var minConnections = clampBrainNumber(brainSettings.minVisibleConnections, BRAIN_SETTINGS_DEFAULTS.minVisibleConnections, 1, 20);
      var eligible = list.filter(function (term) {
        return (degrees[String(term.text || '')] || 0) >= minConnections;
      });
      var limit = brainVisibleWordLimit(width, height, eligible.length);
      var candidateLimit = Math.min(eligible.length, Math.max(limit * 4, limit + 120));
      var candidates = eligible.slice(0, candidateLimit);
      var candidateText = {};
      candidates.forEach(function (term) { candidateText[term.text] = true; });
      var connectedText = {};
      (connections || []).forEach(function (c) {
        if (!candidateText[c.from] || !candidateText[c.to]) return;
        connectedText[c.from] = true;
        connectedText[c.to] = true;
      });
      return candidates
        .filter(function (term) { return connectedText[term.text] && (degrees[String(term.text || '')] || 0) >= minConnections; })
        .slice(0, limit);
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
        var minFont = brainSettings.minFont;
        var smallBoost = w < 560 ? 2.4 : w < 900 ? 1.2 : 0;
        var maxFont = Math.max(minFont + 4, brainSettings.maxFont);
        var fontFloor = minFont + smallBoost;
        var font = weight <= 1 ? fontFloor : fontFloor + Math.pow(Math.max(0, Math.min(1, normalized)), 0.5) * (maxFont - fontFloor) + tieBreak;
        font = Math.max(fontFloor, Math.min(maxFont, font));
        var point = brainScatterPoint(seed, idx, w, h, 32, 22);
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

    function brainClusterClouds(positions, width, height) {
      var list = Array.isArray(positions) ? positions : [];
      if (list.length < 2) return [];
      var proximity = width < 560 ? 78 : width < 900 ? 92 : 112;
      var candidates = [];

      list.forEach(function (center) {
        var near = [];
        var distanceSum = 0;
        var minX = Infinity;
        var maxX = -Infinity;
        var minY = Infinity;
        var maxY = -Infinity;
        list.forEach(function (pos) {
          var dx = pos.x - center.x;
          var dy = pos.y - center.y;
          var rx = proximity + ((center.cellW || 56) + (pos.cellW || 56)) * 0.16;
          var ry = proximity * 0.62 + ((center.cellH || 18) + (pos.cellH || 18)) * 0.2;
          if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) > 1) return;
          near.push(pos);
          distanceSum += Math.sqrt(dx * dx + dy * dy);
          minX = Math.min(minX, pos.x - (pos.cellW || 56) * 0.5);
          maxX = Math.max(maxX, pos.x + (pos.cellW || 56) * 0.5);
          minY = Math.min(minY, pos.y - (pos.cellH || 18) * 0.5);
          maxY = Math.max(maxY, pos.y + (pos.cellH || 18) * 0.5);
        });
        if (near.length < 2) return;
        var x = near.reduce(function (sum, pos) { return sum + pos.x; }, 0) / near.length;
        var y = near.reduce(function (sum, pos) { return sum + pos.y; }, 0) / near.length;
        var seed = brainHash(String(center.term && center.term.text || '') + ':' + near.length);
        candidates.push({
          positions: near,
          x: x + (brainSeededRandom(seed) - 0.5) * 12,
          y: y + (brainSeededRandom(seed ^ 0xA17C) - 0.5) * 12,
          size: near.length,
          compactness: distanceSum / near.length,
          radius: Math.max(36, Math.min(width < 560 ? 88 : 116, Math.max(maxX - minX, maxY - minY) * 0.48 + 34)),
        });
      });

      var selected = [];
      candidates.sort(function (a, b) {
        return b.size - a.size || a.compactness - b.compactness;
      }).forEach(function (cloud) {
        var overlaps = selected.some(function (prev) {
          var dx = cloud.x - prev.x;
          var dy = cloud.y - prev.y;
          var minDistance = Math.min(cloud.radius, prev.radius) * 0.58;
          return dx * dx + dy * dy < minDistance * minDistance;
        });
        if (!overlaps) selected.push(cloud);
      });
      return selected.slice(0, 30);
    }

    function brainDrawClusterClouds(ctx, positions, width, height) {
      var clusters = brainClusterClouds(positions, width, height);
      if (!clusters.length) return;
      var palette = [
        { edge: '125,211,252', core: '56,189,248' },
        { edge: '167,139,250', core: '139,92,246' },
        { edge: '110,231,183', core: '34,197,94' },
        { edge: '226,232,240', core: '148,163,184' },
      ];
      ctx.save();
      ctx.globalCompositeOperation = 'screen';
      clusters.forEach(function (cluster, idx) {
        var color = palette[idx % palette.length];
        var alpha = Math.min(0.074, 0.024 + cluster.size * 0.0036);
        var outer = cluster.radius * 1.38;
        var radial = ctx.createRadialGradient(cluster.x, cluster.y, 0, cluster.x, cluster.y, outer);
        radial.addColorStop(0, 'rgba(' + color.core + ',' + (alpha * 0.74).toFixed(3) + ')');
        radial.addColorStop(0.28, 'rgba(' + color.edge + ',' + alpha.toFixed(3) + ')');
        radial.addColorStop(0.58, 'rgba(' + color.edge + ',' + (alpha * 0.28).toFixed(3) + ')');
        radial.addColorStop(0.82, 'rgba(' + color.edge + ',' + (alpha * 0.07).toFixed(3) + ')');
        radial.addColorStop(1, 'rgba(' + color.edge + ',0)');
        ctx.fillStyle = radial;
        ctx.beginPath();
        ctx.arc(cluster.x, cluster.y, outer, 0, Math.PI * 2);
        ctx.fill();

        cluster.positions.slice(0, 8).forEach(function (pos, pIdx) {
          if (pIdx % 2 && cluster.positions.length > 7) return;
          var seed = brainHash(String(pos.term && pos.term.text || '') + ':cloud');
          var jitterX = (brainSeededRandom(seed) - 0.5) * 14;
          var jitterY = (brainSeededRandom(seed ^ 0xC10D) - 0.5) * 14;
          var spotRadius = Math.max(32, Math.min(72, pos.font * 3.7));
          var spot = ctx.createRadialGradient(pos.x + jitterX, pos.y + jitterY, 0, pos.x + jitterX, pos.y + jitterY, spotRadius);
          spot.addColorStop(0, 'rgba(' + color.edge + ',' + (alpha * 0.52).toFixed(3) + ')');
          spot.addColorStop(0.56, 'rgba(' + color.edge + ',' + (alpha * 0.13).toFixed(3) + ')');
          spot.addColorStop(0.82, 'rgba(' + color.edge + ',' + (alpha * 0.04).toFixed(3) + ')');
          spot.addColorStop(1, 'rgba(' + color.edge + ',0)');
          ctx.fillStyle = spot;
          ctx.beginPath();
          ctx.arc(pos.x + jitterX, pos.y + jitterY, spotRadius, 0, Math.PI * 2);
          ctx.fill();
        });
      });
      ctx.restore();
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
        var edge = {
          strength: strength,
          weight: Number(c.weight) || 0,
          evidence: Number(c.evidence) || 0,
          decay: Number(c.decay) || 0,
        };
        graph[from].push(Object.assign({ text: to }, edge));
        graph[to].push(Object.assign({ text: from }, edge));
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
      var directLimit = brainSettings.directRelations;
      var secondLimit = brainSettings.secondRelations;
      var thirdLimit = Math.max(8, Math.min(60, brainSettings.secondRelations || 18));
      var direct = (graph[selectedText] || []).slice(0, directLimit);
      direct.forEach(function (n) {
        map[n.text] = {
          depth: 1,
          strength: Math.max(Number(map[n.text]?.strength) || 0, n.strength),
          weight: Math.max(Number(map[n.text]?.weight) || 0, Number(n.weight) || 0),
          evidence: Math.max(Number(map[n.text]?.evidence) || 0, Number(n.evidence) || 0),
          decay: Math.max(Number(map[n.text]?.decay) || 0, Number(n.decay) || 0),
        };
      });
      var secondCandidates = {};
      direct.forEach(function (n) {
        (graph[n.text] || []).slice(0, directLimit).forEach(function (second) {
          if (second.text === selectedText) return;
          if (map[second.text]?.depth === 1) return;
          var strength = Math.round(Math.min(n.strength, second.strength) * 0.72);
          var prev = secondCandidates[second.text];
          if (!prev || strength > prev.strength) {
            secondCandidates[second.text] = {
              depth: 2,
              strength: strength,
              weight: Math.min(Number(n.weight) || 0, Number(second.weight) || 0),
              evidence: Math.min(Number(n.evidence) || 0, Number(second.evidence) || 0),
              decay: Math.max(Number(n.decay) || 0, Number(second.decay) || 0),
              via: n.text,
              routeKey: n.text,
            };
          }
        });
      });
      Object.keys(secondCandidates)
        .map(function (text) { return { text: text, rel: secondCandidates[text] }; })
        .sort(function (a, b) {
          return b.rel.strength - a.rel.strength || a.text.localeCompare(b.text);
        })
        .slice(0, secondLimit)
        .forEach(function (item) {
          map[item.text] = item.rel;
        });
      var thirdCandidates = {};
      Object.keys(secondCandidates).forEach(function (secondText) {
        var secondRel = secondCandidates[secondText];
        if (!map[secondText] || map[secondText].depth !== 2) return;
        (graph[secondText] || []).slice(0, Math.max(4, Math.min(18, directLimit))).forEach(function (third) {
          if (third.text === selectedText) return;
          if (map[third.text] && map[third.text].depth <= 2) return;
          var strength = Math.round(Math.min(secondRel.strength, third.strength) * 0.62);
          var prev = thirdCandidates[third.text];
          if (!prev || strength > prev.strength) {
            thirdCandidates[third.text] = {
              depth: 3,
              strength: strength,
              weight: Math.min(Number(secondRel.weight) || 0, Number(third.weight) || 0),
              evidence: Math.min(Number(secondRel.evidence) || 0, Number(third.evidence) || 0),
              decay: Math.max(Number(secondRel.decay) || 0, Number(third.decay) || 0),
              via: secondText,
              routeKey: secondRel.routeKey || secondRel.via || secondText,
            };
          }
        });
      });
      Object.keys(thirdCandidates)
        .map(function (text) { return { text: text, rel: thirdCandidates[text] }; })
        .sort(function (a, b) {
          return b.rel.strength - a.rel.strength || a.text.localeCompare(b.text);
        })
        .slice(0, thirdLimit)
        .forEach(function (item) {
          map[item.text] = item.rel;
        });
      return map;
    }

    function brainMergeRelation(map, text, rel) {
      if (!text || !rel) return;
      var prev = map[text];
      if (!prev || Number(rel.depth) < Number(prev.depth)) {
        map[text] = Object.assign({}, rel);
        return;
      }
      if (Number(rel.depth) === Number(prev.depth)) {
        map[text] = {
          depth: prev.depth,
          strength: Math.max(Number(prev.strength) || 0, Number(rel.strength) || 0),
          weight: Math.max(Number(prev.weight) || 0, Number(rel.weight) || 0),
          evidence: Math.max(Number(prev.evidence) || 0, Number(rel.evidence) || 0),
          decay: Math.max(Number(prev.decay) || 0, Number(rel.decay) || 0),
          via: prev.via || rel.via,
        };
      }
    }

    function brainConnectionRelationMap(connection, connections) {
      var from = String(connection && connection.from || '');
      var to = String(connection && connection.to || '');
      var map = {};
      if (!from || !to) return map;
      [brainRelationMap(from, connections), brainRelationMap(to, connections)].forEach(function (relMap) {
        Object.keys(relMap || {}).forEach(function (text) {
          brainMergeRelation(map, text, relMap[text]);
        });
      });
      var strength = Math.max(1, Math.min(100, Number(connection.strength) || 100));
      map[from] = { depth: 0, strength: 100, edgeStrength: strength };
      map[to] = { depth: 0, strength: 100, edgeStrength: strength };
      return map;
    }

    function brainBlendRelation(fromRel, toRel, t) {
      if (!fromRel && !toRel) return null;
      var fromStrength = fromRel ? Number(fromRel.strength) || 0 : 0;
      var toStrength = toRel ? Number(toRel.strength) || 0 : 0;
      var fromPresence = fromRel ? (fromRel.presence == null ? 1 : Math.max(0, Math.min(1, Number(fromRel.presence) || 0))) : 0;
      var toPresence = toRel ? (toRel.presence == null ? 1 : Math.max(0, Math.min(1, Number(toRel.presence) || 0))) : 0;
      var presence = fromPresence + (toPresence - fromPresence) * t;
      var depth = toRel ? toRel.depth : fromRel.depth;
      return {
        depth: depth,
        strength: fromStrength + (toStrength - fromStrength) * t,
        presence: presence,
        via: toRel?.via || fromRel?.via,
      };
    }

    function brainHoverFont(pos, rel, focusMode) {
      if (!rel) return Math.max(8.5, Math.min(12, pos.font * 0.42));
      var strength = Math.max(1, Math.min(100, Number(rel.strength) || 1));
      var presence = rel.presence == null ? 1 : Math.max(0, Math.min(1, Number(rel.presence) || 0));
      var target;
      var pathFocus = focusMode === 'path';
      if (pathFocus) return pos.font;
      if (rel.depth === 0) target = 52;
      else if (rel.depth === 1) target = 18 + Math.pow(strength / 100, 0.58) * 28;
      else if (rel.depth === 2) target = 11 + Math.pow(strength / 100, 0.7) * 14;
      else if (rel.depth === 3) target = 9 + Math.pow(strength / 100, 0.72) * 9;
      else target = Math.max(8.5, Math.min(12, pos.font * 0.42));
      return pos.font + (target - pos.font) * presence;
    }

    function brainFocusNeighborhood(positions, selectedText, selectedLinks, focusMode, focusPresence, width) {
      var list = Array.isArray(positions) ? positions : [];
      var empty = { candidates: {}, zone: null };
      if (!selectedText || focusMode === 'path' || focusPresence <= 0.01) return empty;
      var focus = null;
      list.some(function (pos) {
        if (String(pos.term?.text || '') !== selectedText) return false;
        focus = pos;
        return true;
      });
      if (!focus) return empty;
      var focusRel = (selectedLinks && selectedLinks[selectedText]) || { depth: 0, strength: 100, presence: 1 };
      var focusFont = brainHoverFont(focus, focusRel, focusMode);
      var label = selectedText.length > 16 ? selectedText.slice(0, 15) + '…' : selectedText;
      var focusWidth = Math.max(72, Math.min(260, String(label || '').length * focusFont * 0.62 + 26));
      var focusHeight = Math.max(32, focusFont * 1.2);
      var rx = Math.max(96, focusWidth * 0.72 + (width < 560 ? 46 : 64));
      var ry = Math.max(58, focusHeight * 1.55 + (width < 560 ? 30 : 42));
      var candidates = {};

      list.forEach(function (pos) {
        var text = String(pos.term?.text || '');
        if (!text || text === selectedText) return;
        var dx = pos.x - focus.x;
        var dy = pos.y - focus.y;
        var normalizedDistance = Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
        if (normalizedDistance > 1) return;
        var presence = Math.max(0, Math.min(1, (1 - normalizedDistance) * 1.25)) * focusPresence;
        if (presence <= 0.08) return;
        candidates[text] = {
          presence: presence,
          distance: Math.sqrt(dx * dx + dy * dy),
          dx: dx,
          dy: dy,
        };
      });

      return {
        candidates: candidates,
        zone: {
          x: focus.x,
          y: focus.y,
          rx: rx + 34,
          ry: ry + 28,
          selectedText: selectedText,
        },
      };
    }

    function brainPushedFocusPositions(positions, focusNeighborhood, width, height) {
      var list = Array.isArray(positions) ? positions : [];
      var candidates = focusNeighborhood && focusNeighborhood.candidates ? focusNeighborhood.candidates : {};
      var zone = focusNeighborhood && focusNeighborhood.zone;
      if (!zone || !Object.keys(candidates).length) return list;
      var rx = Math.max(1, zone.rx || 1);
      var ry = Math.max(1, zone.ry || 1);
      var safeW = Math.max(320, width || 900);
      var safeH = Math.max(260, height || 520);
      return list.map(function (pos) {
        var text = String(pos.term?.text || '');
        var local = candidates[text];
        if (!local) return pos;
        var dx = Number(local.dx) || 0;
        var dy = Number(local.dy) || 0;
        var distance = Math.sqrt(dx * dx + dy * dy);
        var ux;
        var uy;
        if (distance > 0.001) {
          ux = dx / distance;
          uy = dy / distance;
        } else {
          var seed = brainHash(text + ':focus-push');
          var angle = brainSeededRandom(seed) * Math.PI * 2;
          ux = Math.cos(angle);
          uy = Math.sin(angle);
        }
        var normalized = Math.sqrt((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry));
        var edgeDistance = Math.max(rx, ry) * Math.max(0, 1 - normalized);
        var push = Math.max(18, edgeDistance + 22) * Math.max(0, Math.min(1, Number(local.presence) || 0)) * BRAIN_FOCUS_NEAR_PUSH_MULTIPLIER;
        var marginX = Math.max(30, (pos.cellW || 56) * 0.5 + 8);
        var marginY = Math.max(20, (pos.cellH || 18) * 0.5 + 8);
        return Object.assign({}, pos, {
          x: Math.max(marginX, Math.min(safeW - marginX, pos.x + ux * push)),
          y: Math.max(marginY, Math.min(safeH - marginY, pos.y + uy * push)),
        });
      });
    }

    function brainLocalPopFont(pos, localState) {
      var presence = localState ? Math.max(0, Math.min(1, Number(localState.presence) || 0)) : 0;
      var target = Math.max(17, Math.min(28, pos.font * 1.85));
      return pos.font + (target - pos.font) * presence;
    }

    function brainPointInFocusZone(canvas, x, y) {
      var zone = canvas && canvas._brainMeshFocusZone;
      if (!zone) return false;
      var dx = x - zone.x;
      var dy = y - zone.y;
      var rx = Math.max(1, zone.rx || 1);
      var ry = Math.max(1, zone.ry || 1);
      return (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
    }

    function brainDisplaySelected(fromRel, toRel, t) {
      var blended = brainBlendRelation(fromRel, toRel, t);
      return !!(blended && blended.depth === 0 && (blended.presence == null || blended.presence > 0.35));
    }

    function brainLinePresence(relA, relB, selectedText, textA, textB) {
      if (!selectedText || !relA || !relB) return { visible: false, primary: false, presence: 0 };
      var aPresence = relA.presence == null ? 1 : Math.max(0, Math.min(1, Number(relA.presence) || 0));
      var bPresence = relB.presence == null ? 1 : Math.max(0, Math.min(1, Number(relB.presence) || 0));
      var presence = Math.min(aPresence, bPresence);
      var primary = (relA.depth === 0 && relB.depth === 0)
        || (relA.depth === 0 && relB.depth === 1)
        || (relB.depth === 0 && relA.depth === 1);
      var secondary = (relA.depth === 1 && relB.depth === 2 && relB.via === textA)
        || (relB.depth === 1 && relA.depth === 2 && relA.via === textB);
      var tertiary = (relA.depth === 2 && relB.depth === 3 && relB.via === textA)
        || (relB.depth === 2 && relA.depth === 3 && relA.via === textB);
      var sharedRoute = !!(relA.routeKey && relB.routeKey && relA.routeKey === relB.routeKey);
      var tier = primary ? 1 : secondary ? 2 : tertiary ? 3 : 0;
      return { visible: !!tier, primary: primary, tier: tier, sharedRoute: sharedRoute, presence: presence };
    }

    function brainEase(t) {
      var n = Math.max(0, Math.min(1, t));
      return n * n * (3 - 2 * n);
    }

    function brainDrawState(fromRelations, toRelations, progress) {
      var t = brainEase(progress == null ? 1 : progress);
      var selectedLinks = {};
      var keys = {};
      Object.keys(fromRelations || {}).forEach(function (key) { keys[key] = true; });
      Object.keys(toRelations || {}).forEach(function (key) { keys[key] = true; });
      Object.keys(keys).forEach(function (key) {
        var blended = brainBlendRelation(fromRelations && fromRelations[key], toRelations && toRelations[key], t);
        if (blended && blended.presence > 0.01) selectedLinks[key] = blended;
      });
      return selectedLinks;
    }

    function brainRelationPresence(relations) {
      return Object.keys(relations || {}).reduce(function (max, key) {
        var rel = relations[key] || {};
        var presence = rel.presence == null ? 1 : Math.max(0, Math.min(1, Number(rel.presence) || 0));
        return Math.max(max, presence);
      }, 0);
    }

    function brainTransitionFocusPresence(fromRelations, toRelations, progress) {
      var t = brainEase(progress == null ? 1 : progress);
      var fromPresence = brainRelationPresence(fromRelations);
      var toPresence = brainRelationPresence(toRelations);
      return fromPresence + (toPresence - fromPresence) * t;
    }

    function brainInactiveFont(pos) {
      return Math.max(8.5, Math.min(12, pos.font * 0.42));
    }

    function brainHoverAlpha(rel, selectedText, focusMode) {
      if (!selectedText) return 0.48;
      if (!rel) return 0.08;
      var presence = rel.presence == null ? 1 : Math.max(0, Math.min(1, Number(rel.presence) || 0));
      var target;
      var pathFocus = focusMode === 'path';
      if (rel.depth === 0) target = pathFocus ? 0.82 : 1;
      else if (rel.depth === 1) target = pathFocus ? 0.68 : 0.96;
      else if (rel.depth === 2) target = pathFocus ? 0.4 : 0.58;
      else if (rel.depth === 3) target = pathFocus ? 0.22 : 0.3;
      else target = 0.08;
      return 0.08 + (target - 0.08) * presence;
    }

    function brainConnectionCurve(a, b, key) {
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var distance = Math.sqrt(dx * dx + dy * dy) || 1;
      var bendSeed = brainSeededRandom(brainHash(key || '') ^ 0xB41A11);
      var bend = (bendSeed - 0.5) * Math.min(58, Math.max(10, distance * 0.18));
      return {
        cx: (a.x + b.x) / 2 - (dy / distance) * bend,
        cy: (a.y + b.y) / 2 + (dx / distance) * bend,
      };
    }

    function brainDrawConnectionPath(ctx, a, b, key) {
      var curve = brainConnectionCurve(a, b, key);
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(curve.cx, curve.cy, b.x, b.y);
    }

    function brainDistanceToSegment(px, py, ax, ay, bx, by) {
      var dx = bx - ax;
      var dy = by - ay;
      var lenSq = dx * dx + dy * dy;
      if (!lenSq) return Math.sqrt(Math.pow(px - ax, 2) + Math.pow(py - ay, 2));
      var t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
      var x = ax + dx * t;
      var y = ay + dy * t;
      return Math.sqrt(Math.pow(px - x, 2) + Math.pow(py - y, 2));
    }

    function brainLineGlowPresence(pointer) {
      if (!pointer || !pointer.active) return 0;
      if (!pointer.onTerm) return 1;
      if (!pointer.lineGlowFadeStartedAt) return 0;
      var duration = pointer.lineGlowFadeDuration || 1120;
      var elapsed = performance.now() - pointer.lineGlowFadeStartedAt;
      if (elapsed >= duration) return 0;
      return 1 - brainEase(elapsed / duration);
    }

    function brainLinePointerInfluence(a, b, pointer, key) {
      if (!pointer || !a || !b) return 0;
      var glowPresence = brainLineGlowPresence(pointer);
      if (glowPresence <= 0.01) return 0;
      var closest = brainDistanceToCurve(pointer.x, pointer.y, a, b, key);
      var radius = 46;
      if (closest >= radius) return 0;
      var closeness = 1 - closest / radius;
      return closeness * closeness * glowPresence;
    }

    function brainDistanceToCurve(px, py, a, b, key) {
      var curve = brainConnectionCurve(a, b, key);
      var prev = { x: a.x, y: a.y };
      var closest = Infinity;
      for (var i = 1; i <= 14; i++) {
        var t = i / 14;
        var mt = 1 - t;
        var point = {
          x: mt * mt * a.x + 2 * mt * t * curve.cx + t * t * b.x,
          y: mt * mt * a.y + 2 * mt * t * curve.cy + t * t * b.y,
        };
        closest = Math.min(closest, brainDistanceToSegment(px, py, prev.x, prev.y, point.x, point.y));
        prev = point;
      }
      return closest;
    }

    function brainConnectionKey(c) {
      return String(c.from || '') < String(c.to || '')
        ? String(c.from || '') + '->' + String(c.to || '')
        : String(c.to || '') + '->' + String(c.from || '');
    }

    function drawBrainMeshCanvas(canvas, terms, connections, selectedText, transition, pointer) {
      if (!canvas) return;
      var rect = canvas.getBoundingClientRect();
      var width = Math.max(320, Math.floor(rect.width));
      var height = Math.max(260, Math.floor(rect.height));
      var visibleTerms = brainVisibleTerms(terms || [], width, height, connections || []);
      var visibleText = {};
      visibleTerms.forEach(function (term) { visibleText[term.text] = true; });
      var visibleConnections = (connections || []).filter(function (c) {
        return visibleText[c.from] && visibleText[c.to];
      });
      var scale = window.devicePixelRatio || 1;
      canvas.width = Math.floor(width * scale);
      canvas.height = Math.floor(height * scale);
      var ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      var basePositions = brainMeshPositions(visibleTerms, width, height);
      var hasFocus = !!selectedText || !!transition;
      var relationSelectedText = selectedText || transition?.selectedText || '';
      var focusMode = transition?.focusMode || 'word';
      var focusPresence = transition
        ? brainTransitionFocusPresence(transition.fromRelations, transition.toRelations, transition.progress)
        : (hasFocus ? 1 : 0);
      var dimPresence = focusMode === 'path' ? focusPresence * 0.32 : focusPresence * 0.62;
      var selectedLinks = transition
        ? brainDrawState(transition.fromRelations, transition.toRelations, transition.progress)
        : brainRelationMap(relationSelectedText, visibleConnections);
      var focusNeighborhood = brainFocusNeighborhood(basePositions, relationSelectedText, selectedLinks, focusMode, focusPresence, width);
      var localCandidates = focusNeighborhood.candidates || {};
      var positions = brainPushedFocusPositions(basePositions, focusNeighborhood, width, height);
      var byText = {};
      positions.forEach(function (pos) { byText[pos.term.text] = pos; });
      canvas.setAttribute('data-brain-word-count', String(positions.length));
      canvas._brainMeshPositions = positions;
      canvas._brainMeshVisibleConnections = visibleConnections;
      canvas._brainMeshPositionByText = byText;
      canvas._brainMeshHitBoxes = [];
      canvas._brainMeshFocusZone = focusNeighborhood.zone;
      brainDrawClusterClouds(ctx, positions, width, height);
      var baseLineLimit = Math.max(220, Math.min(2600, Math.round((width * height) / 850)));
      visibleConnections.slice(0, baseLineLimit).forEach(function (c) {
        var a = byText[c.from];
        var b = byText[c.to];
        if (!a || !b) return;
        var strength = Math.max(1, Math.min(100, Number(c.strength) || 1));
        var connectionKey = brainConnectionKey(c);
        ctx.beginPath();
        brainDrawConnectionPath(ctx, a, b, connectionKey);
        ctx.lineWidth = 0.35 + (strength / 100) * 0.55;
        ctx.strokeStyle = 'rgba(100,116,139,' + (0.055 + (strength / 100) * 0.075).toFixed(3) + ')';
        ctx.stroke();
        var influence = brainLinePointerInfluence(a, b, pointer, connectionKey);
        if (influence > 0) {
          ctx.beginPath();
          brainDrawConnectionPath(ctx, a, b, connectionKey);
          ctx.lineWidth = 0.9 + influence * 1.8;
          ctx.strokeStyle = 'rgba(125,211,252,' + (0.05 + influence * 0.22).toFixed(3) + ')';
          ctx.stroke();
        }
      });

      function drawBrainFocusedConnections(layerSelectedText, relationMap, layerFocusMode, layerAlpha) {
        if (!layerSelectedText || !relationMap || layerAlpha <= 0.01) return;
        visibleConnections.forEach(function (c) {
          var fromRel = relationMap[c.from];
          var toRel = relationMap[c.to];
          var lineState = brainLinePresence(fromRel, toRel, layerSelectedText, c.from, c.to);
          var isPrimary = lineState.primary;
          var visible = lineState.visible && lineState.presence > 0.02;
          if (visible) {
            var a = byText[c.from];
            var b = byText[c.to];
            if (!a || !b) return;
            var level = brainEdgeLevel(c.strength);
            ctx.beginPath();
            brainDrawConnectionPath(ctx, a, b, brainConnectionKey(c));
            var tierAlpha = lineState.tier === 1 ? 0.76 : lineState.tier === 2 ? 0.42 : 0.2;
            if (layerFocusMode === 'path') tierAlpha *= lineState.tier === 1 ? 0.72 : 0.64;
            if (lineState.sharedRoute && lineState.tier > 1) tierAlpha += 0.08;
            var alpha = tierAlpha * lineState.presence * layerAlpha;
            var baseWidth = lineState.tier === 1
              ? (level === 'strong' ? 2.5 : level === 'medium' ? 1.7 : 1.1)
              : lineState.tier === 2
                ? 0.9
                : 0.55;
            if (lineState.sharedRoute && lineState.tier > 1) baseWidth += 0.25;
            ctx.lineWidth = baseWidth * Math.max(0.35, lineState.presence) * (0.65 + layerAlpha * 0.35);
            ctx.strokeStyle = lineState.tier === 1 ? 'rgba(148,163,184,' + alpha.toFixed(3) + ')' : 'rgba(100,116,139,' + alpha.toFixed(3) + ')';
            ctx.stroke();
          }
        });
      }

      if (transition) {
        var focusLayerProgress = brainEase(transition.progress == null ? 1 : transition.progress);
        drawBrainFocusedConnections(
          transition.fromSelectedText || transition.selectedText || relationSelectedText,
          transition.fromRelations,
          transition.fromFocusMode || focusMode,
          1 - focusLayerProgress
        );
        drawBrainFocusedConnections(
          transition.toSelectedText || selectedText || relationSelectedText,
          transition.toRelations,
          transition.toFocusMode || focusMode,
          focusLayerProgress
        );
      } else if (relationSelectedText) {
        drawBrainFocusedConnections(relationSelectedText, selectedLinks, focusMode, 1);
      }
      positions.slice().sort(function (a, b) {
        var aText = String(a.term.text || '');
        var bText = String(b.term.text || '');
        var aRel = hasFocus && selectedLinks[aText];
        var bRel = hasFocus && selectedLinks[bText];
        var aLocal = hasFocus && !aRel && localCandidates[aText];
        var bLocal = hasFocus && !bRel && localCandidates[bText];
        var aFont = hasFocus ? (aRel ? brainHoverFont(a, aRel, focusMode) : a.font + (brainInactiveFont(a) - a.font) * dimPresence) : a.font;
        var bFont = hasFocus ? (bRel ? brainHoverFont(b, bRel, focusMode) : b.font + (brainInactiveFont(b) - b.font) * dimPresence) : b.font;
        if (aLocal) aFont = brainLocalPopFont(a, aLocal);
        if (bLocal) bFont = brainLocalPopFont(b, bLocal);
        var aSelected = brainDisplaySelected(null, aRel, 1);
        var bSelected = brainDisplaySelected(null, bRel, 1);
        var aOrder = aFont + (aLocal ? 52 : aSelected ? 10 : aRel ? 8 : 0);
        var bOrder = bFont + (bLocal ? 52 : bSelected ? 10 : bRel ? 8 : 0);
        return aOrder - bOrder;
      }).forEach(function (pos) {
        var text = String(pos.term.text || '');
        var rel = hasFocus && selectedLinks[text];
        var localState = hasFocus && !rel && localCandidates[text];
        var selected = brainDisplaySelected(null, rel, 1);
        var displayFont = hasFocus
          ? (rel ? brainHoverFont(pos, rel, focusMode) : localState ? brainLocalPopFont(pos, localState) : pos.font + (brainInactiveFont(pos) - pos.font) * dimPresence)
          : pos.font;
        var inactiveAlpha = 0.48 + (0.08 - 0.48) * dimPresence;
        var localAlpha = localState ? 0.18 + 0.7 * Math.max(0, Math.min(1, Number(localState.presence) || 0)) : inactiveAlpha;
        var alpha = hasFocus ? (rel ? brainHoverAlpha(rel, relationSelectedText, focusMode) : localState ? localAlpha : inactiveAlpha) : 0.48;
        var hue = selected || (focusMode === 'path' && rel) ? '255,255,255' : localState ? '186,230,253' : '219,234,254';
        ctx.font = displayFont.toFixed(2) + 'px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(' + hue + ',' + alpha + ')';
        var label = text.length > 16 ? text.slice(0, 15) + '…' : text;
        var maxWidth = Math.max(56, Math.min(220, String(label || '').length * displayFont * 0.62 + 12));
        ctx.fillText(label, pos.x, pos.y, maxWidth);
        canvas._brainMeshHitBoxes.push({
          term: pos.term,
          x: pos.x,
          y: pos.y,
          w: maxWidth + (localState || selected ? 22 : 16),
          h: displayFont * 1.35 + (localState || selected ? 18 : 12),
          priority: (localState ? 2 : 0) + (selected ? 1 : 0),
        });
      });
    }

    function nearestBrainMeshTerm(canvas, x, y) {
      var hitBoxes = canvas && canvas._brainMeshHitBoxes ? canvas._brainMeshHitBoxes : [];
      var hitBest = null;
      var hitBestD = Infinity;
      hitBoxes.forEach(function (box) {
        if (Math.abs(box.x - x) > box.w / 2 || Math.abs(box.y - y) > box.h / 2) return;
        var dx = box.x - x;
        var dy = box.y - y;
        var d = dx * dx + dy * dy - (box.priority || 0) * 600;
        if (d < hitBestD) {
          hitBestD = d;
          hitBest = box;
        }
      });
      if (hitBest && hitBest.term) return hitBest.term.text;
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

    function nearestBrainMeshConnection(canvas, x, y) {
      var connections = canvas && canvas._brainMeshVisibleConnections ? canvas._brainMeshVisibleConnections : [];
      var byText = canvas && canvas._brainMeshPositionByText ? canvas._brainMeshPositionByText : {};
      var best = null;
      var bestD = Infinity;
      connections.forEach(function (c) {
        var a = byText[c.from];
        var b = byText[c.to];
        if (!a || !b) return;
        var d = brainDistanceToCurve(x, y, a, b, brainConnectionKey(c));
        if (d < bestD) {
          bestD = d;
          best = c;
        }
      });
      return best && bestD <= 34 ? best : null;
    }

    function renderBrainFocus(selectedText, connections, relationMapOverride) {
      var focus = document.getElementById('brain-focus');
      if (!focus) return;
      if (!selectedText) {
        focus.hidden = true;
        focus.innerHTML = '';
        return;
      }
      var relationMap = relationMapOverride || brainRelationMap(selectedText, connections);
      var related = Object.keys(relationMap)
        .filter(function (text) { return text !== selectedText; })
        .map(function (text) { return { text: text, rel: relationMap[text] }; })
        .sort(function (a, b) {
          return a.rel.depth - b.rel.depth || b.rel.strength - a.rel.strength || a.text.localeCompare(b.text);
        });
      if (!related.length) {
        focus.hidden = false;
        focus.innerHTML = '<strong>' + escapeHtml(selectedText) + '</strong><span>No mapped connections yet.</span>';
        return;
      }
      focus.hidden = false;
      focus.innerHTML = '<strong>' + escapeHtml(selectedText) + '</strong>' +
        related.map(function (item) {
          var depthLabel = item.rel.depth === 1 ? 'direct' : item.rel.depth === 2 ? 'near' : 'faint';
          return '<span class="brain-focus-link brain-focus-depth-' + item.rel.depth + ' brain-focus-' + brainEdgeLevel(item.rel.strength) + '">' +
            escapeHtml(item.text) + ' · ' + depthLabel + ' · weight ' + escapeHtml(String(item.rel.strength || '')) +
            '</span>';
        }).join('');
    }

    function renderBrainCloud(data) {
      var cloud = document.getElementById('brain-cloud');
      var meta = document.getElementById('brain-meta');
      if (!cloud) return;
      stopBrainLoadingProgress();
      if (cloud._brainMeshCleanup) {
        cloud._brainMeshCleanup();
        cloud._brainMeshCleanup = null;
      }
      var terms = Array.isArray(data && data.denseTerms) ? data.denseTerms : [];
      var connections = Array.isArray(data && data.denseConnections) ? data.denseConnections : [];
      var stats = data && data.stats ? data.stats : {};
      setBrainActionMode(terms.length > 0);
      var cloudRect = cloud.getBoundingClientRect();
      var visibleCount = brainVisibleTerms(terms, cloudRect.width, cloudRect.height, connections).length;
      var sourceCount = [
        stats.memoryFiles ? stats.memoryFiles + ' memory' : '',
        stats.noteFiles ? stats.noteFiles + ' notes' : '',
        stats.importFiles ? stats.importFiles + ' imports' : '',
        stats.historyDays ? stats.historyDays + ' days' : '',
        stats.exchanges ? stats.exchanges + ' exchanges' : '',
        stats.llmChunks ? stats.llmChunks + ' chunks' : '',
        stats.llmCacheHits ? stats.llmCacheHits + ' cached' : '',
        stats.llmGenerated ? stats.llmGenerated + ' generated' : '',
        stats.rawTerms != null ? 'raw ' + stats.rawTerms + '/' + (stats.rawConnections || 0) : '',
        stats.finalTerms != null ? 'final ' + stats.finalTerms + '/' + (stats.finalConnections || 0) : '',
        terms.length ? visibleCount + ' visible words' : '',
      ].filter(Boolean).join(' · ');
      if (meta) meta.textContent = sourceCount || 'No memory or history found';
      if (!terms.length) {
        stopBrainLoadingProgress();
        var hadSources = Number(stats && stats.chars) > 0 || Number(stats && stats.llmChunks) > 0;
        var llmUnavailable = Number(stats && stats.llmChunks) > 0 &&
          Number(stats && stats.llmFailed) >= Number(stats && stats.llmChunks);
        var emptyText = llmUnavailable
          ? 'Brain extraction could not reach the LLM. Load a local model or check LLM config, then refresh.'
          : hadSources
            ? 'No extracted brain terms yet. Check LLM availability, then refresh.'
            : 'No brain cloud yet.';
        cloud.innerHTML = '<p class="empty">' + escapeHtml(emptyText) + '</p>';
        renderBrainFocus('', []);
        return;
      }
      brainCloudLastData = data;
      saveBrainLastGood(data);
      var rect = cloud.getBoundingClientRect();
      cloud.style.minHeight = document.body.classList.contains('brain-fullscreen-mode')
        ? '100%'
        : Math.max(520, Math.round(rect.height || 520)) + 'px';
      cloud.innerHTML = '<canvas class="brain-mesh-canvas" aria-label="Brain word mesh"></canvas>';
      var meshCanvas = cloud.querySelector('.brain-mesh-canvas');
      drawBrainMeshCanvas(meshCanvas, terms, connections, '');
      var hoverTimer = null;
      var pendingHover = '';
      var activeHover = '';
      var currentFocus = '';
      var currentRelations = {};
      var hoverFrame = null;
      var pointerFrame = null;
      var meshPointer = { x: 0, y: 0, active: false, onTerm: false, lineGlowFadeStartedAt: 0, lineGlowFadeDuration: 1120 };
      var lockedFocus = null;
      var currentFocusMode = 'word';
      var displayedFocus = { label: '', mode: 'word' };

      function stopBrainHoverAnimation() {
        if (hoverFrame) {
          cancelAnimationFrame(hoverFrame);
          hoverFrame = null;
        }
      }

      function drawBrainMeshCurrent() {
        var transition = currentFocus
          ? {
            fromRelations: currentRelations,
            toRelations: currentRelations,
            progress: 1,
            selectedText: currentFocus,
            fromSelectedText: currentFocus,
            toSelectedText: currentFocus,
            focusMode: currentFocusMode,
            fromFocusMode: currentFocusMode,
            toFocusMode: currentFocusMode,
          }
          : null;
        drawBrainMeshCanvas(meshCanvas, terms, connections, currentFocus, transition, meshPointer);
      }

      function scheduleBrainPointerDraw() {
        if (hoverFrame || pointerFrame) return;
        pointerFrame = requestAnimationFrame(function () {
          pointerFrame = null;
          drawBrainMeshCurrent();
          if (brainLineGlowPresence(meshPointer) > 0.01 && meshPointer.onTerm) scheduleBrainPointerDraw();
        });
      }

      function updateBrainPointerTermState(nextOnTerm) {
        var wasOnTerm = meshPointer.onTerm;
        meshPointer.onTerm = !!nextOnTerm;
        if (!wasOnTerm && meshPointer.onTerm) {
          meshPointer.lineGlowFadeStartedAt = performance.now();
        } else if (!meshPointer.onTerm) {
          meshPointer.lineGlowFadeStartedAt = 0;
        }
      }

      function animateBrainHover(nextFocus) {
        stopBrainHoverAnimation();
        var fromRelations = currentRelations || {};
        var toRelations = nextFocus ? nextFocus.relations : {};
        var fromLabel = displayedFocus.label || currentFocus || '';
        var fromMode = displayedFocus.mode || currentFocusMode || 'word';
        var toLabel = nextFocus ? nextFocus.label : '';
        var toMode = nextFocus ? nextFocus.mode : 'word';
        var transitionFocus = toLabel || fromLabel;
        var startedAt = performance.now();
        var duration = 420;
        activeHover = nextFocus ? nextFocus.id : '';
        displayedFocus = { label: toLabel, mode: toMode };

        function step(now) {
          var progress = Math.min(1, (now - startedAt) / duration);
          currentRelations = brainDrawState(fromRelations, toRelations, progress);
          drawBrainMeshCanvas(meshCanvas, terms, connections, toLabel, {
            fromRelations: fromRelations,
            toRelations: toRelations,
            progress: progress,
            selectedText: transitionFocus,
            fromSelectedText: fromLabel,
            toSelectedText: toLabel,
            focusMode: toMode,
            fromFocusMode: fromMode,
            toFocusMode: toMode,
          }, meshPointer);
          if (progress < 1) {
            hoverFrame = requestAnimationFrame(step);
            return;
          }
          hoverFrame = null;
          currentFocus = toLabel;
          currentFocusMode = toMode;
          currentRelations = toRelations;
          activeHover = nextFocus ? nextFocus.id : '';
          if (!currentFocus) drawBrainMeshCanvas(meshCanvas, terms, connections, '', null, meshPointer);
          if (brainLineGlowPresence(meshPointer) > 0.01 && meshPointer.onTerm) scheduleBrainPointerDraw();
        }

        hoverFrame = requestAnimationFrame(step);
      }

      function clearBrainHover() {
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = null;
        pendingHover = null;
        animateBrainHover(null);
        renderBrainFocus('', connections);
      }

      function applyBrainHover(focusTarget) {
        if (!focusTarget) {
          clearBrainHover();
          return;
        }
        animateBrainHover(focusTarget);
        renderBrainFocus(focusTarget.label, connections, focusTarget.relations);
      }

      function focusTargetAtPointer() {
        var selected = nearestBrainMeshTerm(meshCanvas, meshPointer.x, meshPointer.y);
        updateBrainPointerTermState(!!selected);
        if (selected) return brainTermFocus(selected);
        if ((currentFocusMode === 'word' || displayedFocus.mode === 'word') && (currentFocus || displayedFocus.label || activeHover) && brainPointInFocusZone(meshCanvas, meshPointer.x, meshPointer.y)) {
          return null;
        }
        return brainConnectionFocus(nearestBrainMeshConnection(meshCanvas, meshPointer.x, meshPointer.y));
      }

      function brainTermFocus(term) {
        var text = String(term || '');
        return text ? { id: 'term:' + text, label: text, mode: 'word', relations: brainRelationMap(text, connections) } : null;
      }

      function brainConnectionFocus(connection) {
        if (!connection) return null;
        var from = String(connection.from || '');
        var to = String(connection.to || '');
        if (!from || !to) return null;
        return {
          id: 'edge:' + brainConnectionKey(connection),
          label: from + ' ↔ ' + to,
          mode: 'path',
          relations: brainConnectionRelationMap(connection, connections),
        };
      }

      if (meshCanvas) {
        meshCanvas.addEventListener('mousemove', function (event) {
          var cr = meshCanvas.getBoundingClientRect();
          meshPointer.x = event.clientX - cr.left;
          meshPointer.y = event.clientY - cr.top;
          meshPointer.active = true;
          var focusTarget = focusTargetAtPointer();
          var focusId = focusTarget ? focusTarget.id : '';
          scheduleBrainPointerDraw();
          if (lockedFocus) return;
          if (!focusTarget && (currentFocus || displayedFocus.label || activeHover) && brainPointInFocusZone(meshCanvas, meshPointer.x, meshPointer.y)) {
            if (hoverTimer) clearTimeout(hoverTimer);
            hoverTimer = null;
            pendingHover = null;
            return;
          }
          if (focusId === activeHover || (pendingHover && focusId === pendingHover.id)) return;
          if (hoverTimer) clearTimeout(hoverTimer);
          pendingHover = focusTarget;
          if (!focusTarget) {
            clearBrainHover();
            return;
          }
          hoverTimer = setTimeout(function () {
            if (pendingHover) applyBrainHover(pendingHover);
            hoverTimer = null;
            pendingHover = null;
          }, 160);
        });
        meshCanvas.addEventListener('click', function (event) {
          var cr = meshCanvas.getBoundingClientRect();
          meshPointer.x = event.clientX - cr.left;
          meshPointer.y = event.clientY - cr.top;
          meshPointer.active = true;
          var focusTarget = focusTargetAtPointer();
          if (!focusTarget) {
            if ((currentFocus || displayedFocus.label || activeHover) && brainPointInFocusZone(meshCanvas, meshPointer.x, meshPointer.y)) return;
            lockedFocus = null;
            clearBrainHover();
            return;
          }
          if (lockedFocus && lockedFocus.id === focusTarget.id) {
            lockedFocus = null;
            clearBrainHover();
            return;
          }
          lockedFocus = focusTarget;
          if (hoverTimer) clearTimeout(hoverTimer);
          hoverTimer = null;
          pendingHover = null;
          applyBrainHover(focusTarget);
        });
        meshCanvas.addEventListener('mouseleave', function () {
          meshPointer.active = false;
          meshPointer.onTerm = false;
          scheduleBrainPointerDraw();
          if (!lockedFocus) clearBrainHover();
        });
      }
      cloud._brainMeshCleanup = function () {
        if (hoverTimer) clearTimeout(hoverTimer);
        hoverTimer = null;
        stopBrainHoverAnimation();
        if (pointerFrame) cancelAnimationFrame(pointerFrame);
        pointerFrame = null;
      };
      renderBrainFocus('', connections);
    }

    async function fetchBrainCloud(refresh) {
      var cloud = document.getElementById('brain-cloud');
      if (!cloud) return;
      if (brainCloudAbortController) {
        var metaBusy = document.getElementById('brain-meta');
        if (metaBusy) metaBusy.textContent = 'Brain graph generation already running...';
        return;
      }
      var requestSeq = ++brainCloudRequestSeq;
      brainCloudAbortController = window.AbortController ? new AbortController() : null;
      var hasGraph = !!cloud.querySelector('.brain-mesh-canvas');
      if (!hasGraph) {
        var storedBrain = loadBrainLastGood();
        if (storedBrain) {
          renderBrainCloud(storedBrain);
          hasGraph = true;
        }
      }
      setBrainActionMode(hasGraph);
      var progressId = 'brain_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
      if (!hasGraph || refresh) {
        if (refresh) showBrainLoadingProgress(cloud, hasGraph ? 'Rebuilding brain map' : 'Generating brain map', progressId);
      }
      var meta = document.getElementById('brain-meta');
      if (meta && !refresh) meta.textContent = 'Checking for saved brain graph...';
      try {
        saveBrainSettings();
        var url = API + '/api/brain/cloud?progressId=' + encodeURIComponent(progressId);
        if (!refresh) url += '&cacheOnly=1';
        if (refresh) url += '&refresh=1&ts=' + Date.now();
        var r = await fetch(url, {
          cache: refresh ? 'no-store' : 'default',
          signal: brainCloudAbortController ? brainCloudAbortController.signal : undefined,
        });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok) {
          var err = new Error(d.error || 'Brain cloud failed');
          err.needsGenerate = !!d.needsGenerate;
          err.inProgress = !!d.inProgress;
          err.progressId = d.progressId || (d.progress && d.progress.id) || '';
          throw err;
        }
        if (d && d.inProgress) {
          showBrainLoadingProgress(cloud, 'Generating brain graph', d.progressId || progressId);
          return;
        }
        if (requestSeq !== brainCloudRequestSeq) return;
        stopBrainLoadingProgress();
        renderBrainCloud(d);
      } catch (e) {
        if (requestSeq !== brainCloudRequestSeq) return;
        if (refresh && e && e.name === 'AbortError') {
          setBrainActionMode(hasGraph);
          showBrainLoadingProgress(cloud, hasGraph ? 'Rebuilding brain map' : 'Generating brain map', progressId);
          var metaStillRunning = document.getElementById('brain-meta');
          if (metaStillRunning) metaStillRunning.textContent = 'Brain graph generation is still running...';
          return;
        }
        stopBrainLoadingProgress();
        if (e && e.inProgress) {
          setBrainActionMode(false);
          showBrainLoadingProgress(cloud, 'Generating brain graph', e.progressId || '');
          var metaProgress = document.getElementById('brain-meta');
          if (metaProgress) metaProgress.textContent = 'Brain graph generation is already running...';
          return;
        }
        if (e && e.needsGenerate && !brainCloudLastData && !loadBrainLastGood()) {
          setBrainActionMode(false);
          cloud.innerHTML = '<p class="empty">No brain graph yet. Click Generate to create it.</p>';
          renderBrainFocus('', []);
          var metaGenerate = document.getElementById('brain-meta');
          if (metaGenerate) metaGenerate.textContent = 'No generated brain graph yet';
          return;
        }
        if (brainCloudLastData) {
          renderBrainCloud(brainCloudLastData);
        } else {
          var fallbackBrain = loadBrainLastGood();
          if (fallbackBrain) {
            renderBrainCloud(fallbackBrain);
          } else {
            cloud.innerHTML = '<p class="empty">Could not load brain cloud.</p>';
          }
        }
        var meta = document.getElementById('brain-meta');
        if (meta) meta.textContent = e && e.name === 'AbortError' ? 'Brain map request was interrupted' : (e && e.message ? e.message : 'Request failed');
      } finally {
        if (requestSeq === brainCloudRequestSeq) brainCloudAbortController = null;
      }
    }

    function setBrainImportStatus(text, isError) {
      var el = document.getElementById('brain-meta');
      if (!el) return;
      el.textContent = text || 'Memory and history cloud';
      el.classList.toggle('error', !!isError);
    }

    function setBrainImportProgress(percent, label, options) {
      var wrap = document.getElementById('brain-import-progress');
      var bar = document.getElementById('brain-import-progress-bar');
      var labelEl = document.getElementById('brain-import-progress-label');
      if (!wrap || !bar || !labelEl) return;
      var opts = options || {};
      var visible = opts.visible !== false;
      wrap.hidden = !visible;
      if (!visible) {
        wrap.classList.remove('is-indeterminate');
        wrap.setAttribute('aria-valuenow', '0');
        bar.style.width = '0%';
        labelEl.textContent = '';
        return;
      }
      var value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
      wrap.setAttribute('aria-valuenow', String(value));
      bar.style.width = value + '%';
      labelEl.textContent = label || (value + '%');
    }

    function hideBrainImportProgressSoon() {
      setTimeout(function () {
        setBrainImportProgress(0, '', { visible: false });
      }, 1400);
    }

    function guessBrainImportProvider(fileName) {
      var name = String(fileName || '').toLowerCase();
      if (name.indexOf('chatgpt') >= 0 || name.indexOf('openai') >= 0) return 'chatgpt';
      if (/^conversations(?:-\d+)?\.json$/.test(name)) return 'chatgpt';
      if (name.indexOf('grok') >= 0 || name.indexOf('xai') >= 0) return 'grok';
      if (name.indexOf('claude') >= 0 || name.indexOf('anthropic') >= 0) return 'claude';
      if (name.indexOf('gemini') >= 0 || name.indexOf('google') >= 0) return 'gemini';
      if (name.indexOf('perplexity') >= 0) return 'perplexity';
      if (name.indexOf('copilot') >= 0 || name.indexOf('bing') >= 0) return 'copilot';
      return 'other';
    }

    function isBrainZipImportFile(file) {
      var name = String(file && file.name || '').toLowerCase();
      var type = String(file && file.type || '').toLowerCase();
      return name.endsWith('.zip') || type.indexOf('zip') >= 0;
    }

    async function readBrainImportResponse(response) {
      var text = await response.text();
      var data = null;
      try {
        data = text ? JSON.parse(text) : {};
      } catch (_) {
        var clean = text
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        data = { error: clean || 'Import failed' };
      }
      if (!response.ok) throw new Error(data.error || 'Import failed');
      return data;
    }

    function parseBrainImportResponseText(text, ok) {
      var data = null;
      try {
        data = text ? JSON.parse(text) : {};
      } catch (_) {
        var clean = String(text || '')
          .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
          .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        data = { error: clean || 'Import failed' };
      }
      if (!ok) throw new Error(data.error || 'Import failed');
      return data;
    }

    function uploadBrainImportFile(file, uploadUrl, onProgress) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', uploadUrl);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = function (event) {
          if (!event.lengthComputable) return;
          var pct = Math.max(0, Math.min(100, Math.round((event.loaded / event.total) * 100)));
          if (onProgress) onProgress(pct);
        };
        xhr.onload = function () {
          try {
            resolve(parseBrainImportResponseText(xhr.responseText || '', xhr.status >= 200 && xhr.status < 300));
          } catch (err) {
            reject(err);
          }
        };
        xhr.onerror = function () { reject(new Error('Import upload failed')); };
        xhr.onabort = function () { reject(new Error('Import upload canceled')); };
        xhr.send(file);
      });
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
      setBrainImportProgress(0, '0%', { visible: true });
      var imported = 0;
      var messages = 0;
      var reused = 0;
      try {
        for (var i = 0; i < list.length; i++) {
          var file = list[i];
          var fileBaseProgress = Math.round((i / list.length) * 100);
          setBrainImportStatus('Reading ' + (file.name || 'export') + '...');
          setBrainImportProgress(fileBaseProgress, (i + 1) + '/' + list.length, { visible: true });
          var provider = guessBrainImportProvider(file.name);
          var r;
          if (isBrainZipImportFile(file)) {
            setBrainImportStatus('Uploading ' + (file.name || 'export') + '...');
            var uploadUrl = API + '/api/brain/import-chat-file' +
              '?provider=' + encodeURIComponent(provider) +
              '&filename=' + encodeURIComponent(file.name || '') +
              '&contentType=' + encodeURIComponent(file.type || 'application/zip');
            r = await uploadBrainImportFile(file, uploadUrl, function (pct) {
              var overall = Math.round(((i + (pct / 100)) / list.length) * 100);
              setBrainImportProgress(overall, overall + '%', { visible: true });
            });
          } else {
            var body = {
              provider: provider,
              filename: file.name || '',
              contentType: file.type || '',
              content: await file.text(),
            };
            r = await fetch(API + '/api/brain/import-chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(body),
            });
            r = await readBrainImportResponse(r);
          }
          var d = r;
          if (d.reused) reused += 1;
          imported += Number(d.conversations || 0);
          messages += Number(d.messages || 0);
          setBrainImportProgress(Math.round(((i + 1) / list.length) * 100), Math.round(((i + 1) / list.length) * 100) + '%', { visible: true });
        }
        var summary = 'Imported ' + imported + ' conversation' + (imported === 1 ? '' : 's') +
          ' · ' + messages + ' messages' +
          (reused ? ' · ' + reused + ' reused' : '') +
          ' · rebuilding brain map';
        setBrainImportStatus(summary);
        setBrainImportProgress(100, 'Imported', { visible: true });
        setBrainImportProgress(0, '', { visible: false });
        await fetchBrainCloud(true);
      } catch (e) {
        setBrainImportStatus(e && e.message ? e.message : 'Import failed', true);
        setBrainImportProgress(0, 'Failed', { visible: true });
        hideBrainImportProgressSoon();
      } finally {
        if (submit) submit.disabled = false;
        if (input) input.value = '';
      }
    }

    function setBrainSettingsInputs() {
      var pairs = [
        ['brain-setting-direct', brainSettings.directRelations],
        ['brain-setting-second', brainSettings.secondRelations],
        ['brain-setting-words', brainSettings.visibleWords],
        ['brain-setting-min-links', brainSettings.minVisibleConnections],
        ['brain-setting-min-font', brainSettings.minFont],
        ['brain-setting-max-font', brainSettings.maxFont],
      ];
      pairs.forEach(function (pair) {
        var el = document.getElementById(pair[0]);
        if (el) el.value = String(pair[1]);
      });
    }

    function readBrainSettingsInputs() {
      var direct = document.getElementById('brain-setting-direct');
      var second = document.getElementById('brain-setting-second');
      var words = document.getElementById('brain-setting-words');
      var minLinks = document.getElementById('brain-setting-min-links');
      var minFont = document.getElementById('brain-setting-min-font');
      var maxFont = document.getElementById('brain-setting-max-font');
      brainSettings = {
        directRelations: clampBrainNumber(direct && direct.value, BRAIN_SETTINGS_DEFAULTS.directRelations, 1, 40),
        secondRelations: clampBrainNumber(second && second.value, BRAIN_SETTINGS_DEFAULTS.secondRelations, 0, 80),
        visibleWords: clampBrainNumber(words && words.value, BRAIN_SETTINGS_DEFAULTS.visibleWords, 0, 2600),
        minVisibleConnections: clampBrainNumber(minLinks && minLinks.value, BRAIN_SETTINGS_DEFAULTS.minVisibleConnections, 1, 20),
        minFont: clampBrainNumber(minFont && minFont.value, BRAIN_SETTINGS_DEFAULTS.minFont, 6, 30),
        maxFont: clampBrainNumber(maxFont && maxFont.value, BRAIN_SETTINGS_DEFAULTS.maxFont, 12, 80),
      };
      if (brainSettings.maxFont <= brainSettings.minFont) brainSettings.maxFont = brainSettings.minFont + 4;
      saveBrainSettings();
      setBrainSettingsInputs();
      rerenderBrainCloud();
    }

    function toggleBrainSettingsPanel(forceOpen) {
      var panel = document.getElementById('brain-settings-panel');
      if (!panel) return;
      var open = forceOpen != null ? !!forceOpen : panel.hidden;
      panel.hidden = !open;
      if (open) setBrainSettingsInputs();
    }

    wireEl('brain-refresh', 'click', function () { fetchBrainCloud(true); });
    wireEl('brain-fullscreen-toggle', 'click', function () {
      setBrainFullscreenMode(!document.body.classList.contains('brain-fullscreen-mode'));
    });
    wireEl('brain-fullscreen-exit', 'click', function () {
      setBrainFullscreenMode(false);
    });
    syncBrainFullscreenControls();
    window.addEventListener('resize', function () {
      if (!brainCloudLastData) return;
      if (brainFullscreenResizeTimer) clearTimeout(brainFullscreenResizeTimer);
      brainFullscreenResizeTimer = setTimeout(function () {
        brainFullscreenResizeTimer = null;
        rerenderBrainCloud();
      }, 120);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && document.body.classList.contains('brain-fullscreen-mode')) {
        setBrainFullscreenMode(false);
      }
    });
    setBrainSettingsInputs();
    wireEl('brain-settings-toggle', 'click', function (e) {
      if (e) e.stopPropagation();
      toggleBrainSettingsPanel();
    });
    wireEl('brain-settings-panel', 'click', function (e) {
      if (e) e.stopPropagation();
    });
    wireEl('brain-settings-apply', 'click', readBrainSettingsInputs);
    wireEl('brain-settings-reset', 'click', function () {
      brainSettings = {
        directRelations: BRAIN_SETTINGS_DEFAULTS.directRelations,
        secondRelations: BRAIN_SETTINGS_DEFAULTS.secondRelations,
        visibleWords: BRAIN_SETTINGS_DEFAULTS.visibleWords,
        minVisibleConnections: BRAIN_SETTINGS_DEFAULTS.minVisibleConnections,
        minFont: BRAIN_SETTINGS_DEFAULTS.minFont,
        maxFont: BRAIN_SETTINGS_DEFAULTS.maxFont,
      };
      saveBrainSettings();
      setBrainSettingsInputs();
      rerenderBrainCloud();
    });
    document.addEventListener('click', function (event) {
      var panel = document.getElementById('brain-settings-panel');
      var wrap = document.querySelector('.brain-settings');
      if (!panel || panel.hidden || !wrap) return;
      if (!wrap.contains(event.target)) panel.hidden = true;
    });
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
