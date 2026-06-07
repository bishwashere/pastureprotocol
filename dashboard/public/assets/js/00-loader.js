/**
 * Load dashboard partials and page HTML fragments (sync, before app scripts).
 */
(function loadDashboardShell() {
  function fetchText(url) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', url, false);
    xhr.send(null);
    if (xhr.status < 200 || xhr.status >= 300) {
      throw new Error('Failed to load: ' + url + ' (' + xhr.status + ')');
    }
    return xhr.responseText;
  }
  var navRoot = document.getElementById('dashboard-nav-root');
  if (navRoot) navRoot.outerHTML = fetchText('assets/partials/nav.html');
  var modalsRoot = document.getElementById('dashboard-modals-root');
  if (modalsRoot) modalsRoot.outerHTML = fetchText('assets/partials/modals.html');
  var projectModalRoot = document.getElementById('dashboard-project-modal-root');
  if (projectModalRoot) projectModalRoot.outerHTML = fetchText('assets/partials/project-edit-modal.html');
  var mc2ViewFiles = [
    'view-home',
    'view-tasks',
    'view-agents',
    'view-context',
    'view-missions',
    'view-projects',
    'view-activity',
    'view-stats',
  ];
  function loadMc2ViewsHtml() {
    return mc2ViewFiles.map(function (name) {
      return fetchText('pages/mc2/' + name + '.html');
    }).join('\n');
  }
  var pages = ['home', 'memory', 'crons', 'skills', 'agents', 'team', 'team2', 'team-agent', 'groups', 'llm', 'tide', 'config', 'test', 'projects'];
  var root = document.getElementById('page-fragments-root');
  if (!root) return;
  root.outerHTML = pages.map(function (page) {
    var html = fetchText('pages/' + page + '.html');
    if (page === 'team2') {
      html = html.replace('<!-- MC2_VIEWS -->', loadMc2ViewsHtml());
    }
    return html;
  }).join('\n');
})();
