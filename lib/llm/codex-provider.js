import { mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getStateDir } from '../util/paths.js';
import { getCodexAppServerClient } from './codex-app-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROVIDER_POLICY_PATH = join(__dirname, '..', 'agent', 'templates', 'codex-llm-provider.md');
const DEFAULT_TIMEOUT_MS = 180_000;

let providerPolicy;

function getProviderPolicy() {
  if (providerPolicy == null) providerPolicy = readFileSync(PROVIDER_POLICY_PATH, 'utf8').trim();
  return providerPolicy;
}

function getProviderRuntimeDir() {
  const path = join(getStateDir(), 'codex-provider-runtime');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return String(part.text || '');
    return '';
  }).filter(Boolean).join('\n');
}

function responseContent(content, output = false) {
  if (typeof content === 'string') {
    return content ? [{ type: output ? 'output_text' : 'input_text', text: content }] : [];
  }
  if (!Array.isArray(content)) {
    const text = textFromContent(content);
    return text ? [{ type: output ? 'output_text' : 'input_text', text }] : [];
  }
  const parts = [];
  for (const part of content) {
    if (typeof part === 'string' && part) {
      parts.push({ type: output ? 'output_text' : 'input_text', text: part });
      continue;
    }
    if (part?.type === 'text' && part.text) {
      parts.push({ type: output ? 'output_text' : 'input_text', text: String(part.text) });
      continue;
    }
    const imageUrl = part?.type === 'image_url'
      ? (typeof part.image_url === 'string' ? part.image_url : part.image_url?.url)
      : null;
    if (!output && imageUrl) parts.push({ type: 'input_image', image_url: String(imageUrl) });
  }
  return parts;
}

function turnInputFromContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (!Array.isArray(content)) {
    const text = textFromContent(content);
    return text ? [{ type: 'text', text }] : [];
  }
  const input = [];
  for (const part of content) {
    if (typeof part === 'string' && part) {
      input.push({ type: 'text', text: part });
      continue;
    }
    if (part?.type === 'text' && part.text) {
      input.push({ type: 'text', text: String(part.text) });
      continue;
    }
    const imageUrl = part?.type === 'image_url'
      ? (typeof part.image_url === 'string' ? part.image_url : part.image_url?.url)
      : null;
    if (imageUrl) input.push({ type: 'image', url: String(imageUrl) });
  }
  return input;
}

function messageToResponseItems(message = {}) {
  const role = String(message.role || '').toLowerCase();
  const items = [];
  if (role === 'user') {
    const content = responseContent(message.content, false);
    if (content.length) items.push({ type: 'message', role: 'user', content });
  } else if (role === 'assistant') {
    const content = responseContent(message.content, true);
    if (content.length) items.push({ type: 'message', role: 'assistant', content });
    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      items.push({
        type: 'function_call',
        call_id: String(call?.id || ''),
        name: String(call?.function?.name || ''),
        arguments: typeof call?.function?.arguments === 'string'
          ? call.function.arguments
          : JSON.stringify(call?.function?.arguments || {}),
      });
    }
  } else if (role === 'tool') {
    items.push({
      type: 'function_call_output',
      call_id: String(message.tool_call_id || ''),
      output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
    });
  }
  return items;
}

export function prepareCodexConversation(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  const instructions = list
    .filter((message) => message?.role === 'system' || message?.role === 'developer')
    .map((message) => textFromContent(message.content).trim())
    .filter(Boolean);
  let turnMessageIndex = -1;
  for (let i = list.length - 1; i >= 0; i--) {
    if (String(list[i]?.role || '').toLowerCase() === 'user') {
      const hasLaterModelInput = list.slice(i + 1).some((message) => {
        const role = String(message?.role || '').toLowerCase();
        return role === 'assistant' || role === 'tool';
      });
      if (!hasLaterModelInput) turnMessageIndex = i;
      break;
    }
  }
  const historyItems = [];
  for (let i = 0; i < list.length; i++) {
    const role = String(list[i]?.role || '').toLowerCase();
    if (role === 'system' || role === 'developer' || i === turnMessageIndex) continue;
    historyItems.push(...messageToResponseItems(list[i]));
  }
  return {
    baseInstructions: instructions.join('\n\n'),
    historyItems,
    turnInput: turnMessageIndex >= 0 ? turnInputFromContent(list[turnMessageIndex].content) : [],
  };
}

export function toCodexDynamicTools(tools = []) {
  return (Array.isArray(tools) ? tools : []).map((tool) => ({
    type: 'function',
    name: String(tool?.function?.name || ''),
    description: String(tool?.function?.description || ''),
    inputSchema: tool?.function?.parameters || { type: 'object', properties: {} },
  })).filter((tool) => tool.name);
}

function openAiResult(content, toolCalls) {
  return {
    content: String(content || '').trim(),
    toolCalls: Array.isArray(toolCalls) ? toolCalls : [],
  };
}

