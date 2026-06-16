/**
 * Browse executor: local browser control via Playwright (Chromium + CDP).
 * Navigate, click, scroll, fill forms, screenshot — no cloud, no external search API.
 * Persistent browser context: reuses the same Playwright page object across skill calls
 * for the same chat (jid) when possible; only starts a new browser when stale or missing.
 * After screenshot, runs a quick vision loop: auto-describe the image and suggest next action.
 */

import { join } from 'path';
import { mkdirSync, existsSync, readFileSync } from 'fs';
import { getStateDir } from '../../util/paths.js';
import { describeImage } from '../../../llm.js';

const BROWSER_TIMEOUT_MS = 25_000;
const MAX_PAGE_TEXT_CHARS = 14_000;
const SESSION_IDLE_MS = 15 * 60 * 1000; // 15 min — then close tab to free resources

const DEFAULT_CONTEXT = {
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  viewport: { width: 1280, height: 720 },
};

/** @type {Map<string, { browser: import('playwright').Browser, context: import('playwright').BrowserContext, page: import('playwright').Page, lastUrl: string, lastActivityMs: number }>} */
const sessionByKey = new Map();

function stripHtmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getScreenshotsDir() {
  const dir = join(getStateDir(), 'browse-screenshots');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureUrl(url) {
  const u = url && String(url).trim();
  if (!u) throw new Error('url is required');
  if (!u.startsWith('http://') && !u.startsWith('https://')) throw new Error('url must start with http:// or https://');
  return u;
}

function sessionKey(ctx) {
  const jid = ctx?.jid != null ? String(ctx.jid) : '';
  return jid || 'default';
}

function isStale(session) {
  return Date.now() - session.lastActivityMs > SESSION_IDLE_MS;
}

async function closeSession(key) {
  const session = sessionByKey.get(key);
  if (!session) return;
  sessionByKey.delete(key);
  try {
    await session.context?.close?.();
    await session.browser?.close?.();
  } catch (_) {}
}

/**
 * Force-close the browse session for this context (e.g. after login/logout for a clean slate).
 * Next browse action will create a new page. Call from executor (action "reset") or from index for /browse-reset.
 * @param {object} ctx - { jid } (or any object with jid for session key)
 */
export async function resetBrowseSession(ctx) {
  const key = sessionKey(ctx);
  await closeSession(key);
}

/**
 * Get or create a browse session for this key. Reuses the same tab if not stale; otherwise starts a new browser.
 * @param {string} key - session key (e.g. jid)
 * @param {string} [url] - if provided and we create a new session or need to navigate, go to this URL
 * @returns {{ page: import('playwright').Page, session: object, currentUrl: string }}
 */
async function getOrCreateSession(key, url) {
  let session = sessionByKey.get(key);
  const now = Date.now();

  if (session) {
    if (isStale(session)) {
      await closeSession(key);
      session = null;
    } else {
      try {
        const stillOpen = session.page && !session.page.isClosed?.();
        if (stillOpen) {
          session.lastActivityMs = now;
          const currentUrl = session.page.url?.() || session.lastUrl || '';
          if (url && currentUrl !== url) {
            await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
            session.lastUrl = url;
          } else if (!currentUrl || currentUrl === 'about:blank') {
            if (url) {
              await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
              session.lastUrl = url;
            }
          }
          return { page: session.page, session, currentUrl: session.page.url?.() || session.lastUrl || url || '' };
        }
      } catch (_) {
        await closeSession(key);
        session = null;
      }
    }
  }

  // Clear sandbox-injected PLAYWRIGHT_BROWSERS_PATH that points at a non-existent cache.
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && !existsSync(process.env.PLAYWRIGHT_BROWSERS_PATH)) {
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
  }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(DEFAULT_CONTEXT);
  const page = await context.newPage();
  page.setDefaultTimeout(BROWSER_TIMEOUT_MS);

  if (url) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
  }

  session = {
    browser,
    context,
    page,
    lastUrl: url || page.url?.() || '',
    lastActivityMs: now,
  };
  sessionByKey.set(key, session);
  return { page, session, currentUrl: session.lastUrl };
}

