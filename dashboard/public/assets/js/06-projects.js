// ── Projects ────────────────────────────────────────────────────────────
    (function () {
      var projData = {}; // projectId -> graph { project, updates, branches }

      function projHeaders() {
        return { 'Content-Type': 'application/json' };
      }

      async function projFetch(path, opts) {
        return fetch('/api' + path, Object.assign({ headers: projHeaders() }, opts));
      }

      function activeProjectsCanvas() {
        return document.getElementById('mc2-proj-canvas');
      }

      async function loadProjects(canvas) {
        canvas = canvas || activeProjectsCanvas();
        if (!canvas) return;
        var r = await projFetch('/projects');
        if (!r || !r.ok) return;
        var projects = await r.json();
        canvas.innerHTML = '';
        if (!projects.length) {
          canvas.innerHTML = '<div class="proj-empty">No projects yet. Add one above.</div>';
          return;
        }
        for (var proj of projects) {
          await loadAndRenderProject(proj.id, canvas);
        }
      }

      async function loadAndRenderProject(pid, container) {
        var r = await projFetch('/projects/' + pid + '/graph');
        if (!r) return;
        var graph = await r.json();
        projData[pid] = graph;
        var existing = document.getElementById('proj-row-' + pid);
        if (existing) { existing.replaceWith(renderProjectRow(graph)); }
        else if (container) { container.appendChild(renderProjectRow(graph)); }
      }

      function fmtTs(ms) {
        var d = new Date(ms);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
          + '  ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      }

      // ── Render one project row ──
      function renderProjectRow(graph) {
        var { project, updates, branches } = graph;
        var pid = project.id;

        var row = document.createElement('div');
        row.className = 'proj-row card';
        row.id = 'proj-row-' + pid;

        // ── Main track (branch_id == null) ──
        var mainTrack = document.createElement('div');
        mainTrack.className = 'proj-track';

        // Root box
        var root = document.createElement('div');
        root.className = 'proj-root';
        var urlHtml = project.url
          ? '<div class="proj-root-url"><a href="' + esc(project.url) + '" target="_blank" rel="noopener noreferrer">' + esc(project.url) + '</a></div>'
          : '';
        var teamHtml = project.team_id
          ? '<div class="proj-root-url">Team: ' + esc(project.team_id) + '</div>'
          : '';
        root.innerHTML = '<div class="proj-root-name">' + esc(project.name) + '</div>'
          + urlHtml
          + teamHtml
          + (project.description ? '<div class="proj-root-desc">' + esc(project.description) + '</div>' : '');
        var editProjCorner = document.createElement('button');
        editProjCorner.type = 'button';
        editProjCorner.className = 'proj-root-edit';
        editProjCorner.setAttribute('aria-label', 'Edit project');
        editProjCorner.title = 'Edit project';
        editProjCorner.textContent = '✎';
        editProjCorner.addEventListener('click', function (e) {
          e.stopPropagation();
          openProjectEditModal(project);
        });
        root.appendChild(editProjCorner);
        var rootActions = document.createElement('div');
        rootActions.className = 'proj-root-actions';
        var editProjBtn = document.createElement('button');
        editProjBtn.type = 'button';
        editProjBtn.className = 'proj-root-edit-action';
        editProjBtn.textContent = '✎ Edit';
        editProjBtn.title = 'Edit name, URL, and description';
        editProjBtn.addEventListener('click', function () { openProjectEditModal(project); });
        var delProjBtn = document.createElement('button');
        delProjBtn.textContent = '🗑 Delete project';
        delProjBtn.title = 'Delete this project and all its data';
        delProjBtn.addEventListener('click', function () { deleteProject(pid); });
        rootActions.append(editProjBtn, delProjBtn);
        root.appendChild(rootActions);
        mainTrack.appendChild(root);

        // Build main-track chain (updates with branch_id == null), ordered by created_at
        var mainUpdates = updates.filter(function (u) { return u.branch_id == null; })
          .sort(function (a, b) { return a.created_at - b.created_at; });

        var lastMainUpdate = null;
        for (var upd of mainUpdates) {
          mainTrack.appendChild(makeArrow());
          mainTrack.appendChild(makeUpdateNode(upd, pid, branches));
          lastMainUpdate = upd;
        }

        // Add-update placeholder for main track
        mainTrack.appendChild(makeArrow());
        mainTrack.appendChild(makeAddUpdatePlaceholder(pid, null, lastMainUpdate ? lastMainUpdate.id : null));

        row.appendChild(mainTrack);

        // ── Branch rows ──
        var branchesDiv = document.createElement('div');
        branchesDiv.className = 'proj-branches';

        for (var branch of branches) {
          var branchUpdates = updates.filter(function (u) { return u.branch_id === branch.id; })
            .sort(function (a, b) { return a.created_at - b.created_at; });

          var branchRow = document.createElement('div');
          branchRow.className = 'proj-branch-row';

          var label = document.createElement('div');
          label.className = 'proj-branch-label';
          label.innerHTML = '<span>' + esc(branch.name) + '</span>';
          var delBranchBtn = document.createElement('button');
          delBranchBtn.className = 'proj-branch-del';
          delBranchBtn.textContent = '✕';
          delBranchBtn.title = 'Delete branch';
          delBranchBtn.addEventListener('click', (function (bid) {
            return function () { deleteBranch(bid, pid); };
          })(branch.id));
          label.appendChild(delBranchBtn);
          branchRow.appendChild(label);

          var lastBranchUpdate = null;
          for (var bu of branchUpdates) {
            branchRow.appendChild(makeArrow());
            branchRow.appendChild(makeUpdateNode(bu, pid, branches));
            lastBranchUpdate = bu;
          }
          branchRow.appendChild(makeArrow());
          branchRow.appendChild(makeAddUpdatePlaceholder(pid, branch.id, lastBranchUpdate ? lastBranchUpdate.id : null));
          branchesDiv.appendChild(branchRow);
        }

        if (branches.length) row.appendChild(branchesDiv);
        return row;
      }

      function makeArrow() {
        var wrap = document.createElement('div');
        wrap.className = 'proj-arrow';
        var head = document.createElement('div');
        head.className = 'proj-arrow-head';
        wrap.appendChild(head);
        return wrap;
      }

      function makeUpdateNode(upd, pid, branches) {
        var node = document.createElement('div');
        node.className = 'proj-update';
        node.id = 'proj-upd-' + upd.id;

        var ts = document.createElement('div');
        ts.className = 'proj-update-ts';
        ts.textContent = fmtTs(upd.created_at);

        var txt = document.createElement('div');
        txt.className = 'proj-update-text';
        txt.textContent = upd.text;

        var actions = document.createElement('div');
        actions.className = 'proj-update-actions';

        var editBtn = document.createElement('button');
        editBtn.textContent = '✏ Edit';
        editBtn.addEventListener('click', function () { showInlineEdit(node, upd, pid); });

        var addBranchBtn = document.createElement('button');
        addBranchBtn.className = 'proj-add-branch-btn';
        addBranchBtn.textContent = '+ Branch';
        addBranchBtn.title = 'Add a sub-track branching from this update';
        addBranchBtn.addEventListener('click', function () { showAddBranch(node, upd.id, pid); });

        var delBtn = document.createElement('button');
        delBtn.textContent = '🗑';
        delBtn.className = 'danger';
        delBtn.title = 'Delete update';
        delBtn.addEventListener('click', function () { deleteUpdate(upd.id, pid); });

        actions.append(editBtn, addBranchBtn, delBtn);
        node.append(ts, txt, actions);
        return node;
      }

      function makeAddUpdatePlaceholder(pid, branchId, parentUpdateId) {
        var ph = document.createElement('div');
        ph.className = 'proj-add-update';
        ph.textContent = '+ Add update';
        ph.addEventListener('click', function () {
          showAddUpdateInline(ph, pid, branchId, parentUpdateId);
        });
        return ph;
      }

      // ── Inline add-update form (replaces placeholder) ──
      function showAddUpdateInline(placeholder, pid, branchId, parentUpdateId) {
        var wrap = document.createElement('div');
        wrap.className = 'proj-update';
        wrap.style.width = '210px';

        var ta = document.createElement('textarea');
        ta.className = 'proj-inline-edit';
        ta.placeholder = 'What was done?';

        var saveBtn = document.createElement('button');
        saveBtn.className = 'proj-inline-save';
        saveBtn.textContent = 'Save';

        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'proj-inline-cancel';
        cancelBtn.textContent = 'Cancel';

        saveBtn.addEventListener('click', async function () {
          var text = ta.value.trim();
          if (!text) return;
          var r = await projFetch('/projects/' + pid + '/updates', {
            method: 'POST',
            body: JSON.stringify({ branch_id: branchId, parent_update_id: parentUpdateId, text }),
          });
          if (!r) return;
          await refreshProject(pid);
        });
        cancelBtn.addEventListener('click', function () { wrap.replaceWith(placeholder); });
        ta.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) saveBtn.click();
        });

        wrap.append(ta, saveBtn, cancelBtn);
        placeholder.replaceWith(wrap);
        ta.focus();
      }

      // ── Inline edit update ──
      function showInlineEdit(node, upd, pid) {
        var ta = document.createElement('textarea');
        ta.className = 'proj-inline-edit';
        ta.value = upd.text;

        var saveBtn = document.createElement('button');
        saveBtn.className = 'proj-inline-save';
        saveBtn.textContent = 'Save';

        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'proj-inline-cancel';
        cancelBtn.textContent = 'Cancel';

        var orig = node.innerHTML;
        node.innerHTML = '';
        node.append(ta, saveBtn, cancelBtn);
        ta.focus();

        saveBtn.addEventListener('click', async function () {
          var text = ta.value.trim();
          if (!text) return;
          var r = await projFetch('/projects/updates/' + upd.id, {
            method: 'PATCH',
            body: JSON.stringify({ text }),
          });
          if (!r) return;
          await refreshProject(pid);
        });
        cancelBtn.addEventListener('click', function () { node.innerHTML = orig; });
      }

      // ── Inline add-branch form inside an update node ──
      function showAddBranch(node, updateId, pid) {
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.placeholder = 'Branch name (e.g. Marketing)';
        inp.style.cssText = 'width:100%;box-sizing:border-box;background:var(--bg);border:1px solid var(--accent);color:var(--text);padding:0.35rem 0.5rem;border-radius:4px;font:inherit;font-size:0.8rem;margin-top:0.4rem;';
        var saveBtn = document.createElement('button');
        saveBtn.className = 'proj-inline-save';
        saveBtn.textContent = 'Create';
        saveBtn.style.marginTop = '0.3rem';
        var cancelBtn = document.createElement('button');
        cancelBtn.className = 'proj-inline-cancel';
        cancelBtn.textContent = 'Cancel';

        node.appendChild(inp);
        node.appendChild(document.createElement('br'));
        node.appendChild(saveBtn);
        node.appendChild(cancelBtn);
        inp.focus();

        saveBtn.addEventListener('click', async function () {
          var name = inp.value.trim();
          if (!name) return;
          var r = await projFetch('/projects/' + pid + '/branches', {
            method: 'POST',
            body: JSON.stringify({ parent_update_id: updateId, name }),
          });
          if (!r) return;
          await refreshProject(pid);
        });
        cancelBtn.addEventListener('click', function () { inp.remove(); saveBtn.remove(); cancelBtn.remove(); });
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') saveBtn.click(); });
      }

      async function deleteProject(pid) {
        if (!confirm('Delete this project and all its data?')) return;
        await projFetch('/projects/' + pid, { method: 'DELETE' });
        document.getElementById('proj-row-' + pid)?.remove();
        var canvas = activeProjectsCanvas();
        if (canvas && !canvas.querySelector('.proj-row')) {
          canvas.innerHTML = '<div class="proj-empty">No projects yet. Add one above.</div>';
        }
        if (typeof mc2RenderSidebarProjects === 'function') mc2RenderSidebarProjects();
      }

      async function deleteUpdate(uid, pid) {
        if (!confirm('Delete this update?')) return;
        await projFetch('/projects/updates/' + uid, { method: 'DELETE' });
        await refreshProject(pid);
      }

      async function deleteBranch(bid, pid) {
        if (!confirm('Delete this branch and all its updates?')) return;
        await projFetch('/projects/branches/' + bid, { method: 'DELETE' });
        await refreshProject(pid);
      }

      async function refreshProject(pid) {
        var canvas = activeProjectsCanvas();
        if (!canvas) return;
        await loadAndRenderProject(pid, canvas);
        if (typeof mc2RenderSidebarProjects === 'function') mc2RenderSidebarProjects();
      }

      var projectEditModalId = null;

      function showProjectEditError(msg) {
        var el = document.getElementById('project-edit-modal-error');
        if (!el) return;
        if (msg) {
          el.textContent = msg;
          el.classList.add('visible');
        } else {
          el.textContent = '';
          el.classList.remove('visible');
        }
      }

      function openProjectEditModal(project) {
        if (!project || !project.id) return;
        var modal = document.getElementById('project-edit-modal');
        if (!modal) return;
        projectEditModalId = project.id;
        var nameEl = document.getElementById('project-edit-name');
        var urlEl = document.getElementById('project-edit-url');
        var descEl = document.getElementById('project-edit-desc');
        var teamEl = document.getElementById('project-edit-team');
        if (nameEl) nameEl.value = String(project.name || '');
        if (urlEl) urlEl.value = String(project.url || '');
        if (descEl) descEl.value = String(project.description || '');
        if (teamEl) teamEl.value = String(project.team_id || '');
        var setupEl = document.getElementById('project-edit-setup');
        if (setupEl) setupEl.value = String(project.setup_notes || '');
        showProjectEditError('');
        modal.classList.add('open');
        modal.setAttribute('aria-hidden', 'false');
        setTimeout(function () { if (nameEl) nameEl.focus(); }, 0);
      }

      function closeProjectEditModal() {
        var modal = document.getElementById('project-edit-modal');
        if (!modal) return;
        modal.classList.remove('open');
        modal.setAttribute('aria-hidden', 'true');
        projectEditModalId = null;
        showProjectEditError('');
      }

      async function submitProjectEditModal() {
        if (!projectEditModalId) return;
        var nameEl = document.getElementById('project-edit-name');
        var urlEl = document.getElementById('project-edit-url');
        var descEl = document.getElementById('project-edit-desc');
        var teamEl = document.getElementById('project-edit-team');
        var setupEl = document.getElementById('project-edit-setup');
        var name = nameEl ? String(nameEl.value || '').trim() : '';
        if (!name) {
          showProjectEditError('Project name is required.');
          if (nameEl) nameEl.focus();
          return;
        }
        var submitBtn = document.getElementById('project-edit-modal-submit');
        if (submitBtn) submitBtn.disabled = true;
        showProjectEditError('');
        try {
          var r = await projFetch('/projects/' + projectEditModalId, {
            method: 'PATCH',
            body: JSON.stringify({
              name: name,
              url: urlEl ? String(urlEl.value || '').trim() : '',
              description: descEl ? String(descEl.value || '').trim() : '',
              team_id: teamEl ? String(teamEl.value || '').trim() : '',
              setup_notes: setupEl ? String(setupEl.value || '').trim() : '',
            }),
          });
          if (!r) return;
          if (!r.ok) {
            var err = await r.json().catch(function () { return {}; });
            showProjectEditError(err.error || 'Could not save project.');
            return;
          }
          var savedId = projectEditModalId;
          closeProjectEditModal();
          await refreshProject(savedId);
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      }

      var projectEditModalEl = document.getElementById('project-edit-modal');
      var projectEditCancelEl = document.getElementById('project-edit-modal-cancel');
      var projectEditSubmitEl = document.getElementById('project-edit-modal-submit');
      if (projectEditCancelEl) {
        projectEditCancelEl.addEventListener('click', closeProjectEditModal);
      }
      if (projectEditSubmitEl) {
        projectEditSubmitEl.addEventListener('click', submitProjectEditModal);
      }
      if (projectEditModalEl) {
        projectEditModalEl.addEventListener('click', function (e) {
          if (e.target === projectEditModalEl) closeProjectEditModal();
        });
      }
      ['project-edit-name', 'project-edit-url', 'project-edit-desc', 'project-edit-team'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) {
          el.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') submitProjectEditModal();
          });
        }
      });

      var CONNECTOR_DEFS = [
        {
          id: 'github',
          label: 'GitHub',
          desc: 'Link this project to a repo. API token comes from Skills / secrets.json.',
          field: 'repo',
          placeholder: 'owner/repo',
          globalKey: 'github',
        },
        {
          id: 'mongodb',
          label: 'MongoDB',
          desc: 'Connection string plus purpose-to-collection hints for agents.',
          field: 'uri',
          placeholder: 'mongodb://localhost:27017/myapp',
          secret: true,
        },
        {
          id: 'postgres',
          label: 'PostgreSQL',
          desc: 'Postgres connection URI for this project.',
          field: 'uri',
          placeholder: 'postgresql://user:pass@localhost:5432/myapp',
          secret: true,
        },
      ];

      var connectorStatusCache = null;

      async function fetchConnectorStatus() {
        if (connectorStatusCache) return connectorStatusCache;
        var r = await projFetch('/connectors/status');
        if (!r || !r.ok) return {};
        connectorStatusCache = await r.json().catch(function () { return {}; });
        return connectorStatusCache;
      }

      function connectorBadgeHtml(def, value, globalStatus) {
        if (def.globalKey === 'github') {
          var tokenOk = globalStatus && globalStatus.github && (globalStatus.github.status === 'ok' || globalStatus.github.status === 'ok-legacy');
          if (!tokenOk) return '<span class="mc2-connector-badge missing">Token not set</span>';
          if (value) return '<span class="mc2-connector-badge connected">Connected</span>';
          return '<span class="mc2-connector-badge">Token ready</span>';
        }
        if (value) return '<span class="mc2-connector-badge connected">Connected</span>';
        return '<span class="mc2-connector-badge">Not configured</span>';
      }

      async function saveProjectConnector(projectId, connectorId, field, value) {
        var patch = {};
        patch[connectorId] = {};
        patch[connectorId][field] = String(value || '').trim();
        return saveProjectConnectorPatch(projectId, patch);
      }

      async function saveProjectConnectorPatch(projectId, patch) {
        var r = await projFetch('/projects/' + projectId, {
          method: 'PATCH',
          body: JSON.stringify({ connectors: patch }),
        });
        return r && r.ok;
      }

      function normalizeMongoCollections(rows) {
        var out = {};
        (rows || []).forEach(function (row) {
          var key = String(row && row.key || '').trim();
          var collection = String(row && row.collection || '').trim();
          if (!key || !collection) return;
          out[key] = collection;
        });
        return out;
      }

      function readMongoCollectionRows(card) {
        return Array.prototype.slice.call(card.querySelectorAll('.mc2-mongo-map-row')).map(function (row) {
          var keyEl = row.querySelector('[data-mongo-map-key]');
          var collectionEl = row.querySelector('[data-mongo-map-collection]');
          return {
            key: keyEl ? keyEl.value : '',
            collection: collectionEl ? collectionEl.value : '',
          };
        });
      }

      function mongoCollectionRowsHtml(collections) {
        var entries = Object.entries(collections && typeof collections === 'object' && !Array.isArray(collections) ? collections : {});
        entries.sort(function (a, b) { return a[0].localeCompare(b[0]); });
        entries.push(['', '']);
        return entries.map(function (entry, i) {
          var remove = entry[0] || entry[1]
            ? '<button type="button" class="mc2-mongo-map-remove" aria-label="Remove MongoDB collection mapping">Remove</button>'
            : '';
          return (
            '<div class="mc2-mongo-map-row" data-mongo-map-row>' +
              '<input data-mongo-map-key type="text" placeholder="key, e.g. analytics" value="' + esc(entry[0]) + '" autocomplete="off">' +
              '<input data-mongo-map-collection type="text" placeholder="collection, e.g. analytics-user" value="' + esc(entry[1]) + '" autocomplete="off">' +
              remove +
            '</div>'
          );
        }).join('');
      }

      function ensureBlankMongoMapRow(card) {
        var wrap = card.querySelector('[data-mongo-map-rows]');
        if (!wrap) return;
        var rows = Array.prototype.slice.call(wrap.querySelectorAll('.mc2-mongo-map-row'));
        var hasBlank = rows.some(function (row) {
          var keyEl = row.querySelector('[data-mongo-map-key]');
          var collectionEl = row.querySelector('[data-mongo-map-collection]');
          return !String(keyEl && keyEl.value || '').trim() && !String(collectionEl && collectionEl.value || '').trim();
        });
        if (hasBlank) return;
        var div = document.createElement('div');
        div.className = 'mc2-mongo-map-row';
        div.setAttribute('data-mongo-map-row', '');
        div.innerHTML =
          '<input data-mongo-map-key type="text" placeholder="key, e.g. analytics" autocomplete="off">' +
          '<input data-mongo-map-collection type="text" placeholder="collection, e.g. analytics-user" autocomplete="off">';
        wrap.appendChild(div);
      }

      async function renderMc2Connectors(projectId) {
        var grid = document.getElementById('mc2-proj-connectors-grid');
        var hint = document.getElementById('mc2-proj-connectors-hint');
        if (!grid) return;
        var pid = String(projectId || '').trim();
        if (!pid) {
          if (hint) hint.textContent = 'Add a project below, then configure connectors here.';
          grid.innerHTML = '<p class="mc2-proj-connectors-empty">No project selected.</p>';
          return;
        }
        var projects = await (window.pastureProjectsApi && window.pastureProjectsApi.listProjects
          ? window.pastureProjectsApi.listProjects()
          : Promise.resolve([]));
        var project = (projects || []).find(function (p) { return String(p.id) === pid; });
        if (!project) {
          if (hint) hint.textContent = 'Project not found.';
          grid.innerHTML = '<p class="mc2-proj-connectors-empty">Project not found.</p>';
          return;
        }
        if (hint) hint.textContent = 'Connections for “' + project.name + '”.';
        var globalStatus = await fetchConnectorStatus();
        var connectors = project.connectors || {};
        grid.innerHTML = '';
        CONNECTOR_DEFS.forEach(function (def) {
          var stored = connectors[def.id] || {};
          var value = String(stored[def.field] || '');
          var mongoCollections = def.id === 'mongodb' ? (stored.collections || {}) : {};
          if (!value && def.globalKey === 'github' && globalStatus.github && globalStatus.github.defaultRepo) {
            value = globalStatus.github.defaultRepo;
          }
          var card = document.createElement('article');
          card.className = 'mc2-connector-card';
          card.innerHTML =
            '<div class="mc2-connector-card-head">' +
              '<span class="mc2-connector-title">' + esc(def.label) + '</span>' +
              connectorBadgeHtml(def, value, globalStatus) +
            '</div>' +
            '<p class="mc2-connector-desc">' + esc(def.desc) + '</p>' +
            '<div class="mc2-connector-field">' +
              '<label for="mc2-conn-' + esc(def.id) + '">' + esc(def.label) + '</label>' +
              '<input id="mc2-conn-' + esc(def.id) + '" type="' + (def.secret ? 'password' : 'text') + '" placeholder="' + esc(def.placeholder) + '" autocomplete="off">' +
            '</div>' +
            (def.id === 'mongodb'
              ? '<div class="mc2-mongo-map" data-mongo-map>' +
                  '<div class="mc2-mongo-map-head">' +
                    '<span>Collection hints</span>' +
                    '<small>Optional key → collection name pairs agents can use.</small>' +
                  '</div>' +
                  '<div class="mc2-mongo-map-rows" data-mongo-map-rows>' + mongoCollectionRowsHtml(mongoCollections) + '</div>' +
                  '<button type="button" class="mc2-mongo-map-add">+ Add collection hint</button>' +
                '</div>'
              : '') +
            '<div class="mc2-connector-actions">' +
              '<button type="button" class="mc2-connector-save" data-connector-id="' + esc(def.id) + '" data-connector-field="' + esc(def.field) + '">Save</button>' +
              '<span class="mc2-connector-saved" hidden>Saved</span>' +
            '</div>';
          var input = card.querySelector('input');
          if (input) input.value = value;
          if (def.id === 'mongodb') {
            card.addEventListener('click', function (e) {
              var removeBtn = e.target && e.target.closest ? e.target.closest('.mc2-mongo-map-remove') : null;
              if (removeBtn) {
                var row = removeBtn.closest('.mc2-mongo-map-row');
                if (row) row.remove();
                ensureBlankMongoMapRow(card);
                return;
              }
              var addBtn = e.target && e.target.closest ? e.target.closest('.mc2-mongo-map-add') : null;
              if (addBtn) {
                ensureBlankMongoMapRow(card);
                var rows = card.querySelectorAll('.mc2-mongo-map-row');
                var last = rows[rows.length - 1];
                var first = last && last.querySelector('[data-mongo-map-key]');
                if (first) first.focus();
              }
            });
            card.addEventListener('input', function (e) {
              if (e.target && (e.target.matches('[data-mongo-map-key]') || e.target.matches('[data-mongo-map-collection]'))) {
                ensureBlankMongoMapRow(card);
              }
            });
          }
          var saveBtn = card.querySelector('.mc2-connector-save');
          var savedEl = card.querySelector('.mc2-connector-saved');
          if (saveBtn) {
            saveBtn.addEventListener('click', async function () {
              var nextVal = input ? input.value : '';
              var ok;
              saveBtn.disabled = true;
              if (def.id === 'mongodb') {
                var patch = { mongodb: { uri: String(nextVal || '').trim(), collections: normalizeMongoCollections(readMongoCollectionRows(card)) } };
                ok = await saveProjectConnectorPatch(pid, patch);
              } else {
                ok = await saveProjectConnector(pid, def.id, def.field, nextVal);
              }
              saveBtn.disabled = false;
              if (!ok) return;
              if (savedEl) {
                savedEl.hidden = false;
                setTimeout(function () { savedEl.hidden = true; }, 1800);
              }
              var badge = card.querySelector('.mc2-connector-badge');
              if (badge) badge.outerHTML = connectorBadgeHtml(def, nextVal, globalStatus);
              if (typeof mc2RenderSidebarProjects === 'function') mc2RenderSidebarProjects();
            });
          }
          grid.appendChild(card);
        });
      }

      // ── Add project ──
      async function addProjectFromForm(nameInputId, urlInputId, descInputId, canvasId, teamInputId) {
        var nameEl = document.getElementById(nameInputId);
        var urlEl = document.getElementById(urlInputId);
        var descEl = document.getElementById(descInputId);
        var teamEl = teamInputId ? document.getElementById(teamInputId) : document.getElementById('mc2-proj-new-team');
        var name = nameEl ? nameEl.value.trim() : '';
        var url = urlEl ? urlEl.value.trim() : '';
        var desc = descEl ? descEl.value.trim() : '';
        var team = teamEl ? String(teamEl.value || '').trim() : '';
        if (!name) { if (nameEl) nameEl.focus(); return; }
        var r = await projFetch('/projects', {
          method: 'POST',
          body: JSON.stringify({ name: name, url: url, description: desc, team_id: team }),
        });
        if (!r) return;
        var proj = await r.json();
        if (nameEl) nameEl.value = '';
        if (urlEl) urlEl.value = '';
        if (descEl) descEl.value = '';
        if (teamEl) teamEl.value = '';
        var canvas = canvasId ? document.getElementById(canvasId) : activeProjectsCanvas();
        if (!canvas) return;
        var empty = canvas.querySelector('.proj-empty');
        if (empty) empty.remove();
        await loadAndRenderProject(proj.id, canvas);
        if (typeof mc2RenderSidebarProjects === 'function') mc2RenderSidebarProjects();
        if (typeof mc2SelectedProjectId !== 'undefined') {
          mc2SelectedProjectId = String(proj.id);
        }
        if (typeof renderMc2Connectors === 'function') renderMc2Connectors(String(proj.id));
      }

      window.pastureProjectsApi = {
        fetch: projFetch,
        loadProjects: loadProjects,
        listProjects: async function () {
          var r = await projFetch('/projects');
          if (!r || !r.ok) return null;
          return r.json();
        },
        activeCanvas: activeProjectsCanvas,
        addProjectFromForm: addProjectFromForm,
        renderConnectors: renderMc2Connectors,
      };

      function esc(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }
    })();
