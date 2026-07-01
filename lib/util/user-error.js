/**
 * Turn an error into a short, friendly message for the user.
 * No error codes, no JSON, no technical jargon.
 */

/**
 * Get a single string for logging (unwrap AggregateError so we see the real cause).
 * @param {Error|AggregateError|unknown} err
 * @returns {string}
 */
export function getErrorMessageForLog(err) {
  if (err == null) return String(err);
  if (typeof err === 'string') return err.trim() || 'Unknown error';
  const msg = err?.message != null ? String(err.message).trim() : '';
  if (err.name === 'AggregateError' && Array.isArray(err.errors) && err.errors.length > 0) {
    for (const e of err.errors) {
      const inner = getErrorMessageForLog(e);
      if (inner && inner !== 'Unknown error' && !/^AggregateError$/i.test(inner)) return inner;
    }
    const first = err.errors[0];
    const firstMsg = first?.message != null ? String(first.message).trim() : String(first);
    if (firstMsg) return firstMsg;
  }
  if (err.cause != null) {
    const causeMsg = getErrorMessageForLog(err.cause);
    if (causeMsg && causeMsg !== 'Unknown error') return causeMsg;
  }
  return msg || 'Unknown error';
}

/**
 * @param {Error|string|unknown} err
 * @returns {string}
 */
export function toUserMessage(err) {
  const msg = (err && (err.message || err)) && String(err.message || err).trim();
  if (!msg) return "Something went wrong. Please try again.";
  if (err?.code === 'LLM_DAILY_LIMIT' || /Daily cloud LLM limit reached/i.test(msg)) {
    return "The API limit 100 has been reached for the day.";
  }
  if (/401|409|authentication|api key|unauthorized|x-api-key|required/i.test(msg)) return "I couldn't sign in. Check your API key in setup.";
  if (/timeout/i.test(msg)) return "That took too long. Please try again.";
  if (/No LLM configured|No vision-capable/i.test(msg)) return "AI isn't set up. Run setup to add a model and key.";
  return "Something went wrong. Please try again.";
}