function appendSessionHint(text, currentUrl) {
  if (!currentUrl) return text;
  const hint = `\n\nCurrent page: ${currentUrl} (tab kept open for follow-up; next message can click, scroll, or navigate from here).`;
  return text + hint;
}

/** True if the error looks like the page/browser closed or timed out mid-turn. */
function isPageClosedOrTimeout(err) {
  const msg = (err && err.message && String(err.message)) || '';
  return (
    /closed|timeout|Target closed|Protocol error|Execution context was destroyed|Browser closed|Connection closed/i.test(msg) ||
    msg.includes('page.goto') && /timeout|closed/i.test(msg)
  );
}

/**
 * Run an action with the session. If it throws a page-closed/timeout error, close session, create a new one, retry once (transparent to user).
 * @param {string} key
 * @param {string} url - required for getOrCreateSession
 * @param {(page: import('playwright').Page, session: object) => Promise<string>} fn
 * @returns {Promise<string>}
 */
async function runWithSessionRetry(key, url, fn) {
  const { page, session } = await getOrCreateSession(key, url);
  try {
    return await fn(page, session);
  } catch (err) {
    if (!isPageClosedOrTimeout(err)) throw err;
    console.log('[browse] session closed or timeout mid-turn, retrying with fresh session');
    await closeSession(key);
    const fresh = await getOrCreateSession(key, url);
    return await fn(fresh.page, fresh.session);
  }
}

/** Convert screenshot file to data URI for vision. */
function fileToDataUri(filepath) {
  const buf = readFileSync(filepath);
  const base64 = buf.toString('base64');
  return `data:image/png;base64,${base64}`;
}

/** After screenshot: describe image and suggest one next action (vision loop). */
async function visionDescribeAndSuggest(filepath) {
  try {
    const dataUri = fileToDataUri(filepath);
    const prompt = 'Describe what you see in this screenshot in 1–2 sentences. Then suggest one concrete next action the user might want (e.g. "Scroll down for more", "Click the Tech or Electronics link for that category", "Fill the search box"). One short paragraph.';
    const out = await describeImage(dataUri, prompt, 'You are a concise assistant. Describe the screenshot and suggest the next action in one short paragraph.');
    return out && String(out).trim() ? out : '';
  } catch (err) {
    console.error('[browse] vision describe failed:', err.message);
    return '';
  }
}

/**
 * @param {object} ctx - { jid } for session key (same tab per chat)
 * @param {object} args - LLM tool args: action, url?, selector?, value?, direction?
 * @returns {Promise<string>}
 */
