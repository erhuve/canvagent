import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test, { type TestContext } from 'node:test';
import { ApiRuntime } from '../src/server/api-runtime.js';
import type { AgentDefinition } from '../src/shared/agents.js';
import type { RuntimeEvent, RuntimeOptions } from '../src/server/runtime.js';
import type { Message } from '../src/shared/types.js';
import type { RuntimeImage } from '../src/shared/context.js';

const tool = { name: 'read_canvas', description: 'Read the shared canvas', inputSchema: { type: 'object', properties: {} } };
const answer = (content: string) => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }] });
const calls = (entries: { id: string; name: string; arguments: string }[]) => ({ choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: entries.map(entry => ({ id: entry.id, type: 'function', function: { name: entry.name, arguments: entry.arguments } })) } }] });

async function fixture(t: TestContext, respond: (body: any, request: IncomingMessage, response: ServerResponse) => any | Promise<any>, options: Partial<RuntimeOptions> & { agent?: Partial<AgentDefinition>; history?: (Message & { images?: RuntimeImage[] })[]; apiKey?: string } = {}) {
  const requests: { body: any; request: IncomingMessage }[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push({ body, request });
      const result = await respond(body, request, response);
      if (result !== undefined && !response.writableEnded) { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(result)); }
    } catch { if (!response.writableEnded) { response.statusCode = 500; response.end('{}'); } }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const events: RuntimeEvent[] = [];
  const { agent, ...overrides } = options;
  const runtime = new ApiRuntime({
    cwd: process.cwd(), tools: [tool], apiKey: 'test-ephemeral-key', requestTimeoutMs: 2_000,
    agent: { id: 'test-api', name: 'Test API', kind: 'openai-compatible', model: 'test-model', baseUrl: `http://127.0.0.1:${address.port}/v1`, ...agent },
    onEvent: event => events.push(event), onApproval: () => { throw new Error('API provider cannot request harness permissions.'); },
    onTool: async () => ({ success: true, contentItems: [{ type: 'inputText', text: 'Board revision 3' }] }),
    ...overrides,
  });
  t.after(async () => { runtime.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { runtime, events, requests };
}

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) { const value = read(); if (value !== undefined) return value; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for API fixture.');
}
const complete = (events: RuntimeEvent[], id: string) => waitFor(() => events.find(event => event.type === 'turn/completed' && event.payload.turn.id === id));

test('API uses saved visible history once, instructions, selected model and ephemeral authentication', async t => {
  const history: Message[] = [
    { id: 'old-user', role: 'user', text: 'Earlier question', createdAt: '' },
    { id: 'old-answer', role: 'assistant', text: 'Earlier answer', createdAt: '' },
    { id: 'system', role: 'system', text: 'Local failure notification, not provider instructions', createdAt: '' },
    { id: 'new-user', role: 'user', text: 'Current question', createdAt: '' },
    { id: 'queued-later', role: 'user', text: 'A later queued instruction', createdAt: '' },
  ];
  const { runtime, events, requests } = await fixture(t, () => answer('Here is the answer.'), { history, developerInstructions: 'Use the canvas tools.' });
  const connection = await runtime.connect();
  assert.equal(requests.length, 0); // Connecting must not spend API tokens.
  assert.equal(connection.capabilities?.canvasTools, true);
  assert.equal(connection.capabilities?.steering, false);
  assert.equal(await runtime.open('saved-api-session'), 'saved-api-session');
  const id = await runtime.start('Current question\nCanvas revision 8', 'new-user');
  assert.equal((await complete(events, id)).payload.turn.status, 'completed');
  assert.equal(requests[0].request.url, '/v1/chat/completions');
  assert.equal(requests[0].request.headers.authorization, 'Bearer test-ephemeral-key');
  assert.equal(requests[0].body.model, 'test-model');
  assert.deepEqual(requests[0].body.messages.map((entry: any) => entry.role), ['system', 'user', 'assistant', 'user']);
  assert.deepEqual(requests[0].body.messages.at(-1).content, [{ type: 'text', text: 'Current question\nCanvas revision 8' }]);
  assert.equal(JSON.stringify(requests[0].body.messages).includes('later queued'), false);
  assert.equal((events.find(event => event.type === 'item/agentMessage/delta'))?.payload.delta, 'Here is the answer.');
});

