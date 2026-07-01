function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function isEmptyPollResponse(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (isPlainObject(value)) return Object.keys(value).length === 0;
  return false;
}

function summarizeBody(value) {
  if (typeof value === 'string') return value.trim();
  return JSON.stringify(value);
}

export async function runConditionalJob(job) {
  const conditional = job?.conditional && typeof job.conditional === 'object' ? job.conditional : null;
  if (!conditional || conditional.notifyWhen !== 'non_empty_response') return null;

  const url = String(conditional.url || '').trim();
  if (!url) return null;

  const response = await fetch(url, { method: 'GET' });
  const text = await response.text();
  let body = text;
  try {
    body = text.trim() ? JSON.parse(text) : '';
  } catch (_) {}

  if (!response.ok) {
    return `Restock check failed: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`;
  }

  if (isEmptyPollResponse(body)) return '';

  const label = String(conditional.label || job?.name || 'Check').trim();
  return `${label}: non-empty response from ${url}\n\n${summarizeBody(body).slice(0, 2000)}`;
}