export async function callCodexChatgpt({
  messages,
  tools,
  client = getCodexAppServerClient(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const account = await client.request('account/read', { refreshToken: true }, { timeoutMs: 20_000 });
  if (account?.account?.type !== 'chatgpt') {
    const error = new Error('OpenAI browser login is not complete. Sign in from Config → LLM and try again.');
    error.code = 'CODEX_CHATGPT_LOGIN_REQUIRED';
    throw error;
  }

  const prepared = prepareCodexConversation(messages);
  const dynamicTools = toCodexDynamicTools(tools);
  const runtimeDir = getProviderRuntimeDir();
  const threadResult = await client.request('thread/start', {
    // Platform model names and Codex/ChatGPT model names are different
    // catalogs. Let Codex choose the current compatible default instead of
    // forwarding a value such as `gpt-5.2`, which ChatGPT auth rejects.
    model: null,
    allowProviderModelFallback: true,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    cwd: runtimeDir,
    ephemeral: true,
    environments: [],
    runtimeWorkspaceRoots: [runtimeDir],
    selectedCapabilityRoots: [],
    baseInstructions: prepared.baseInstructions || getProviderPolicy(),
    developerInstructions: getProviderPolicy(),
    dynamicTools,
    config: {
      mcp_servers: {},
      features: {
        apps: false,
        browser_use: false,
        code_mode_host: false,
        computer_use: false,
        image_generation: false,
        multi_agent: false,
        shell_tool: false,
        unified_exec: false,
      },
    },
    serviceName: 'pasture_protocol',
  }, { timeoutMs: 90_000 });
  const threadId = threadResult?.thread?.id;
  if (!threadId) throw new Error('Codex App Server did not create an LLM thread.');

  if (prepared.historyItems.length) {
    await client.request('thread/inject_items', {
      threadId,
      items: prepared.historyItems,
    }, { timeoutMs: 30_000 });
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let latestContent = '';
    let activeTurnId = '';
    const toolCalls = [];
    const timer = setTimeout(() => {
      if (activeTurnId) {
        void client.request('turn/interrupt', { threadId, turnId: activeTurnId }, { timeoutMs: 5_000 })
          .catch(() => {});
      }
      finish(new Error('OpenAI browser-login model call timed out.'));
    }, timeoutMs);

    const cleanup = () => {
      clearTimeout(timer);
      client.off('notification', onNotification);
      client.off('serverRequest', onServerRequest);
      client.off('transportError', onTransportError);
      if (client.running !== false) {
        client.request('thread/unsubscribe', { threadId }, { timeoutMs: 5_000 }).catch(() => {});
      }
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(result);
    };
    const interruptWithToolCall = (turnId) => {
      // Returning the tool call to Pasture must not wait on interruption. The
      // App Server requires both ids; interruption is only cleanup for the
      // now-delegated Codex turn, while Pasture executes the tool itself.
      void client.request('turn/interrupt', { threadId, turnId }, { timeoutMs: 5_000 })
        .catch(() => {});
      finish(null, openAiResult(latestContent, toolCalls));
    };
    const onTransportError = (error) => {
      finish(error instanceof Error ? error : new Error('Codex App Server connection failed.'));
    };
    const onServerRequest = (request) => {
      if (request?.params?.threadId !== threadId) return;
      if (request.method !== 'item/tool/call') {
        client.respondError(request.id, {
          code: -32000,
          message: 'Pasture Protocol only permits configured dynamic LLM tools.',
        });
        return;
      }
      const args = request.params?.arguments;
      toolCalls.push({
        id: String(request.params?.callId || ''),
        name: String(request.params?.tool || ''),
        arguments: typeof args === 'string' ? args : JSON.stringify(args || {}),
      });
      client.respond(request.id, {
        success: false,
        contentItems: [{ type: 'inputText', text: 'Tool execution was delegated to the host application.' }],
      });
      interruptWithToolCall(String(request.params?.turnId || ''));
    };
    const onNotification = ({ method, params } = {}) => {
      if (params?.threadId !== threadId) return;
      if (params?.turn?.id) activeTurnId = String(params.turn.id);
      if (method === 'item/completed' && params?.item?.type === 'agentMessage') {
        latestContent = String(params.item.text || latestContent);
        return;
      }
      if (method !== 'turn/completed') return;
      const turn = params?.turn || {};
      const finalMessage = [...(Array.isArray(turn.items) ? turn.items : [])]
        .reverse()
        .find((item) => item?.type === 'agentMessage' && item.text);
      if (finalMessage?.text) latestContent = String(finalMessage.text);
      if (toolCalls.length) {
        finish(null, openAiResult(latestContent, toolCalls));
      } else if (turn.status === 'failed') {
        finish(new Error(turn.error?.message || 'OpenAI browser-login model call failed.'));
      } else if (turn.status === 'interrupted') {
        finish(new Error('OpenAI browser-login model call was interrupted.'));
      } else {
        finish(null, openAiResult(latestContent, []));
      }
    };

    client.on('notification', onNotification);
    client.on('serverRequest', onServerRequest);
    client.on('transportError', onTransportError);
    client.request('turn/start', {
      threadId,
      input: prepared.turnInput,
    }, { timeoutMs: 30_000 })
      .then((result) => {
        activeTurnId = String(result?.turn?.id || activeTurnId);
      })
      .catch((error) => finish(error));
  });
}