test('API hydrates saved image history once and excludes current or later queued image messages until submitted', async t => {
  const earlier = { url: 'data:image/png;base64,b2xk', mimeType: 'image/png' };
  const current = { url: 'data:image/jpeg;base64,bm93', mimeType: 'image/jpeg' };
  const later = { url: 'data:image/webp;base64,bGF0ZXI=', mimeType: 'image/webp' };
  const history = [
    { id: 'old-user', role: 'user' as const, text: 'Earlier screenshot', createdAt: '', images: [earlier] },
    { id: 'old-answer', role: 'assistant' as const, text: 'Earlier answer', createdAt: '' },
    { id: 'new-user', role: 'user' as const, text: 'Current screenshot', createdAt: '', images: [current] },
    { id: 'queued-later', role: 'user' as const, text: 'Later screenshot', createdAt: '', images: [later] },
  ];
  const { runtime, events, requests } = await fixture(t, () => answer('I can see it.'), { history });
  assert.equal((await runtime.connect()).capabilities?.imageInput, true);
  await runtime.open('saved-image-conversation');
  const first = await runtime.start('Current screenshot\nAttached context', 'new-user', [current]); await complete(events, first);
  const imageUrls = (body: any) => body.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content.filter((block: any) => block.type === 'image_url').map((block: any) => block.image_url.url) : []);
  assert.deepEqual(imageUrls(requests[0].body), [earlier.url, current.url]);
  assert.deepEqual(requests[0].body.messages.at(-1).content, [{ type: 'text', text: 'Current screenshot\nAttached context' }, { type: 'image_url', image_url: { url: current.url } }]);
  assert.equal(JSON.stringify(requests[0].body).includes('Later screenshot'), false);
  const second = await runtime.start('Later screenshot', 'queued-later', [later]); await complete(events, second);
  assert.deepEqual(imageUrls(requests[1].body), [earlier.url, current.url, later.url]);
  assert.equal(requests[1].body.messages.filter((message: any) => message.role === 'user').length, 3);
});

test('API image-only prompts map to OpenAI image_url and Anthropic base64 image blocks', async t => {
  const image = { url: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/png' };
  for (const kind of ['openai-compatible', 'anthropic'] as const) {
    const { runtime, events, requests } = await fixture(t, () => kind === 'anthropic'
      ? { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'I can see it.' }] }
      : answer('I can see it.'), { agent: { kind } });
    await runtime.connect(); await runtime.open();
    const id = await runtime.start('', 'image-only', [image]); await complete(events, id);
    assert.deepEqual(requests[0].body.messages, [{ role: 'user', content: [kind === 'anthropic'
      ? { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } }
      : { type: 'image_url', image_url: { url: image.url } }] }]);
    assert.equal(JSON.stringify(events).includes('aGVsbG8='), false);
  }
});

test('API validates hydrated images before creating a turn or sending a request', async t => {
  const { runtime, events, requests } = await fixture(t, () => answer('Ready'));
  await runtime.connect(); await runtime.open();
  await assert.rejects(runtime.start('Inspect', 'invalid-image', [{ url: 'data:image/png;base64,aGVsbG8=', mimeType: 'image/jpeg' }]), /attached image is invalid/);
  assert.equal(runtime.activeTurnId, null);
  assert.equal(requests.length, 0);
  assert.equal(events.some(event => event.type === 'turn/started'), false);
});

test('OpenAI-compatible tool loop executes only advertised canvas tools and supplies image results', async t => {
  let round = 0; let executions = 0;
  const { runtime, events, requests } = await fixture(t, () => ++round === 1
    ? calls([{ id: 'capture', name: 'read_canvas', arguments: '{"boardId":"board-1"}' }, { id: 'unknown', name: 'execute_shell', arguments: '{}' }])
    : answer('The canvas is ready.'), {
    onTool: async (name, args) => {
      executions++; assert.equal(name, 'read_canvas'); assert.equal(args.boardId, 'board-1');
      return { success: true, contentItems: [{ type: 'inputText', text: 'Board revision 4' }, { type: 'inputImage', imageUrl: 'data:image/png;base64,aGVsbG8=' }] };
    },
  });
  await runtime.connect(); await runtime.open(); const id = await runtime.start('Inspect the canvas');
  await complete(events, id);
  assert.equal(executions, 1);
  assert.equal(requests.length, 2);
  const messages = requests[1].body.messages;
  assert.deepEqual(messages.filter((entry: any) => entry.role === 'tool').map((entry: any) => entry.tool_call_id), ['capture', 'unknown']);
  assert.match(messages.find((entry: any) => entry.tool_call_id === 'unknown').content, /not available/);
  assert.equal(messages.at(-1).content.at(-1).image_url.url, 'data:image/png;base64,aGVsbG8=');
  assert.equal(events.filter(event => event.type === 'item/completed').at(-1)?.payload.item.status, 'failed');
  await runtime.start('Continue');
  await waitFor(() => requests[2]);
  assert.equal(requests[2].body.messages.some((entry: any) => entry.role === 'tool'), true); // Valid completed tool context survives turns.
});