export async function executeBrowse(ctx, args) {
  const action = (args?.action && String(args.action).trim().toLowerCase()) || 'navigate';
  const key = sessionKey(ctx);
  const urlArg = args?.url && String(args.url).trim();
  const url = urlArg ? ensureUrl(urlArg) : null;

  if (action === 'reset') {
    await closeSession(key);
    return 'Browser tab reset. Next browse will start with a fresh page (clean slate).';
  }

  if (action === 'navigate') {
    if (!url) throw new Error('url is required for navigate');
    return runWithSessionRetry(key, url, async (page, session) => {
      session.lastUrl = page.url?.() || url;
      const html = await page.content();
      const text = stripHtmlToText(html);
      const out = text.slice(0, MAX_PAGE_TEXT_CHARS);
      const body = (out || 'Page loaded; no extractable text.') + (text.length > MAX_PAGE_TEXT_CHARS ? '\n[... truncated]' : '');
      return appendSessionHint(body, page.url?.() || url);
    });
  }

  if (action === 'click') {
    if (!url) throw new Error('url is required for click');
    const selector = args?.selector && String(args.selector).trim();
    if (!selector) throw new Error('selector is required for click (e.g. "button.submit", "a#link", "[aria-label=Submit]")');
    return runWithSessionRetry(key, url, async (page, session) => {
      await page.waitForSelector(selector, { state: 'visible', timeout: 10_000 }).catch(() => {
        throw new Error(`Element not found or not visible: ${selector}`);
      });
      await page.click(selector);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      session.lastUrl = page.url?.() || url;
      const html = await page.content();
      const text = stripHtmlToText(html);
      const out = text.slice(0, MAX_PAGE_TEXT_CHARS);
      const body = 'Clicked. Page content:\n\n' + (out || 'No text.') + (text.length > MAX_PAGE_TEXT_CHARS ? '\n[... truncated]' : '');
      return appendSessionHint(body, page.url?.());
    });
  }

  if (action === 'scroll') {
    if (!url) throw new Error('url is required for scroll');
    const direction = (args?.direction && String(args.direction).trim().toLowerCase()) || 'down';
    return runWithSessionRetry(key, url, async (page, session) => {
      const delta = direction === 'up' ? -400 : direction === 'top' ? -1e9 : direction === 'bottom' ? 1e9 : 400;
      if (delta === -1e9 || delta === 1e9) {
        await page.evaluate((d) => window.scrollBy(0, d), delta);
      } else {
        await page.mouse.wheel(0, delta);
      }
      await new Promise((r) => setTimeout(r, 800));
      const html = await page.content();
      const text = stripHtmlToText(html);
      const out = text.slice(0, MAX_PAGE_TEXT_CHARS);
      const body = 'Scrolled ' + direction + '.\n\n' + (out || 'No text.') + (text.length > MAX_PAGE_TEXT_CHARS ? '\n[... truncated]' : '');
      return appendSessionHint(body, page.url?.());
    });
  }

  if (action === 'fill') {
    if (!url) throw new Error('url is required for fill');
    const selector = args?.selector && String(args.selector).trim();
    const value = args?.value != null ? String(args.value) : '';
    if (!selector) throw new Error('selector is required for fill (e.g. "input[name=q]", "#email")');
    return runWithSessionRetry(key, url, async (page, session) => {
      await page.waitForSelector(selector, { state: 'visible', timeout: 10_000 }).catch(() => {
        throw new Error(`Element not found or not visible: ${selector}`);
      });
      await page.fill(selector, value);
      await new Promise((r) => setTimeout(r, 500));
      session.lastUrl = page.url?.() || url;
      const html = await page.content();
      const text = stripHtmlToText(html);
      const out = text.slice(0, MAX_PAGE_TEXT_CHARS);
      const body = 'Filled field. Page content:\n\n' + (out || 'No text.') + (text.length > MAX_PAGE_TEXT_CHARS ? '\n[... truncated]' : '');
      return appendSessionHint(body, page.url?.());
    });
  }

  if (action === 'screenshot') {
    if (!url) throw new Error('url is required for screenshot');
    const selector = args?.selector && String(args.selector).trim();
    return runWithSessionRetry(key, url, async (page, session) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `browse-${stamp}.png`;
      const dir = getScreenshotsDir();
      const filepath = join(dir, filename);
      if (selector) {
        const el = await page.waitForSelector(selector, { state: 'visible', timeout: 10_000 }).catch(() => null);
        if (el) await el.screenshot({ path: filepath }); else await page.screenshot({ path: filepath, fullPage: true });
      } else {
        await page.screenshot({ path: filepath, fullPage: true });
      }
      session.lastUrl = page.url?.() || url;
      const html = await page.content();
      const text = stripHtmlToText(html).slice(0, 800);
      const scope = selector ? `element "${selector}"` : 'full page';
      let body = [
        'Screenshot captured.',
        'Details:',
        `  Saved to: ${filepath}`,
        `  Filename: ${filename}`,
        `  Scope: ${scope}`,
        `  URL: ${page.url?.() || url}`,
        '',
        'Page summary: ' + (text || 'No text.'),
      ].join('\n');
      const visionBlurb = await visionDescribeAndSuggest(filepath);
      if (visionBlurb) {
        body += '\n\n--- Vision (auto-describe + suggest next action)\n' + visionBlurb;
      }
      return appendSessionHint(body, page.url?.());
    });
  }

  throw new Error(`Unknown browse action: ${action}. Use one of: navigate, click, scroll, fill, screenshot, reset.`);
}
