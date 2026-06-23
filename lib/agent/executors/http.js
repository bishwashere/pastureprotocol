/**
 * HTTP executor: plain `fetch` for HTTP/JSON URLs.
 *
 * Exists so a cron job (or any agent turn) that just needs to hit a URL does
 * NOT have to spin up Playwright/Chromium. That dependency is heavy, fragile
 * across version bumps, and was the actual reason "check this localhost API"
 * cron jobs were silently failing — the headless browser binary was absent
 * while plain `fetch` would have worked instantly.
 *
 * Use this for:
 *   - REST/JSON endpoints (incl. localhost / LAN / Pasture's own dashboard)
 *   - Any "is this URL up / what does it return" check
 *   - Webhook style POSTs without form rendering
 *
 * Use the `browse` skill instead when the page needs to be rendered (JS-driven
 * SPA, login flow, screenshot).
 */

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_BODY_CHARS = 14_000;
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

function ensureUrl(url) {
  const u = url && String(url).trim();
  if (!u) throw new Error('url is required');
  if (!u.startsWith('http://') && !u.startsWith('https://')) {
    throw new Error('url must start with http:// or https://');
  }
  return u;
}

function normalizeHeaders(headers) {
  if (!headers || typeof headers !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    out[String(k)] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function looksJson(contentType, body) {
  if (typeof contentType === 'string' && contentType.toLowerCase().includes('application/json')) return true;
  if (!body) return false;
  const t = body.trim();
  return (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'));
}

/**
 * Run one HTTP request.
 * @param {object} ctx - skill context (unused here; kept for executor parity)
 * @param {object} args - { url: string, method?: string, headers?: object, body?: string, timeoutMs?: number }
 * @param {string} [toolName] - e.g. http_get / http_post (sets method when args.method missing)
 */
export async function executeHttp(ctx, args = {}, toolName) {
  const action = (() => {
    if (typeof args?.action === 'string' && args.action.trim()) return args.action.trim().toLowerCase();
    if (typeof args?.command === 'string' && args.command.trim()) return args.command.trim().toLowerCase();
    if (typeof toolName === 'string' && toolName.startsWith('http_')) return toolName.slice('http_'.length).toLowerCase();
    return 'get';
  })();

  let method = (args?.method && String(args.method).trim().toUpperCase()) || action.toUpperCase();
  if (!ALLOWED_METHODS.has(method)) method = 'GET';

  let url;
  try {
    url = ensureUrl(args?.url);
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }

  const headers = normalizeHeaders(args?.headers);
  const timeoutMs = Number.isFinite(Number(args?.timeoutMs)) && Number(args.timeoutMs) > 0
    ? Math.min(Number(args.timeoutMs), 60_000)
    : DEFAULT_TIMEOUT_MS;

  const requestInit = { method, headers };
  if (method !== 'GET' && method !== 'HEAD' && args?.body != null) {
    requestInit.body = typeof args.body === 'string' ? args.body : JSON.stringify(args.body);
    if (!headers || !Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      requestInit.headers = { ...(headers || {}), 'content-type': 'application/json' };
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  requestInit.signal = controller.signal;

  const startedAt = Date.now();
  let response;
  try {
    response = await fetch(url, requestInit);
  } catch (err) {
    clearTimeout(timer);
    const aborted = err?.name === 'AbortError';
    return JSON.stringify({
      error: aborted ? `request timed out after ${timeoutMs}ms` : `fetch failed: ${err.message || err}`,
      url,
      method,
      durationMs: Date.now() - startedAt,
    });
  }
  clearTimeout(timer);

  const contentType = response.headers.get('content-type') || '';
  let bodyText = '';
  try {
    bodyText = await response.text();
  } catch (err) {
    return JSON.stringify({
      error: `failed to read body: ${err.message || err}`,
      url,
      method,
      status: response.status,
    });
  }

  const truncated = bodyText.length > MAX_BODY_CHARS;
  const bodyForReturn = truncated ? bodyText.slice(0, MAX_BODY_CHARS) : bodyText;

  const result = {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url,
    method,
    durationMs: Date.now() - startedAt,
    contentType,
    truncated,
    body: bodyForReturn,
  };

  if (looksJson(contentType, bodyText)) {
    try {
      result.json = JSON.parse(bodyText);
    } catch (_) {
      // body advertised JSON but didn't parse; leave .body for the agent
    }
  }

  return JSON.stringify(result);
}