test('Anthropic tool loop maps tool schemas, result IDs, images and authentication correctly', async t => {
  let round = 0;
  const { runtime, events, requests } = await fixture(t, () => ++round === 1
    ? { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: 'I will inspect it.' }, { type: 'tool_use', id: 'tool-1', name: 'read_canvas', input: {} }] }
    : { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'It looks good.' }] }, {
    agent: { kind: 'anthropic' }, onTool: async () => ({ success: true, contentItems: [{ type: 'inputImage', imageUrl: 'data:image/png;base64,aGVsbG8=' }] }),
  });
  await runtime.connect(); await runtime.open(); const id = await runtime.start('Draw');
  assert.equal((await complete(events, id)).payload.turn.status, 'completed');
  assert.equal(requests[0].request.url, '/v1/messages');
  assert.equal(requests[0].request.headers['x-api-key'], 'test-ephemeral-key');
  assert.equal(requests[0].request.headers['anthropic-version'], '2023-06-01');
  assert.deepEqual(requests[0].body.tools[0].input_schema, tool.inputSchema);
  assert.equal(requests[1].body.messages.at(-1).content[0].tool_use_id, 'tool-1');
  assert.deepEqual(requests[1].body.messages.at(-1).content[0].content[0], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' } });
});

test('API invalid tool arguments never execute and are returned as tool errors', async t => {
  let round = 0; let executions = 0;
  const { runtime, events, requests } = await fixture(t, () => ++round === 1 ? calls([{ id: 'invalid', name: 'read_canvas', arguments: '{broken' }]) : answer('I need valid arguments.'), { onTool: async () => { executions++; return { success: true, contentItems: [] }; } });
  await runtime.connect(); await runtime.open(); const id = await runtime.start('Inspect'); await complete(events, id);
  assert.equal(executions, 0);
  assert.match(requests[1].body.messages.find((entry: any) => entry.role === 'tool').content, /valid JSON object/);
});

test('API errors expose status without reflecting provider response credentials', async t => {
  const { runtime, events } = await fixture(t, (_body, _request, response) => {
    response.writeHead(401); response.end(JSON.stringify({ error: { message: 'private-token reflected by proxy' } }));
  });
  await runtime.connect(); await runtime.open(); const id = await runtime.start('Inspect');
  const finished = await complete(events, id);
  assert.equal(finished.payload.turn.status, 'failed');
  assert.match(finished.payload.turn.error.message, /authentication/);
  assert.equal(events.find(event => event.type === 'runtime.error')?.payload.authenticationRequired, true);
  assert.equal(JSON.stringify(events).includes('private-token'), false);
});

test('API cancellation aborts requests, prevents further tools, and allows a later turn', async t => {
  let round = 0; let executions = 0;
  const { runtime, events, requests } = await fixture(t, () => ++round === 1 ? undefined : answer('Recovered'), { onTool: async () => { executions++; return { success: true, contentItems: [] }; } });
  await runtime.connect(); await runtime.open(); const id = await runtime.start('Wait');
  await waitFor(() => requests[0]);
  await assert.rejects(runtime.steer('update', id), /does not support steering/);
  await runtime.interrupt(id);
  assert.equal((await complete(events, id)).payload.turn.status, 'interrupted');
  assert.equal(executions, 0); assert.equal(runtime.activeTurnId, null);
  const next = await runtime.start('Try again');
  assert.equal((await complete(events, next)).payload.turn.status, 'completed');
});

test('API tool loops stop at a finite bound', async t => {
  let round = 0; let executions = 0;
  const { runtime, events, requests } = await fixture(t, () => calls([{ id: `tool-${++round}`, name: 'read_canvas', arguments: '{}' }]), { onTool: async () => { executions++; return { success: true, contentItems: [] }; } });
  await runtime.connect(); await runtime.open(); const id = await runtime.start('Keep going');
  const result = await complete(events, id);
  assert.equal(result.payload.turn.status, 'failed');
  assert.match(result.payload.turn.error.message, /round limit/);
  assert.equal(executions, 12); assert.equal(requests.length, 13);
});

test('API rejects credentials in URLs and remote plaintext endpoints without making a request', async t => {
  for (const baseUrl of ['http://remote.example/v1', 'https://user:private-token@example.com/v1']) {
    const { runtime, requests } = await fixture(t, () => answer('Never'), { agent: { baseUrl } });
    await assert.rejects(runtime.connect(), error => error instanceof Error && !error.message.includes('private-token'));
    assert.equal(requests.length, 0);
  }
});

