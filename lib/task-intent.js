export function normalizeIntentText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractUserTextFromPayload(text) {
  const raw = String(text || '').trim();
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.text === 'string') return parsed.text;
  } catch (_) {}
  return raw;
}

/**
 * Questions/admin turns about the tracker itself are useful chat context, but
 * they are not mission deliverables and must not become delegated tasks.
 */
export function isProjectMetaInquiry(text) {
  const normalized = normalizeIntentText(extractUserTextFromPayload(text));
  if (!normalized) return false;

  const nouns = /\b(tasks?|todos?|items?|goals?|missions?|initiatives?|logs?|history|updates?|counts?|duplicates?)\b/;
  if (!nouns.test(normalized)) return false;

  if (
    /\b(create|draft|write|build|implement|investigate|audit|research|review|prepare|design|ship|fix|analyze|plan|improve|increase|launch|instrument|validate)\b/.test(normalized)
    && !/\b(remove|dedupe|de-duplicate|clean up)\b.*\bduplicates?\b/.test(normalized)
  ) {
    return false;
  }

  if (/\b(how many|count|total|list|show|which|what are|what is|status|done|pending|open|to do|todo)\b/.test(normalized)) {
    return true;
  }
  if (/\b(you said|you re saying|are you saying|which one is correct|correct|wrong|is that right)\b/.test(normalized)) {
    return true;
  }
  if (/\b(remove|dedupe|de-duplicate|clean up)\b.*\bduplicates?\b/.test(normalized)) {
    return true;
  }
  return false;
}

export function looksLikeConcreteWorkRequest(text) {
  const normalized = normalizeIntentText(extractUserTextFromPayload(text));
  if (!normalized || isProjectMetaInquiry(normalized)) return false;
  return /\b(create|draft|write|build|implement|investigate|audit|research|review|prepare|design|ship|fix|analyze|plan|improve|increase|launch|instrument|validate)\b/.test(normalized);
}
