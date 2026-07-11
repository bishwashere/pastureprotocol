import assert from 'assert';
import { EventEmitter } from 'events';
import { rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  callCodexChatgpt,
  prepareCodexConversation,
  toCodexDynamicTools,
} from '../../../../lib/llm/codex-provider.js';

const stateDir = join(tmpdir(), `pasture-codex-provider-${process.pid}-${Date.now()}`);
process.env.PASTURE_STATE_DIR = stateDir;

class FakeCodexClient extends EventEmitter {
  constructor(mode = 'message') {
    super();
    this.mode = mode;
    this.requests = [];
    this.responses = [];
  }

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === 'account/read') {
      return this.mode === 'signed-out'
        ? { account: null, requiresOpenaiAuth: true }
        : { account: { type: 'chatgpt', email: 'person@example.test', planType: 'plus' }, requiresOpenaiAuth: true };
    }
    if (method === 'thread/start') return { thread: { id: 'thread-test' } };
    if (method === 'thread/inject_items') return {};
    if (method === 'turn/start') {
      queueMicrotask(() => {
        if (this.mode === 'transport-error') {
          this.emit('transportError', new Error('fixture transport stopped'));
          return;
        }
        if (this.mode === 'hanging') return;
        if (this.mode === 'tool') {
          this.emit('serverRequest', {
            id: 44,
            method: 'item/tool/call',
            params: {
              threadId: 'thread-test',
              turnId: 'turn-test',
              callId: 'call-test',
              tool: 'search_docs',
              arguments: { query: 'oauth' },
            },
          });
          return;
        }
        this.emit('notification', {
          method: 'turn/completed',
          params: {
            threadId: 'thread-test',
            turn: {
              id: 'turn-test',
              status: 'completed',
              items: [{ id: 'message-test', type: 'agentMessage', text: 'Hello from ChatGPT.' }],
            },
          },
        });
      });
      return { turn: { id: 'turn-test' } };
    }
    if (method === 'turn/interrupt' || method === 'thread/unsubscribe') return {};
    throw new Error(`Unexpected Codex request: ${method}`);
  }

  respond(id, result) {
    this.responses.push({ id, result });
  }

  respondError(id, error) {
    this.responses.push({ id, error });
  }
}

const prepared = prepareCodexConversation([
  { role: 'system', content: 'Follow the Pasture policy.' },
  { role: 'user', content: 'Find the docs.' },
]);
assert.strictEqual(prepared.baseInstructions, 'Follow the Pasture policy.');
assert.deepStrictEqual(prepared.historyItems, []);
assert.deepStrictEqual(prepared.turnInput, [{ type: 'text', text: 'Find the docs.' }]);

const continuation = prepareCodexConversation([
  { role: 'system', content: 'System' },
  { role: 'user', content: 'Search.' },
  {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_docs', arguments: '{"query":"auth"}' } }],
  },
  { role: 'tool', tool_call_id: 'call-1', content: '{"result":"found"}' },
]);
assert.deepStrictEqual(continuation.turnInput, []);
assert(continuation.historyItems.some((item) => item.type === 'function_call'));
assert(continuation.historyItems.some((item) => item.type === 'function_call_output'));

assert.deepStrictEqual(toCodexDynamicTools([{
  type: 'function',
  function: {
    name: 'search_docs',
    description: 'Search documentation',
    parameters: { type: 'object', properties: { query: { type: 'string' } } },
  },
}]), [{
  type: 'function',
  name: 'search_docs',
  description: 'Search documentation',
  inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
}]);

const messageClient = new FakeCodexClient();
const messageResult = await callCodexChatgpt({
  client: messageClient,
  model: 'gpt-test',
  messages: [{ role: 'system', content: 'System' }, { role: 'user', content: 'Hello' }],
  tools: [],
});
assert.deepStrictEqual(messageResult, { content: 'Hello from ChatGPT.', toolCalls: [] });
const threadStart = messageClient.requests.find((request) => request.method === 'thread/start');
assert.strictEqual(threadStart.params.model, null, 'Codex should choose a ChatGPT-compatible model');
assert.strictEqual(threadStart.params.ephemeral, true);
assert.strictEqual(threadStart.params.approvalPolicy, 'never');
assert.strictEqual(threadStart.params.config.features.shell_tool, false);
assert(threadStart.params.cwd.startsWith(stateDir), 'Codex provider uses an isolated state directory');
assert.deepStrictEqual(threadStart.params.runtimeWorkspaceRoots, [threadStart.params.cwd]);

const toolClient = new FakeCodexClient('tool');
const toolResult = await callCodexChatgpt({
  client: toolClient,
  model: 'gpt-test',
  messages: [{ role: 'user', content: 'Find auth docs.' }],
  tools: [{
    type: 'function',
    function: {
      name: 'search_docs',
      description: 'Search documentation',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    },
  }],
});
assert.deepStrictEqual(toolResult, {
  content: '',
  toolCalls: [{ id: 'call-test', name: 'search_docs', arguments: '{"query":"oauth"}' }],
});
assert.strictEqual(toolClient.responses[0].id, 44);
assert.strictEqual(toolClient.responses[0].result.success, false);
const interrupt = toolClient.requests.find((request) => request.method === 'turn/interrupt');
assert.deepStrictEqual(interrupt.params, { threadId: 'thread-test', turnId: 'turn-test' });

await assert.rejects(
  () => callCodexChatgpt({
    client: new FakeCodexClient('signed-out'),
    messages: [{ role: 'user', content: 'Hello' }],
  }),
  (error) => error?.code === 'CODEX_CHATGPT_LOGIN_REQUIRED',
);

await assert.rejects(
  () => callCodexChatgpt({
    client: new FakeCodexClient('transport-error'),
    messages: [{ role: 'user', content: 'Hello' }],
  }),
  /fixture transport stopped/,
);

const hangingClient = new FakeCodexClient('hanging');
await assert.rejects(
  () => callCodexChatgpt({
    client: hangingClient,
    messages: [{ role: 'user', content: 'Hello' }],
    timeoutMs: 10,
  }),
  /timed out/,
);
const timeoutInterrupt = hangingClient.requests.find((request) => request.method === 'turn/interrupt');
assert.deepStrictEqual(timeoutInterrupt.params, { threadId: 'thread-test', turnId: 'turn-test' });

rmSync(stateDir, { recursive: true, force: true });
delete process.env.PASTURE_STATE_DIR;

console.log('test-codex-provider passed');
