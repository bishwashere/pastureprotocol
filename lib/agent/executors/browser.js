/**
 * Browser executor: runs search / navigate from LLM-provided args.
 */

import { readFileSync } from 'fs';
import { getConfigPath } from '../paths.js';
import { resolveEnvCredential } from '../credential-utils.js';

const BROWSER_TIMEOUT_MS = 20_000;
const MAX_RESULT_CHARS = 12_000;
const BRAVE_SEARCH_BASE = 'https://api.search.brave.com/res/v1/web/search';
const BRAVE_NEWS_BASE = 'https://api.search.brave.com/res/v1/news/search';
const DEFAULT_SEARCH_COUNT = 8;
const MAX_SEARCH_COUNT = 20;

function stripHtmlToText(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getBrowserSearchConfig() {
  try {
    const raw = readFileSync(getConfigPath(), 'utf8');
    const config = JSON.parse(raw);
    const search = config.skills?.search && typeof config.skills.search === 'object'
      ? config.skills.search
      : config.skills?.browser?.search;
    if (!search || typeof search !== 'object') {
      return { apiKey: process.env.BRAVE_API_KEY, count: DEFAULT_SEARCH_COUNT };
    }
    const apiKey = resolveEnvCredential(search.apiKey) ?? process.env.BRAVE_API_KEY;
    const count = Math.min(MAX_SEARCH_COUNT, Math.max(1, Number(search.count) || DEFAULT_SEARCH_COUNT));
    return { apiKey, count, enabled: search.enabled !== false };
  } catch {
    return { apiKey: process.env.BRAVE_API_KEY, count: DEFAULT_SEARCH_COUNT };
  }
}

/** Returns raw Brave web results: [{ title, description, url }]. Empty array on no results or API error. */
async function braveSearchRaw(query, opts = {}) {
  const apiKey = opts.apiKey || process.env.BRAVE_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) return [];
  const count = Math.min(MAX_SEARCH_COUNT, Math.max(1, opts.count ?? DEFAULT_SEARCH_COUNT));
  const url = new URL(BRAVE_SEARCH_BASE);
  url.searchParams.set('q', query.trim().slice(0, 400));
  url.searchParams.set('count', String(count));
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'X-Subscription-Token': apiKey.trim(), Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const results = data?.web?.results ?? [];
    return results.map((r) => ({
      title: (r.title || '').trim() || 'Untitled',
      description: (r.description || '').trim(),
      url: (r.url || '').trim(),
    }));
  } catch {
    return [];
  }
}

/** Format news as title + snippet (no source). Used for both Brave and RSS so we show headline and a little info, not the source. */
function formatNewsResult(items) {
  const lines = items.map((item, i) => {
    const title = item.title || 'Untitled';
    const info = item.description || item.snippet || '';
    const link = item.url || item.link || '';
    const block = link ? `${title}\n${info ? info + '\n' : ''}${link}` : `${title}\n${info}`;
    return `${i + 1}. ${block}`.trim();
  });
  return 'Top news:\n\n' + lines.join('\n\n');
}

async function braveSearch(query, opts = {}) {
  const results = await braveSearchRaw(query, opts);
  if (results.length === 0) return 'No search results found for that query.';
  const lines = results.map((r, i) => {
    const part = r.url ? `${r.title}\n${r.description ? r.description + '\n' : ''}${r.url}` : `${r.title}\n${r.description}`;
    return `${i + 1}. ${part}`.trim();
  });
  return 'Search results:\n\n' + lines.join('\n\n');
}

/**
 * Brave News endpoint — returns article-level URLs + descriptions. Falls back to web search if news
 * endpoint returns nothing. Returns null if both fail, so caller falls back to BBC browse then RSS.
 */
async function braveNewsRaw(query, opts = {}) {
  const apiKey = opts.apiKey || process.env.BRAVE_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) return [];
  const count = Math.min(MAX_SEARCH_COUNT, Math.max(1, opts.count ?? DEFAULT_SEARCH_COUNT));
  const url = new URL(BRAVE_NEWS_BASE);
  url.searchParams.set('q', query.trim().slice(0, 400));
  url.searchParams.set('count', String(count));
  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'X-Subscription-Token': apiKey.trim(), Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    const results = data?.results ?? [];
    return results.map((r) => ({
      title: (r.title || '').trim() || 'Untitled',
      description: (r.description || '').trim(),
      url: (r.url || '').trim(),
      age: (r.age || '').trim(),
      source: (r.source?.name || r.meta_url?.hostname || '').trim(),
    }));
  } catch {
    return [];
  }
}

