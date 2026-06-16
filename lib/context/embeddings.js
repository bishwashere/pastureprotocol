/**
 * Embedding API client. Calls OpenAI-compatible /embeddings endpoint.
 */

function isContextLengthError(err) {
  const msg = (err && err.message) ? String(err.message) : '';
  return /maximum context length|reduce your prompt|context length|\d+ tokens.*requested|requested.*\d+ tokens|exceeded|too long|invalid_request_error/i.test(msg);
}

/**
 * Embed one or more texts. Returns array of float arrays.
 * On context-length errors (e.g. 8192 token limit), retries with half the batch and concatenates.
 * @param {string[]} texts - Texts to embed.
 * @param {{ baseUrl: string, apiKey: string, model: string }} opts
 * @returns {Promise<number[][]>}
 */
export async function embed(texts, opts) {
  if (!texts || texts.length === 0) return [];
  const { baseUrl, apiKey, model } = opts;
  const url = `${(baseUrl || '').replace(/\/$/, '')}/embeddings`;
  const body = {
    model: model || 'text-embedding-3-small',
    input: texts.length === 1 ? texts[0] : texts,
  };
  const headers = {
    'Content-Type': 'application/json',
    ...(apiKey && apiKey !== 'not-needed' && { Authorization: `Bearer ${apiKey}` }),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Embeddings API failed ${res.status}: ${t.slice(0, 1200)}`);
  }
  const data = await res.json();
  const list = data.data;
  if (!Array.isArray(list)) throw new Error('Embeddings API response missing data array');
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const emb = list[i].embedding;
    if (!Array.isArray(emb)) throw new Error(`Embedding ${i} is not an array`);
    out.push(emb.map(Number));
  }
  return out;
}

/**
 * Embed texts; on context-length API errors only, retry with half the batch and combine.
 * Does not change batch size for subsequent calls—only splits when this call hits the limit.
 * When down to a single text that's still too long, truncate and retry so indexing never stops.
 * @param {string[]} texts - Texts to embed.
 * @param {{ baseUrl: string, apiKey: string, model: string }} opts
 * @returns {Promise<number[][]>}
 */
export async function embedWithRetry(texts, opts) {
  if (!texts || texts.length === 0) return [];
  try {
    return await embed(texts, opts);
  } catch (err) {
    if (!isContextLengthError(err)) throw err;
    if (texts.length > 1) {
      const mid = Math.ceil(texts.length / 2);
      const [a, b] = await Promise.all([
        embedWithRetry(texts.slice(0, mid), opts),
        embedWithRetry(texts.slice(mid), opts),
      ]);
      return [...a, ...b];
    }
    if (texts.length === 1) {
      const maxChars = 20000;
      const t = texts[0];
      if (typeof t !== 'string' || t.length <= maxChars) throw err;
      const truncated = t.slice(0, maxChars) + '\n...[truncated]';
      return await embedWithRetry([truncated], opts);
    }
    throw err;
  }
}
