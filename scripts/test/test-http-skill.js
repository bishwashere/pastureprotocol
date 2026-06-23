#!/usr/bin/env node
/**
 * Unit + smoke test for the http skill executor.
 *
 * Spins up a tiny localhost HTTP server, points the executor at it, and
 * verifies:
 *   - GET returns body / json / status
 *   - POST passes body and content-type
 *   - HEAD returns no body
 *   - Bad URL is rejected
 *   - Non-existent host is reported as { error }
 *   - Timeout is honored
 *   - Body is truncated above MAX_BODY_CHARS (14k)
 *
 * The executor is the same one the cron job uses, so this proves a cron job
 * can hit `http://localhost:<port>/api/...` without any browser involvement.
 */

import { createServer } from 'http';
import { executeHttp } from '../../lib/agent/executors/http.js';

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    console.log(`[PASS] ${name}`);
    passed++;
  } else {
    console.log(`[FAIL] ${name}${detail ? ' :: ' + detail : ''}`);
    failed++;
  }
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      if (req.url === '/json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ inStock: true, ram: '128GB' }));
        return;
      }
      if (req.url === '/text') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('hello world');
        return;
      }
      if (req.url === '/big') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('x'.repeat(20_000));
        return;
      }
      if (req.url === '/slow') {
        // never respond — exercises timeout path
        return;
      }
      if (req.url === '/echo' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            method: req.method,
            contentType: req.headers['content-type'] || '',
            received: body,
          }));
        });
        return;
      }
      if (req.url === '/head') {
        res.writeHead(204, { 'x-marker': 'present' });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function main() {
  const { server, baseUrl } = await startServer();
  try {
    // 1. GET JSON — parses .json field, sets ok=true, status 200
    {
      const out = JSON.parse(await executeHttp({}, { url: `${baseUrl}/json` }, 'http_get'));
      check('GET /json status 200', out.status === 200, JSON.stringify(out));
      check('GET /json body present', typeof out.body === 'string' && out.body.includes('inStock'));
      check('GET /json parsed json', out.json && out.json.inStock === true && out.json.ram === '128GB');
      check('GET /json ok=true', out.ok === true);
      check('GET /json method=GET', out.method === 'GET');
    }

    // 2. GET text/plain — body present, no .json field
    {
      const out = JSON.parse(await executeHttp({}, { url: `${baseUrl}/text` }, 'http_get'));
      check('GET /text body=hello world', out.body === 'hello world');
      check('GET /text no json field for plain text', out.json === undefined);
    }

    // 3. POST — body forwarded, content-type defaulted to JSON when object passed
    {
      const out = JSON.parse(await executeHttp(
        {},
        { url: `${baseUrl}/echo`, body: { hello: 'world' } },
        'http_post',
      ));
      check('POST default content-type=application/json', out.json && out.json.contentType.includes('application/json'));
      check('POST body forwarded', out.json && out.json.received === '{"hello":"world"}');
      check('POST method=POST', out.method === 'POST');
    }

    // 4. HEAD — empty body
    {
      const out = JSON.parse(await executeHttp({}, { url: `${baseUrl}/head` }, 'http_head'));
      check('HEAD status 204', out.status === 204);
      check('HEAD body empty', out.body === '');
    }

    // 5. Bad URL — rejected before fetch
    {
      const out = JSON.parse(await executeHttp({}, { url: 'ftp://nope' }, 'http_get'));
      check('rejects non-http(s) scheme', typeof out.error === 'string' && out.error.includes('http://'));
    }

    // 6. Missing URL — rejected
    {
      const out = JSON.parse(await executeHttp({}, {}, 'http_get'));
      check('missing url returns error', typeof out.error === 'string' && out.error.includes('url is required'));
    }

    // 7. Connection refused — closed port on loopback
    {
      const out = JSON.parse(await executeHttp({}, { url: 'http://127.0.0.1:1', timeoutMs: 2000 }, 'http_get'));
      check('connection refused -> error envelope', typeof out.error === 'string' && /fetch failed|timed out/.test(out.error));
    }

    // 8. Timeout — /slow never responds
    {
      const out = JSON.parse(await executeHttp({}, { url: `${baseUrl}/slow`, timeoutMs: 200 }, 'http_get'));
      check('timeout -> error envelope', typeof out.error === 'string' && out.error.includes('timed out'));
    }

    // 9. Body truncation — 20k server response should be capped at 14k with truncated=true
    {
      const out = JSON.parse(await executeHttp({}, { url: `${baseUrl}/big` }, 'http_get'));
      check('body capped at 14000 chars', out.body.length === 14_000);
      check('truncated flag set', out.truncated === true);
    }
  } finally {
    server.close();
  }

  console.log(`\n[http-skill] passed=${passed} failed=${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[http-skill] crashed:', err);
  process.exit(1);
});
