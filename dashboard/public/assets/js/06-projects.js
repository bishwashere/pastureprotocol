// ── Projects ────────────────────────────────────────────────────────────
    (function () {
      var projData = {}; // projectId -> graph { project, updates, branches }

      function projHeaders() {
        return { 'Content-Type': 'application/json' };
      }

      async function projFetch(path, opts) {
        return fetch('/api' + path, Object.assign({ headers: projHeaders() }, opts));
      }

      function showProjMain() {
        document.getElementById('proj-main').style.display = 'block';
        loadProjects();
      }

      async function initProjectsPage() {
        showProjMain();
      }
      function activeProjectsCanvas() {
        var mc2View = document.getElementById('mc2-view-projects');
        var mc2Canvas = document.getElementById('mc2-proj-canvas');
        if (mc2View && !mc2View.hidden && mc2Canvas) return mc2Canvas;
        return document.getElementById('proj-canvas');
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
        root.innerHTML = '<div class="proj-root-name">' + esc(project.name) + '</div>'
          + urlHtml
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
        if (nameEl) nameEl.value = String(project.name || '');
        if (urlEl) urlEl.value = String(project.url || '');
        if (descEl) descEl.value = String(project.description || '');
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
      ['project-edit-name', 'project-edit-url', 'project-edit-desc'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) {
          el.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') submitProjectEditModal();
          });
        }
      });

      // ── Add project ──
      async function addProjectFromForm(nameInputId, urlInputId, descInputId, canvasId) {
        var nameEl = document.getElementById(nameInputId);
        var urlEl = document.getElementById(urlInputId);
        var descEl = document.getElementById(descInputId);
        var name = nameEl ? nameEl.value.trim() : '';
        var url = urlEl ? urlEl.value.trim() : '';
        var desc = descEl ? descEl.value.trim() : '';
        if (!name) { if (nameEl) nameEl.focus(); return; }
        var r = await projFetch('/projects', {
          method: 'POST',
          body: JSON.stringify({ name: name, url: url, description: desc }),
        });
        if (!r) return;
        var proj = await r.json();
        if (nameEl) nameEl.value = '';
        if (urlEl) urlEl.value = '';
        if (descEl) descEl.value = '';
        var canvas = canvasId ? document.getElementById(canvasId) : activeProjectsCanvas();
        if (!canvas) return;
        var empty = canvas.querySelector('.proj-empty');
        if (empty) empty.remove();
        await loadAndRenderProject(proj.id, canvas);
        if (typeof mc2RenderSidebarProjects === 'function') mc2RenderSidebarProjects();
      }

      document.getElementById('proj-add-btn').addEventListener('click', function () {
        addProjectFromForm('proj-new-name', 'proj-new-url', 'proj-new-desc', 'proj-canvas');
      });
      function projNewEnterSubmit(e) {
        if (e.key === 'Enter') document.getElementById('proj-add-btn').click();
      }
      document.getElementById('proj-new-name').addEventListener('keydown', projNewEnterSubmit);
      document.getElementById('proj-new-url').addEventListener('keydown', projNewEnterSubmit);
      document.getElementById('proj-new-desc').addEventListener('keydown', projNewEnterSubmit);

      window.cowCodeProjectsApi = {
        fetch: projFetch,
        loadProjects: loadProjects,
        listProjects: async function () {
          var r = await projFetch('/projects');
          if (!r || !r.ok) return null;
          return r.json();
        },
        activeCanvas: activeProjectsCanvas,
        addProjectFromForm: addProjectFromForm,
      };

      function esc(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }

      // Init when Projects page is opened
      var origSetPage = window._projSetPageHooked;
      document.querySelector('nav a[data-page="projects"]').addEventListener('click', function () {
        initProjectsPage();
      });
      // Also init if navigated directly
      if (location.hash === '#projects') initProjectsPage();
    })();