/**
 * For news queries: priority 1 = Brave News API (article URLs + descriptions), priority 2 = Brave web.
 * Returns formatted "Top news:" or null if both fail so caller falls back to BBC browse then RSS.
 */
async function braveSearchNewsOnly(query, searchConfig) {
  if (!isNewsQuery(query)) return null;
  const n = /\b(three|3|five|5|ten|10)\b/.exec(query.toLowerCase());
  const max = n ? { three: 3, 3: 3, five: 5, 5: 5, ten: 10, 10: 10 }[n[1].toLowerCase()] || 5 : 5;
  const headlineQuery = `top headlines today`;
  // Try Brave News endpoint first — article-specific URLs with descriptions
  const newsRaw = await braveNewsRaw(headlineQuery, { apiKey: searchConfig.apiKey, count: max });
  if (newsRaw.length > 0) {
    return formatNewsResult(newsRaw.slice(0, max).map((r) => ({
      title: r.title,
      description: [r.description, r.age, r.source].filter(Boolean).join(' · '),
      url: r.url,
    })));
  }
  // Brave News unavailable — fall back to web search
  const webRaw = await braveSearchRaw(headlineQuery, { apiKey: searchConfig.apiKey, count: max });
  if (webRaw.length === 0) return null;
  return formatNewsResult(webRaw.slice(0, max).map((r) => ({ title: r.title, description: r.description, url: r.url })));
}

function normalizeSearchResult(text) {
  if (!text || typeof text !== 'string') return text;
  const t = text.toLowerCase();
  if (t.includes('please email us') || t.includes('anonymized error code') || t.includes('support email address') || t.includes('context of your search')) {
    return 'The search engine returned an error (it often blocks automated requests). Try again in a moment, or ask for a specific topic.';
  }
  return text;
}

function isNewsQuery(query) {
  if (!query || typeof query !== 'string') return false;
  const q = query.toLowerCase().trim();
  const num = '(three|3|five|5|ten|10)';
  const newsOrHeadlines = '(news|headlines)';
  const lead = '(top|latest|current|today\'?s?|this week\'?s?)';
  return (
    new RegExp(`^${lead}?\\s*${num}?\\s*${newsOrHeadlines}`).test(q) ||
    /\b(news|headlines)\b.*\b(top|latest|three|five|ten)\b/.test(q) ||
    new RegExp(`\\b${lead}\\s*${num}?\\s*${newsOrHeadlines}\\b`).test(q) ||
    /\b(top|latest)\s*(three|3|five|5)?\s*news\b/.test(q) ||
    new RegExp(`\\b${num}\\s*${newsOrHeadlines}\\b`).test(q) ||
    // "in the news [temporal]" or "news [temporal]" — e.g. "what's in the news this week?"
    /\b(in the\s+)?news\b.{0,30}\b(this week|today|tonight|right now|currently|lately)\b/.test(q)
  );
}

const NEWS_RSS_URLS = ['https://feeds.bbci.co.uk/news/rss.xml', 'https://feeds.npr.org/1001/rss.xml'];

function parseRssItems(xml, maxItems = 10) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>|<entry[^>]*>([\s\S]*?)<\/entry>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null && items.length < maxItems) {
    const block = (m[1] || m[2] || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');
    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link[^>]*href=["']([^"']+)["']/i) || block.match(/<link[^>]*>([^<]+)<\/link>/i);
    const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    const link = linkMatch ? (linkMatch[1] || '').trim() : '';
    if (title) items.push({ title, link });
  }
  return items;
}

