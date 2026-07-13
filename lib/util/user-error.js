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

function failureHasQuota(message) {
  return /429|quota|insufficient_quota|billing details|api limit|rate limit/i.test(String(message || ''));
}

function failureHasNoLocalModel(message) {
  return /No models loaded|load a model|lms load/i.test(String(message || ''));
}

function failureHasAuth(message) {
  return /401|409|authentication|api key|unauthorized|x-api-key|required/i.test(String(message || ''));
}

function modelLabel(failure) {
  const label = String(failure?.model || '').trim();
  if (!label) return failure?.local ? 'local model' : 'cloud model';
  return label;
}

function formatLlmFailuresForUser(failures) {
  const list = Array.isArray(failures) ? failures.filter(Boolean) : [];
  if (!list.length) return '';
  const quota = list.filter((failure) => failureHasQuota(failure.message));
  const noLocalModel = list.filter((failure) => failure.local && failureHasNoLocalModel(failure.message));
  const auth = list.filter((failure) => failureHasAuth(failure.message));
  const parts = [];
  if (quota.length) {
    parts.push(`${modelLabel(quota[0])} hit its API quota`);
  }
  if (auth.length) {
    parts.push(`${modelLabel(auth[0])} is not authenticated`);
  }
  if (noLocalModel.length) {
    parts.push('the local fallback has no model loaded');
  }
  if (!parts.length) {
    const first = list[0];
    parts.push(`${modelLabel(first)} failed: ${String(first.message || 'unknown error').split('\n')[0]}`);
  }
  return `I couldn't answer because ${parts.join(', and ')}.`;
}

/**
 * @param {Error|string|unknown} err
 * @returns {string}
 */
export function toUserMessage(err) {
  const msg = (err && (err.message || err)) && String(err.message || err).trim();
  if (!msg) return "Something went wrong. Please try again.";
  const llmFailureMessage = formatLlmFailuresForUser(err?.llmFailures);
  if (llmFailureMessage) return llmFailureMessage;
  if (err?.code === 'LLM_DAILY_LIMIT' || /Daily cloud LLM limit reached/i.test(msg)) {
    return "The API limit 100 has been reached for the day.";
  }
  if (failureHasQuota(msg)) return "I couldn't answer because the selected cloud model hit its API quota.";
  if (failureHasNoLocalModel(msg)) return "I couldn't answer because the local model server has no model loaded.";
  if (/401|409|authentication|api key|unauthorized|x-api-key|required/i.test(msg)) return "I couldn't sign in. Check your API key in setup.";
  if (/timeout/i.test(msg)) return "That took too long. Please try again.";
  if (/No LLM configured|No vision-capable/i.test(msg)) return "AI isn't set up. Run setup to add a model and key.";
  return "Something went wrong. Please try again.";
}
