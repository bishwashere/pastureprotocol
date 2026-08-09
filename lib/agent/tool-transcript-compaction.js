/**
 * Remove old completed assistant/tool-call pairs after their results have been
 * persisted in the per-run worklog. This is purely mechanical transcript
 * maintenance: the Markdown checkpoint prompt decides which facts are durable.
 */
export function compactCheckpointedToolTranscript(messages, { keepRounds = 12 } = {}) {
  if (!Array.isArray(messages)) return { removedMessages: 0, removedRounds: 0, removedToolMessages: [] };
  const keep = Number.isFinite(Number(keepRounds))
    ? Math.max(0, Math.floor(Number(keepRounds)))
    : 12;
  const batches = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
      continue;
    }
    const ids = message.tool_calls.map((call) => String(call?.id || '').trim()).filter(Boolean);
    // A batch is removable only when every call has a stable unique id and a
    // matching result before the next assistant tool-call batch. Track exact
    // indexes instead of matching globally: imperfect providers sometimes
    // reuse an id in a later round, which must not remove recent evidence.
    if (ids.length !== message.tool_calls.length || new Set(ids).size !== ids.length) continue;
    const pendingIds = new Set(ids);
    const toolIndexes = [];
    for (let cursor = index + 1; cursor < messages.length && pendingIds.size > 0; cursor++) {
      const candidate = messages[cursor];
      if (candidate?.role === 'assistant' && Array.isArray(candidate.tool_calls) && candidate.tool_calls.length > 0) {
        break;
      }
      const resultId = candidate?.role === 'tool'
        ? String(candidate.tool_call_id || '').trim()
        : '';
      if (!pendingIds.has(resultId)) continue;
      pendingIds.delete(resultId);
      toolIndexes.push(cursor);
    }
    if (pendingIds.size === 0) batches.push({ index, toolIndexes });
  }
  if (batches.length <= keep) return { removedMessages: 0, removedRounds: 0, removedToolMessages: [] };

  const oldBatches = batches.slice(0, batches.length - keep);
  const indexesToRemove = new Set(oldBatches.flatMap((batch) => [batch.index, ...batch.toolIndexes]));
  const removedToolMessages = oldBatches
    .flatMap((batch) => batch.toolIndexes.map((toolIndex) => messages[toolIndex]))
    .filter(Boolean);
  let removedMessages = 0;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (!indexesToRemove.has(index)) continue;
    messages.splice(index, 1);
    removedMessages += 1;
  }
  return { removedMessages, removedRounds: oldBatches.length, removedToolMessages };
}