async function fetchNewsFromRss(maxHeadlines = 10) {
  const allItems = [];
  for (const url of NEWS_RSS_URLS) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; wa-llm/1.0)' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const items = parseRssItems(xml, Math.ceil(maxHeadlines / 2));
      allItems.push(...items);
    } catch (_) {
      continue;
    }
  }
  if (allItems.length === 0) return 'Could not fetch news right now. Try again in a moment.';
  const seen = new Set();
  const unique = allItems.filter((i) => {
    const key = i.title.slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const take = unique.slice(0, maxHeadlines);
  const lines = take.map((item, i) => `${i + 1}. ${item.title}${item.link ? ` (${item.link})` : ''}`);
  return 'Top news / headlines:\n\n' + lines.join('\n\n');
}

/**
 * News priority 2 (BBC fallback): open BBC and extract headlines (title + link).
 * Returns formatted "Top news:" string or null on failure so caller can fall back to RSS.
 */
const NEWS_BROWSE_URLS = ['https://www.bbc.com/news', 'https://www.bbc.com/news/world'];

async function fetchNewsViaBrowse(maxHeadlines = 5) {
  try {
    const result = await runWithBrowser(async (page) => {
      for (const url of NEWS_BROWSE_URLS) {
        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
          const items = await page.evaluate((max) => {
            const links = Array.from(document.querySelectorAll('a[href*="/news/"]'));
            const seen = new Set();
            const out = [];
            for (const a of links) {
              const title = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200);
              const href = (a.href || '').trim();
              if (title.length < 15 || title.length > 180) continue;
              if (!href || !href.startsWith('http')) continue;
              const key = title.slice(0, 60);
              if (seen.has(key)) continue;
              seen.add(key);
              out.push({ title, link: href });
              if (out.length >= max) break;
            }
            return out;
          }, maxHeadlines);
          if (items.length > 0) return formatNewsResult(items.map((i) => ({ title: i.title, link: i.link })));
        } catch (_) {
          continue;
        }
      }
      return null;
    });
    return result;
  } catch (_) {
    return null;
  }
}

/** RSS fallback: same title + link format (no source), for when search returns nothing. */
async function fetchNewsFormatted(maxHeadlines = 5) {
  const allItems = [];
  for (const url of NEWS_RSS_URLS) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; wa-llm/1.0)' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const xml = await res.text();
      const items = parseRssItems(xml, Math.ceil(maxHeadlines / 2));
      allItems.push(...items);
    } catch (_) {
      continue;
    }
  }
  if (allItems.length === 0) return 'Could not fetch news right now. Try again in a moment.';
  const seen = new Set();
  const unique = allItems.filter((i) => {
    const key = i.title.slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const take = unique.slice(0, maxHeadlines);
  return formatNewsResult(take.map((i) => ({ title: i.title, link: i.link })));
}

async function runWithBrowser(fn) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(BROWSER_TIMEOUT_MS);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/**
 * @param {object} ctx - unused for browser
 * @param {object} args - LLM tool args (action, query?, url?)
 */
export async function executeBrowser(ctx, args) {
  const action = args?.action && String(args.action).trim().toLowerCase();
  if (!action) throw new Error('action required (search or navigate)');

  if (action === 'search') {
    const query = args?.query && String(args.query).trim();
    if (!query) throw new Error('query required for search');

    if (isNewsQuery(query)) {
      const n = /\b(three|3|five|5|ten|10)\b/.exec(query.toLowerCase());
      const max = n ? { three: 3, 3: 3, five: 5, 5: 5, ten: 10, 10: 10 }[n[1].toLowerCase()] || 5 : 5;
      // Top news priority: (1) Brave web (returns descriptions/summaries), (2) BBC browse fallback, (3) RSS
      const searchConfig = getBrowserSearchConfig();
      if (searchConfig.apiKey && searchConfig.enabled !== false) {
        const braveResult = await braveSearchNewsOnly(query, searchConfig);
        if (braveResult != null) return braveResult;
      }
      const browseResult = await fetchNewsViaBrowse(max);
      if (browseResult != null && browseResult.length > 50) return browseResult;
      return fetchNewsFormatted(max);
    }

    const searchConfig = getBrowserSearchConfig();
    if (searchConfig.apiKey && searchConfig.enabled !== false) {
      return braveSearch(query, { apiKey: searchConfig.apiKey, count: searchConfig.count });
    }
    return runWithBrowser(async (page) => {
      const searchUrl = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
      const html = await page.content();
      let text = stripHtmlToText(html);
      text = normalizeSearchResult(text);
      const out = text.slice(0, MAX_RESULT_CHARS);
      if (text.length > MAX_RESULT_CHARS) return out + '\n[... truncated]';
      return out || 'No text content found.';
    });
  }

  if (action === 'navigate') {
    const url = args?.url && String(args.url).trim();
    if (!url) throw new Error('url required for navigate');
    if (!url.startsWith('http://') && !url.startsWith('https://')) throw new Error('url must start with http:// or https://');
    return runWithBrowser(async (page) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });
      const html = await page.content();
      const text = stripHtmlToText(html);
      const out = text.slice(0, MAX_RESULT_CHARS);
      if (text.length > MAX_RESULT_CHARS) return out + '\n[... truncated]';
      return out || 'No text content found.';
    });
  }

  throw new Error(`Unknown action: ${action}`);
}
