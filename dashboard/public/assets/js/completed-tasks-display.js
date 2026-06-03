(function (root) {
  var DEFAULT_MERGE_WINDOW_MS = 30 * 60 * 1000;

  function normalizeCompletedTaskPrompt(prompt) {
    var p = String(prompt || '').trim();
    p = p.replace(/^\[Retry with (?:tools|search)\]\s*/i, '').trim();
    p = p.replace(/^The user asked:\s*["“]?/i, '').replace(/["”]\.\s*Use available tools.*$/i, '').trim();
    p = p.replace(/^Handled in \d+.*$/i, '').trim();
    p = p.replace(/\s+/g, ' ').trim();
    return p.toLowerCase().slice(0, 160);
  }

  function completedTaskMergeKey(task) {
    var agentId = String(task && task.agentId || '').trim();
    var prompt = String(task && task.prompt || task.summary || '').trim();
    return agentId + '|' + normalizeCompletedTaskPrompt(prompt);
  }

  function consolidateCompletedTasks(tasks, opts) {
    opts = opts || {};
    var mergeWindowMs = Number(opts.mergeWindowMs) || DEFAULT_MERGE_WINDOW_MS;
    var list = Array.isArray(tasks) ? tasks.slice() : [];
    if (!list.length) return [];

    list.sort(function (a, b) { return (Number(a.ts) || 0) - (Number(b.ts) || 0); });

    var groups = [];
    list.forEach(function (task) {
      var key = completedTaskMergeKey(task);
      var ts = Number(task.ts) || 0;
      var last = groups.length ? groups[groups.length - 1] : null;

      if (
        last &&
        last._key === key &&
        ts &&
        last._ts &&
        Math.abs(ts - last._ts) <= mergeWindowMs
      ) {
        last.ts = Math.max(last._ts, ts);
        last._ts = last.ts;
        last.skillCount = Math.max(Number(last.skillCount) || 0, Number(task.skillCount) || 0);
        if ((Number(task.skillCount) || 0) >= (Number(last.skillCount) || 0) && task.summary) {
          last.summary = task.summary;
        }
        if (task.prompt && String(task.prompt).length >= String(last.prompt || '').length) {
          last.prompt = task.prompt;
        }
        return;
      }

      var copy = {
        id: String(task.id || ''),
        agentId: String(task.agentId || ''),
        ts: ts,
        summary: String(task.summary || ''),
        prompt: String(task.prompt || ''),
        skillCount: Number(task.skillCount) || 0,
        _key: key,
        _ts: ts,
      };
      groups.push(copy);
    });

    return groups
      .map(function (task) {
        return {
          id: task.id,
          agentId: task.agentId,
          ts: task.ts,
          summary: task.summary,
          prompt: task.prompt,
          skillCount: task.skillCount,
        };
      })
      .sort(function (a, b) { return (Number(b.ts) || 0) - (Number(a.ts) || 0); });
  }

  root.pastureCompletedTasks = {
    normalizeCompletedTaskPrompt: normalizeCompletedTaskPrompt,
    completedTaskMergeKey: completedTaskMergeKey,
    consolidateCompletedTasks: consolidateCompletedTasks,
    DEFAULT_MERGE_WINDOW_MS: DEFAULT_MERGE_WINDOW_MS,
  };
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : this);