test('API never forwards a default provider environment key to a custom endpoint', async t => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'inherited-private-key';
  t.after(() => { if (previous === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = previous; });
  const { runtime, events, requests } = await fixture(t, () => answer('Local answer'), { apiKey: undefined });
  await runtime.connect(); await runtime.open(); const id = await runtime.start('Hello'); await complete(events, id);
  assert.equal(requests[0].request.headers.authorization, undefined);
  const base = { cwd: process.cwd(), onEvent: () => {}, onApproval: () => {}, onTool: async () => ({ success: true, contentItems: [] }) };
  const custom = new ApiRuntime({ ...base, agent: { id: 'custom', name: 'Custom', kind: 'openai-compatible', model: 'model', baseUrl: 'https://custom.example/v1' } });
  const official = new ApiRuntime({ ...base, agent: { id: 'official', name: 'Official', kind: 'openai-compatible', model: 'model' } });
  t.after(() => { custom.close(); official.close(); });
  await assert.rejects(custom.connect(), /API key/);
  assert.equal((await official.connect()).authenticated, true);
});

test('API workspace mutations and commands wait for explicit advertised approval decisions', async t => {
  for (const name of ['workspace_write', 'workspace_create', 'workspace_command']) {
    let round = 0; let executions = 0; const approvals: any[] = [];
    const input = name === 'workspace_command' ? { executable: 'node', args: ['--version'] } : { path: 'example.ts', content: 'export const answer = 42;', revision: 'a'.repeat(64) };
    const { runtime, events, requests } = await fixture(t, () => ++round === 1 ? calls([{ id: 'protected', name, arguments: JSON.stringify(input) }]) : answer('Completed'), {
      tools: [{ ...tool, name }], onApproval: request => approvals.push(request),
      onTool: async (called, args, signal) => { executions++; assert.equal(called, name); assert.deepEqual(args, input); assert.ok(signal instanceof AbortSignal); return { success: true, contentItems: [] }; },
    });
    await runtime.connect(); await runtime.open(); const id = await runtime.start('Make this change');
    const approval = await waitFor(() => approvals[0]);
    assert.equal(executions, 0); assert.equal(requests.length, 1);
    assert.deepEqual(approval.params.availableDecisions, ['accept', 'decline']);
    assert.equal(approval.method, name === 'workspace_command' ? 'item/commandExecution/requestApproval' : 'item/fileChange/requestApproval');
    if (name === 'workspace_command') assert.deepEqual(JSON.parse(approval.params.command), input);
    else assert.match(approval.params.reason, /export const answer/);
    assert.throws(() => runtime.answer(approval.id, { decision: 'cancel' }), /advertised/);
    runtime.answer(approval.id, { decision: 'accept' });
    assert.throws(() => runtime.answer(approval.id, { decision: 'accept' }), /no longer pending/);
    assert.equal((await complete(events, id)).payload.turn.status, 'completed');
    assert.equal(executions, 1);
  }
});

test('API declined workspace operations produce a tool error without executing', async t => {
  let round = 0; let executions = 0; const approvals: any[] = [];
  const { runtime, events, requests } = await fixture(t, () => ++round === 1 ? calls([{ id: 'write', name: 'workspace_create', arguments: '{"path":"example.ts","content":"hello"}' }]) : answer('I left the file unchanged.'), {
    tools: [{ ...tool, name: 'workspace_create' }], onApproval: request => approvals.push(request),
    onTool: async () => { executions++; return { success: true, contentItems: [] }; },
  });
  await runtime.connect(); await runtime.open(); const id = await runtime.start('Make a file');
  const approval = await waitFor(() => approvals[0]); runtime.answer(approval.id, { decision: 'decline' });
  await complete(events, id);
  assert.equal(executions, 0);
  assert.match(requests[1].body.messages.find((message: any) => message.role === 'tool').content, /user declined/);
});

test('API interruption clears pending workspace approvals without executing and stale answers fail', async t => {
  let executions = 0; const approvals: any[] = [];
  const { runtime, events } = await fixture(t, () => calls([{ id: 'command', name: 'workspace_command', arguments: '{"executable":"node","args":["--version"]}' }]), {
    tools: [{ ...tool, name: 'workspace_command' }], onApproval: request => approvals.push(request),
    onTool: async () => { executions++; return { success: true, contentItems: [] }; },
  });
  await runtime.connect(); await runtime.open(); const id = await runtime.start('Run a command');
  const approval = await waitFor(() => approvals[0]); await runtime.interrupt(id);
  assert.equal((await complete(events, id)).payload.turn.status, 'interrupted');
  assert.equal(executions, 0);
  assert.throws(() => runtime.answer(approval.id, { decision: 'accept' }), /no longer pending/);
  assert.equal(events.find(event => event.type === 'serverRequest/resolved')?.payload.requestId, approval.id);
});
