/**
 * Helpers for Agent Inbox activity details stored on team activity events.
 */

export function parseInternalPairJid(jid) {
  const m = String(jid || '').match(/^internal:([^-]+)->(.+)$/);
  if (!m) return null;
  return { fromAgentId: m[1].trim(), toAgentId: m[2].trim() };
}

export function extractProjectContext(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  const urlMatch = raw.match(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9][a-z0-9-]*\.(?:com|io|net|org|ai|co|dev|app))\b/i);
  if (urlMatch) return `Project = ${urlMatch[1].toLowerCase()}`;
  return '';
}

export function buildTurnStartInboxDetails({ userText, ctx }) {
  const task = String(userText || '').trim().slice(0, 2000);
  const context = extractProjectContext(task);
  const pair = parseInternalPairJid(ctx?.jid);
  if (pair) {
    return {
      inbox: {
        kind: 'received_from',
        fromAgentId: pair.fromAgentId,
        task,
        context: context || undefined,
      },
    };
  }
  return {
    inbox: {
      kind: 'received',
      task,
      context: context || undefined,
    },
  };
}

export function buildTurnDoneInboxDetails({ textToSend, skillsCalled, ctx }) {
  const pair = parseInternalPairJid(ctx?.jid);
  const body = String(textToSend || '').replace(/^\[Pasture\]\s*/i, '').trim().slice(0, 2000);
  const skills = [...new Set(Array.isArray(skillsCalled) ? skillsCalled.filter(Boolean) : [])];
  if (pair) {
    return {
      inbox: {
        kind: 'returned_to',
        toAgentId: pair.fromAgentId,
        skills,
        result: body,
      },
    };
  }
  return {
    inbox: {
      kind: 'completed',
      skills,
      result: body,
    },
  };
}

export function buildDelegationStartInboxDetails({ message, callerAgentId, targetAgentId, routing }) {
  const task = String(message || '').trim().slice(0, 2000);
  const context = extractProjectContext(task);
  const routingBlock = routing && typeof routing === 'object' ? routing : undefined;
  return {
    inbox: {
      kind: 'delegated_to',
      fromAgentId: callerAgentId,
      toAgentId: targetAgentId,
      task,
      context: context || undefined,
      routing: routingBlock,
    },
    routing: routingBlock,
  };
}
