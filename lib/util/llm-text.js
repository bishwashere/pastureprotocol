/**
 * Remove provider-specific hidden reasoning wrappers from model output.
 *
 * Kept in a neutral utility so the generic MD prompt runner and the agent
 * runtime can share it without importing each other.
 */
export function stripThinking(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*/gi, '')
    .replace(/<\/think>/gi, '')
    .trim();
}
