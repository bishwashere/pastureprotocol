#!/usr/bin/env node
/**
 * Generic API server for exposing existing Pasture agents over HTTP.
 *
 * This server does not create agents and does not write personality files.
 * Create/configure agents through the normal Pasture agent flows, then expose
 * them here by id:
 *
 *   POST /v1/agents/:agentId/chat/completions
 */

import dotenv from 'dotenv';
import express from 'express';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { getEnvPath, getAgentWorkspaceDir } from '../lib/util/paths.js';
import { ensureMainAgentInitialized, listAgentIds, resolveAgentReference, toAgentId } from '../lib/agent/agent-config.js';
import { runAgentApiChatTurn } from '../lib/agent/api-chat-turn.js';

dotenv.config({ path: getEnvPath() });

const PORT = Number(process.env.PASTURE_AGENT_API_PORT) || 1234;
const HOST = process.env.PASTURE_AGENT_API_HOST || '0.0.0.0';
const REQUEST_TIMEOUT_MS = Number(process.env.PASTURE_AGENT_API_TIMEOUT_MS) || 55_000;

ensureMainAgentInitialized();

const app = express();
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Pasture-Conversation-Id');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

function agentExists(agentId) {
  return listAgentIds().includes(agentId);
}

function resolveApiAgentId(input) {
  const direct = toAgentId(input);
  if (direct && agentExists(direct)) return direct;
  return resolveAgentReference(input) || '';
}

function appendApiLog(agentId, event) {
  try {
    appendFileSync(
      join(getAgentWorkspaceDir(agentId), 'api-agent.log'),
      JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n',
      'utf8',
    );
  } catch (_) {}
}

function normalizeMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];
  const out = [];
  for (const msg of rawMessages) {
    const role = String(msg?.role || '').trim();
    const content = typeof msg?.content === 'string' ? msg.content : '';
    if (!['system', 'user', 'assistant'].includes(role)) continue;
    if (!content.trim()) continue;
    out.push({ role, content });
  }
  return out;
}

function splitMessages(messages) {
  const lastUserIndex = messages.map((msg) => msg.role).lastIndexOf('user');
  const prior = lastUserIndex >= 0 ? messages.slice(0, lastUserIndex) : [];
  const lastUser = lastUserIndex >= 0 ? messages[lastUserIndex] : null;
  const historyMessages = prior.map((msg) => ({
    role: msg.role,
    content: msg.role === 'system'
      ? `Caller system instruction: ${msg.content}`
      : msg.content,
  }));
  return {
    userText: lastUser?.content || '',
    historyMessages,
  };
}

function normalizeApiContent(content) {
  const raw = String(content || '').replace(/^\[Pasture\]\s*/i, '').trim();
  if (!raw) return '';

  const normalizeParsed = (parsed) => {
    if (
      parsed
      && typeof parsed === 'object'
      && typeof parsed.reply === 'string'
      && (parsed.continue_listening === true || parsed.continuelistening === true)
    ) {
      return JSON.stringify({
        reply: parsed.reply,
        continue_listening: true,
      });
    }
    return null;
  };

  try {
    const normalized = normalizeParsed(JSON.parse(raw));
    if (normalized) return normalized;
  } catch (_) {}

  const jsonObjects = raw.match(/\{[^{}]*"reply"[^{}]*\}/g) || [];
  for (let i = jsonObjects.length - 1; i >= 0; i--) {
    try {
      const normalized = normalizeParsed(JSON.parse(jsonObjects[i]));
      if (normalized) return normalized;
    } catch (_) {}
  }

  return raw;
}

function completionResponse({ agentId, model, content }) {
  const created = Math.floor(Date.now() / 1000);
  return {
    id: `pasture-${agentId}-${created}-${Math.random().toString(36).slice(2, 10)}`,
    object: 'chat.completion',
    created,
    model: model || agentId,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: normalizeApiContent(content),
        },
        finish_reason: 'stop',
      },
    ],
  };
}

function timeoutTurn(timeoutMs) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        timedOut: true,
        reply: JSON.stringify({
          reply: 'One second. I am trying again.',
          continue_listening: true,
        }),
        skillsCalled: [],
      });
    }, timeoutMs);
  });
}

async function withTimeout(promise, timeoutMs) {
  return Promise.race([promise, timeoutTurn(timeoutMs)]);
}

function conversationIdFromRequest(req) {
  return String(
    req.body?.conversation_id
    || req.body?.conversationId
    || req.headers['x-pasture-conversation-id']
    || 'default',
  ).trim() || 'default';
}

app.get('/v1/agents/:agentId/health', (req, res) => {
  const agentId = resolveApiAgentId(req.params.agentId);
  if (!agentId || !agentExists(agentId)) {
    res.status(404).json({ ok: false, error: 'agent not found' });
    return;
  }
  res.json({ ok: true, service: 'pasture-agent-api', agentId });
});

app.post('/v1/agents/:agentId/chat/completions', async (req, res) => {
  const startedAt = Date.now();
  const agentId = resolveApiAgentId(req.params.agentId);
  if (!agentId || !agentExists(agentId)) {
    res.status(404).json({ error: { message: 'agent not found' } });
    return;
  }

  try {
    const messages = normalizeMessages(req.body?.messages);
    if (!messages.some((msg) => msg.role === 'user')) {
      res.status(400).json({ error: { message: 'messages must include at least one user message' } });
      return;
    }

    const { userText, historyMessages } = splitMessages(messages);
    const conversationId = conversationIdFromRequest(req);
    appendApiLog(agentId, {
      type: 'request',
      path: req.path,
      conversationId,
      model: req.body?.model || '',
      messageChars: userText.length,
      historyMessages: historyMessages.length,
    });

    const turn = await withTimeout(runAgentApiChatTurn({
      agentId,
      userText,
      conversationId,
      historyMessages,
      model: req.body?.model || '',
    }), REQUEST_TIMEOUT_MS);

    appendApiLog(agentId, {
      type: turn.timedOut ? 'timeout_response' : 'response',
      status: 200,
      durationMs: Date.now() - startedAt,
      skillsCalled: turn.skillsCalled || [],
      replyChars: String(turn.reply || '').length,
      conversationId,
      sessionId: turn.sessionId || '',
      logKey: turn.logKey || '',
    });

    res.json(completionResponse({
      agentId,
      model: req.body?.model,
      content: turn.reply || '',
    }));
  } catch (err) {
    appendApiLog(agentId, {
      type: 'error',
      status: 500,
      durationMs: Date.now() - startedAt,
      message: err?.message || String(err),
      stack: err?.stack || '',
    });
    res.status(500).json({ error: { message: err?.message || String(err) } });
  }
});

const server = app.listen(PORT, HOST, () => {
  console.log('');
  console.log('  Pasture Agent API');
  console.log('  -----------------');
  console.log(`  URL: http://${HOST}:${PORT}/v1/agents/:agentId/chat/completions`);
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is in use. Set PASTURE_AGENT_API_PORT to another port.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
