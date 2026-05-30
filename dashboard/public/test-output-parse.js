/**
 * Parse skill/E2E test stdout for the dashboard Tests panel.
 * Supports e2e-report (INPUT/OUTPUT), markdown table, agent Scenario/Reply, and legacy formats.
 */

export function parseTestOutput(result) {
  var stdout = result.stdout || '';
  var stderr = result.stderr || '';
  var entries = [];
  var lines = stdout.split('\n');
  var curReply = '';
  var curOutput = '';
  var curInput = '';
  var curJudge = '';
  var curName = '';
  var curSkillsCalled = '';
  var curPass = null;
  var collectingReply = false;
  var collectingJudge = false;
  var collectingInputJson = false;
  var collectingOutputBlock = false;
  var inputJsonLines = [];
  var outputBlockLines = [];
  var sawE2eCaseBlocks = false;

  function flush(status) {
    var pass = curPass;
    if (pass == null && status === 'pass') pass = true;
    if (pass == null && status === 'fail') pass = false;
    if (pass == null && curReply) pass = true;

    var outputText = curOutput || curReply;
    if (outputText || curJudge || curName || curInput) {
      entries.push({
        name: curName,
        input: curInput.trim(),
        output: curOutput.trim(),
        reply: outputText.trim(),
        judge: curJudge.trim(),
        skillsCalled: curSkillsCalled.trim(),
        pass: pass === true,
      });
    }
    curReply = '';
    curOutput = '';
    curInput = '';
    curJudge = '';
    curName = '';
    curSkillsCalled = '';
    curPass = null;
    collectingReply = false;
    collectingJudge = false;
  }

  function flushSectionBlock() {
    if (collectingInputJson && inputJsonLines.length) {
      flush(null);
      curName = curName || 'Tide cycle';
      curInput = inputJsonLines.join('\n');
      inputJsonLines = [];
      collectingInputJson = false;
    }
    if (collectingOutputBlock && outputBlockLines.length) {
      if (!curOutput) curOutput = outputBlockLines.join('\n');
      outputBlockLines = [];
      collectingOutputBlock = false;
    }
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    var trimmed = line.trim();

    if (trimmed === '--- Input ---') {
      flushSectionBlock();
      flush(null);
      collectingInputJson = true;
      inputJsonLines = [];
      continue;
    }
    if (trimmed === '--- Output ---') {
      flushSectionBlock();
      collectingOutputBlock = true;
      outputBlockLines = [];
      continue;
    }
    if (collectingInputJson) {
      if (trimmed === '--- Output ---') {
        collectingInputJson = false;
        collectingOutputBlock = true;
        outputBlockLines = [];
        continue;
      }
      inputJsonLines.push(line);
      continue;
    }
    if (collectingOutputBlock) {
      if (/^---/.test(trimmed) || /^Tide test /i.test(trimmed)) {
        flushSectionBlock();
        flush('pass');
        continue;
      }
      outputBlockLines.push(line);
      continue;
    }

    // e2e-report per-case block: ✅/❌/⏭️ name
    if (/^[✅❌⏭️]\s/.test(trimmed)) {
      flush(null);
      curName = trimmed.replace(/^[✅❌⏭️]\s+/, '');
      curPass = trimmed.charCodeAt(0) === 0x2705; // ✅
      if (!curPass) curPass = trimmed.charCodeAt(0) === 0x23ed ? null : false; // ⏭️ skip
      continue;
    }
    if (/^\s*INPUT:\s/.test(line)) {
      sawE2eCaseBlocks = true;
      curInput = line.replace(/^\s*INPUT:\s*/, '');
      continue;
    }
    if (/^\s*OUTPUT:\s/.test(line)) {
      sawE2eCaseBlocks = true;
      curOutput = line.replace(/^\s*OUTPUT:\s*/, '');
      collectingReply = false;
      collectingJudge = false;
      continue;
    }
    if (/^\s*DETAIL:\s/.test(line)) {
      curJudge = line.replace(/^\s*DETAIL:\s*/, '');
      continue;
    }

    // e2e-report markdown table row (skip when detailed blocks already parsed)
    if (!sawE2eCaseBlocks && /^\|/.test(trimmed) && !/^\|\s*---/.test(trimmed) && !/^\|\s*Test\s*\|/i.test(trimmed)) {
      var cols = trimmed.split('|').map(function (c) { return c.trim(); }).filter(Boolean);
      if (cols.length >= 4 && (cols[3].indexOf('Pass') >= 0 || cols[3].indexOf('Fail') >= 0 || /✅|❌|⏭️/.test(cols[3]))) {
        var detail = '';
        var statusCol = cols[3];
        var detailIdx = statusCol.indexOf('—');
        if (detailIdx >= 0) detail = statusCol.slice(detailIdx + 1).trim();
        entries.push({
          name: cols[0],
          input: cols[1],
          output: cols[2],
          reply: cols[2],
          judge: detail,
          skillsCalled: '',
          pass: /✅|Pass/i.test(statusCol) && !/❌|Fail/i.test(statusCol),
        });
      }
      continue;
    }

    if (/^\[SUCCESS\]/.test(trimmed)) {
      if (!curName) curName = trimmed.replace(/^\[SUCCESS\]\s*/, '');
      if (curPass == null) curPass = true;
      continue;
    }
    if (/^\[FAILED\]/.test(trimmed) && /—/.test(trimmed)) {
      if (!curName) curName = trimmed.replace(/^\[FAILED\]\s*([^—]*)—.*/, '$1').trim();
      if (!curJudge) curJudge = trimmed.replace(/^\[FAILED\]\s*[^—]*—\s*/, '');
      curPass = false;
      continue;
    }

    if (/^\s*Skills called:\s/.test(line)) {
      curSkillsCalled = line.replace(/^\s*Skills called:\s*/, '');
      continue;
    }
    if (/^\s*Reply:\s/.test(line)) {
      collectingJudge = false;
      collectingReply = true;
      curReply = line.replace(/^\s*Reply:\s*/, '');
      continue;
    }
    if (/^\s*Judge:\s/.test(line)) {
      collectingReply = false;
      collectingJudge = true;
      curJudge = line.replace(/^\s*Judge:\s*/, '');
      continue;
    }

    if (/^Scenario:\s/.test(trimmed)) {
      flush(null);
      curName = trimmed.replace(/^Scenario:\s*/, '');
      continue;
    }
    if (/^Message:\s/.test(trimmed)) {
      if (!curInput) curInput = trimmed.replace(/^Message:\s*/, '');
      continue;
    }
    if (/^Reply:\s/.test(trimmed)) {
      collectingReply = true;
      collectingJudge = false;
      curReply = trimmed.replace(/^Reply:\s*/, '');
      continue;
    }

    if (collectingReply && trimmed && !/^─+$/.test(trimmed) && !/^Skill:/.test(trimmed) && !/^\[/.test(trimmed) && !/^---/.test(trimmed)) {
      curReply += '\n' + line.trimStart();
      continue;
    }
    if (collectingJudge && trimmed && !/^─+$/.test(trimmed) && !/^\[/.test(trimmed) && !/^---/.test(trimmed)) {
      curJudge += '\n' + line.trimStart();
      continue;
    }

    collectingReply = false;
    collectingJudge = false;
  }

  flushSectionBlock();
  if (curReply || curJudge || curName || curInput || curOutput) flush(null);

  var summaryMatch = stdout.match(/Passed:\s*(\d+),\s*Failed:\s*(\d+)/);
  var doneMatch = stdout.match(/Done\.\s*Scenarios:\s*(\d+)\s*Failed:\s*(\d+)/);
  var suiteMatch = stdout.match(/\*\*[^:]+:\*\*\s*(\d+)\s*passed,\s*(\d+)\s*failed/i);
  var summary = '';
  if (summaryMatch) summary = 'Passed: ' + summaryMatch[1] + ', Failed: ' + summaryMatch[2];
  else if (doneMatch) summary = 'Scenarios: ' + doneMatch[1] + ', Failed: ' + doneMatch[2];
  else if (suiteMatch) summary = 'Passed: ' + suiteMatch[1] + ', Failed: ' + suiteMatch[2];

  return {
    entries: entries,
    summary: summary,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    rawStdout: stdout,
    stderr: stderr,
  };
}

export function renderOutputResults(parsed, escapeHtml) {
  if (!escapeHtml) {
    escapeHtml = function (s) {
      return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    };
  }

  if (!parsed || !parsed.entries.length) {
    var raw = ((parsed && parsed.rawStdout) || '').trim();
    if (parsed && parsed.stderr && parsed.stderr.trim()) {
      raw += (raw ? '\n\n' : '') + 'stderr:\n' + parsed.stderr.trim();
    }
    var meta = '';
    if (parsed && parsed.exitCode != null) {
      meta = ' (exit ' + parsed.exitCode;
      if (parsed.durationMs) meta += ', ' + (parsed.durationMs / 1000).toFixed(1) + 's';
      meta += ')';
    }
    if (raw) {
      var html = '<pre class="test-output-pre">' + escapeHtml(raw) + '</pre>';
      if (meta) html += '<div class="test-output-summary">' + escapeHtml(meta.trim()) + '</div>';
      return html;
    }
    return '<div class="test-detail-empty">No structured output' + escapeHtml(meta) + '</div>';
  }

  var html = '';
  parsed.entries.forEach(function (e) {
    var statusClass = e.pass ? 'pass' : (e.pass === false ? 'fail' : '');
    html += '<div class="test-output-entry">';
    if (e.name) {
      html += '<div class="test-output-entry-header">';
      if (statusClass) html += '<span class="status-dot ' + statusClass + '"></span>';
      html += escapeHtml(e.name) + '</div>';
    }
    if (e.input) {
      html += '<div class="test-output-reply"><div class="test-output-reply-label">Input</div>' + escapeHtml(e.input) + '</div>';
    }
    if (e.skillsCalled) {
      html += '<div class="test-output-skills"><strong>Skills called:</strong> ' + escapeHtml(e.skillsCalled) + '</div>';
    }
    var outputText = e.output || e.reply;
    if (outputText) {
      html += '<div class="test-output-reply"><div class="test-output-reply-label">Output</div>' + escapeHtml(outputText) + '</div>';
    }
    if (e.judge) {
      var judgeClass = /^YES/i.test(e.judge.trim()) ? 'pass' : (/^NO/i.test(e.judge.trim()) ? 'fail' : '');
      html += '<div class="test-output-judge ' + judgeClass + '"><strong>Detail:</strong> ' + escapeHtml(e.judge) + '</div>';
    }
    html += '</div>';
  });
  if (parsed.summary) {
    html += '<div class="test-output-summary">' + escapeHtml(parsed.summary);
    if (parsed.durationMs) html += ' · ' + (parsed.durationMs / 1000).toFixed(1) + 's';
    html += '</div>';
  }
  return html;
}

if (typeof globalThis !== 'undefined') {
  globalThis.parseTestOutput = parseTestOutput;
  globalThis.renderOutputResults = renderOutputResults;
}
