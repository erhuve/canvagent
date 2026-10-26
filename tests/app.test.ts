import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createApplication } from '../src/server/app.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { RuntimeOptions } from '../src/server/runtime.ts';
import { Store } from '../src/server/store.ts';
import { defaultAgentSettings, type AgentSettings } from '../src/shared/settings.ts';

class FakeRuntime {
  closed = false;
  threadId: string | null = null;
  activeTurnId: string | null = null;
  opens: { threadId: string; settings: AgentSettings }[] = [];
  starts: { text: string; requestId?: string; turnId: string; settings: AgentSettings }[] = [];
  steers: { text: string; turnId: string }[] = [];
  answers: { id: string | number; result: any }[] = [];
  nextSteerError: Error | undefined;
  connection: any = { authenticated: true, version: 'test-runtime', models: [{ id: 'test-model', name: 'Test model' }] };
  constructor(readonly options: RuntimeOptions) {}
  async connect() {
    this.options.onEvent({ type: 'connection.changed', payload: { state: 'connected' } });
    return this.connection;
  }
  settingsSnapshot() { return structuredClone((this.options as RuntimeOptions & { settings: () => AgentSettings }).settings()); }
  async open(threadId?: string) {
    this.threadId = threadId ?? `thread-${randomUUID()}`;
    this.opens.push({ threadId: this.threadId, settings: this.settingsSnapshot() });
    return this.threadId;
  }
  async start(text: string, requestId?: string) {
    this.activeTurnId = `turn-${this.starts.length + 1}`;
    this.starts.push({ text, requestId, turnId: this.activeTurnId, settings: this.settingsSnapshot() });
    this.options.onEvent({ type: 'turn/started', payload: { threadId: this.threadId, turn: { id: this.activeTurnId } } });
    return this.activeTurnId;
  }
  async steer(text: string, turnId: string) {
    assert.equal(turnId, this.activeTurnId); this.steers.push({ text, turnId });
    const failure = this.nextSteerError; this.nextSteerError = undefined;
    if (failure) throw failure;
  }
  answer(id: string | number, result: any) { this.answers.push({ id, result }); }
  async interrupt() { this.complete('interrupted'); }
  close() { this.closed = true; }
  complete(status = 'completed') {
    const turnId = this.activeTurnId; this.activeTurnId = null;
    this.options.onEvent({ type: 'turn/completed', payload: { threadId: this.threadId, turn: { id: turnId, status } } });
  }
  approval(id: number) {
    this.options.onApproval({ id, method: 'item/commandExecution/requestApproval', params: {
      threadId: this.threadId, turnId: this.activeTurnId, command: 'npm test', reason: 'Run the project tests', availableDecisions: ['accept', 'decline'],
    } });
  }
}

async function fixture(t: TestContext, customize: (runtime: FakeRuntime) => void = () => {}) {
  const directory = mkdtempSync(join(tmpdir(), 'canvagent-app-'));
  const workspace = join(directory, 'workspace'); mkdirSync(workspace);
  const runtimes: FakeRuntime[] = [];
  const options = { workspace, dataDir: join(directory, 'data'), port: 0,
    runtimeFactory: (configuration: RuntimeOptions) => { const runtime = new FakeRuntime(configuration); customize(runtime); runtimes.push(runtime); return runtime as any; } };
  const application = createApplication(options);
  t.after(async () => { await application.close(); rmSync(directory, { recursive: true, force: true }); });
  await new Promise<void>((resolveListen, reject) => {
    application.server.once('error', reject);
    application.server.listen(0, '127.0.0.1', () => { application.server.off('error', reject); resolveListen(); });
  });
  const address = application.server.address();
  assert.ok(address && typeof address === 'object');
  options.port = address.port;
  const base = `http://127.0.0.1:${address.port}`;
  let cookie = '';
  async function request(path: string, body?: any, headers: Record<string, string> = {}, authenticated = true) {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(authenticated && cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, body: await response.json() as any };
  }
  const bootstrap = await request('/api/state');
  assert.equal(bootstrap.response.status, 200);
  cookie = bootstrap.response.headers.get('set-cookie')!.split(';')[0];
  const sessionId = bootstrap.body.activeSessionId as string;
  async function message(id: string, text = 'Build the selected design', elementIds: string[] = []) {
    return request(`/api/sessions/${sessionId}/messages`, { requestId: id, text, selection: { elementIds } });
  }
  async function create(id: string, requestId = `draw-${id}`) {
    return request('/api/board/mutate', { requestId, observedBoardRevision: application.store.board().revision,
      operations: [{ kind: 'create', elementId: id, element: { id, type: 'rectangle', x: 20, y: 30, width: 120, height: 80, isDeleted: false, version: 1, index: 'a1' } }] });
  }
  return { application, bootstrap, request, message, create, runtimes, sessionId, workspace, base };
}

async function waitFor(predicate: () => boolean, timeout = 2500) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { if (Date.now() >= deadline) assert.fail('Expected asynchronous application state was not reached.'); await delay(15); }
}
function context(text: string) { return JSON.parse(text.split('[Canvagent canvas resource context]\n')[1]); }
function toolText(result: any) { return JSON.parse(result.contentItems.find((item: any) => item.type === 'inputText').text); }
async function canvasClient(t: TestContext, url: string, token: string) {
  const client = new Client({ name: 'canvagent-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  t.after(() => client.close());
  return client;
}

test('bootstrap creates a project/session; local origin and cookie protect commands', async t => {
  const f = await fixture(t);
  assert.equal(f.bootstrap.body.sessions.length, 1);
  assert.equal(f.bootstrap.body.board.revision, 0);
  assert.match(f.bootstrap.response.headers.get('set-cookie')!, /HttpOnly/i);
  assert.match(f.bootstrap.response.headers.get('set-cookie')!, /SameSite=Strict/i);
  assert.equal((await f.request('/api/sessions', { title: 'Denied' }, {}, false)).response.status, 401);
  assert.equal((await f.request('/api/state', undefined, { Origin: 'https://untrusted.example' }, false)).response.status, 403);
  // undici may replace Host with the URL authority; use the raw HTTP transport
  // so the server receives the hostile Host header this assertion exercises.
  const hostileHostStatus = await new Promise<number>((resolveStatus, reject) => {
    const request = httpRequest(`${f.base}/api/state`, { headers: { host: 'untrusted.example' } }, response => {
      response.resume(); response.on('end', () => resolveStatus(response.statusCode!));
    });
    request.on('error', reject); request.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await f.request('/api/sessions', { title: 'Second' }, { Origin: f.base })).response.status, 200);
  assert.equal(f.application.state().sessions.length, 2);
});

test('ordinary message gets the current selected board; retry dispatches exactly one native turn', async t => {
  const f = await fixture(t);
  assert.equal((await f.create('design')).response.status, 200);
  const first = await f.message('request-one', 'Implement this sketch', ['design']);
  assert.equal(first.response.status, 202);
  const runtime = f.runtimes[0];
  assert.equal(runtime.starts.length, 1);
  const resource = context(runtime.starts[0].text);
  assert.equal(resource.revision, 1);
  assert.deepEqual(resource.selectedIds, ['design']);
  assert.deepEqual(resource.missingSelectedIds, []);
  assert.equal(resource.overview[0].id, 'design');
  assert.ok(runtime.options.tools!.some(tool => tool.name === 'apply_canvas_ops'));
  const retry = await f.message('request-one', 'Implement this sketch', ['design']);
  assert.deepEqual(retry.body, first.body);
  assert.equal(runtime.starts.length, 1);
  assert.equal(f.application.state().sessions[0].messages.filter(message => message.role === 'user').length, 1);
  assert.equal((await f.message('request-one', 'Different instruction', ['design'])).response.status, 409);
  assert.equal(runtime.starts.length, 1);
});

test('canvas MCP discovery uses separate credentials and calls are scoped to the active conversation', async t => {
  const f = await fixture(t);
  await f.request('/api/runtime/connect', {});
  const runtime = f.runtimes[0];
  const token = runtime.options.canvasMcp!.token;
  const path = `/mcp/${f.sessionId}`;
  const discovery = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  assert.equal((await f.request(path, discovery)).response.status, 401, 'A browser cookie cannot authorize MCP calls.');
  assert.equal((await f.request(path, discovery, { Authorization: `Bearer ${token}`, Origin: 'https://example.com' })).response.status, 403);
  assert.equal((await f.request('/api/sessions', {}, { Authorization: `Bearer ${token}` }, false)).response.status, 401, 'The MCP credential cannot authorize browser commands.');
  const client = await canvasClient(t, `${f.base}${path}`, token);
  const catalogue = await client.listTools();
  assert.equal(catalogue.tools.length, 5);
  const schema = catalogue.tools.find(tool => tool.name === 'apply_canvas_ops')!.inputSchema;
  assert.ok(JSON.stringify(schema).includes('freedraw'));
  assert.equal((await client.callTool({ name: 'read_canvas', arguments: {} })).isError, true, 'Idle threads cannot use the endpoint to inspect the board.');
  await f.message('active-work');
  const current = await client.callTool({ name: 'read_canvas', arguments: {} });
  assert.equal(current.isError, false);
  const other = await f.request('/api/sessions', { title: 'Other conversation' });
  assert.equal((await f.request(`/mcp/${other.body.id}`, discovery, { Authorization: `Bearer ${token}` })).response.status, 401);
  await f.request('/api/runtime/connect', {});
  const otherClient = await canvasClient(t, `${f.base}/mcp/${other.body.id}`, f.runtimes[1].options.canvasMcp!.token);
  assert.equal((await otherClient.callTool({ name: 'read_canvas', arguments: {} })).isError, true);
  const failedCapture = await client.callTool({ name: 'capture_region', arguments: {} });
  assert.equal(failedCapture.isError, true);
  assert.match(JSON.stringify(failedCapture.content), /RESOURCE_UNAVAILABLE/);
  runtime.complete();
  assert.equal((await client.callTool({ name: 'read_canvas', arguments: {} })).isError, true, 'Completed turns cannot keep calling tools.');
});

test('a saved conversation resumes after restart with current drawing tools, original messages and its existing canvas', async t => {
  const f = await fixture(t);
  await f.create('human-design');
  await f.message('previous-request', 'Keep the indigo colour and the asymmetrical layout.');
  f.runtimes[0].complete();
  const old = structuredClone(f.application.state());
  const dataDir = f.application.store.dataDir;
  await f.application.close();
  let runtime: FakeRuntime | undefined;
  const reopened = createApplication({ workspace: f.workspace, dataDir, port: 0,
    runtimeFactory: options => { runtime = new FakeRuntime(options); return runtime as any; } });
  let client: Client | undefined;
  try {
    await new Promise<void>(resolve => reopened.server.listen(0, '127.0.0.1', resolve));
    const address = reopened.server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const bootstrap = await fetch(`${base}/api/state`);
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
    const restored = await bootstrap.json() as any;
    assert.equal(restored.activeSessionId, old.activeSessionId);
    assert.deepEqual(restored.sessions[0].messages, old.sessions[0].messages);
    assert.deepEqual(restored.board.elements, old.board.elements);
    const response = await fetch(`${base}/api/sessions/${f.sessionId}/messages`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: 'after-upgrade', text: 'Continue the same design with a freehand sketch.' }) });
    assert.equal(response.status, 202);
    assert.equal(runtime!.threadId, old.sessions[0].threadId);
    assert.equal(reopened.state().sessions.length, 1);
    client = new Client({ name: 'resumed-conversation', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(runtime!.options.canvasMcp!.url()), { requestInit: { headers: { Authorization: `Bearer ${runtime!.options.canvasMcp!.token}` } } }));
    const draw = await client.callTool({ name: 'apply_canvas_ops', arguments: { requestId: 'resumed-freehand', observedBoardRevision: restored.board.revision,
      operations: [{ kind: 'create', elementId: 'new-stroke', shape: 'freedraw', x: 250, y: 100, points: [[0, 0], [40, -30], [80, 20], [20, 60]] }] } });
    assert.equal(draw.isError, false);
    const state = reopened.state();
    assert.equal(state.sessions[0].id, f.sessionId);
    assert.equal(state.sessions[0].threadId, old.sessions[0].threadId);
    assert.equal(state.sessions[0].messages[0].text, old.sessions[0].messages[0].text);
    assert.ok(state.board.elements.some(element => element.id === 'human-design'));
    assert.equal(state.board.elements.find(element => element.id === 'new-stroke')!.type, 'freedraw');
    assert.equal(state.board.metadata['new-stroke'].actor, `agent:${f.sessionId}`);
  } finally { await client?.close(); await reopened.close(); }
});

test('human changes are batched into the active turn; agent edits and idle drawings do not generate notices', async t => {
  const f = await fixture(t);
  await f.message('work'); const runtime = f.runtimes[0];
  await f.create('human-one'); await f.create('human-two');
  await waitFor(() => runtime.steers.length === 1);
  const notice = JSON.parse(runtime.steers[0].text.split('\n')[1]);
  assert.equal(notice.kind, 'canvas_changed');
  assert.equal(notice.expectedTurnId, runtime.activeTurnId);
  assert.equal(notice.sinceRevision, 0);
  assert.equal(notice.throughRevision, 2);
  assert.deepEqual(new Set(notice.changedIds), new Set(['human-one', 'human-two']));
  const agentResult = await runtime.options.onTool('apply_canvas_ops', { requestId: 'agent-note', observedBoardRevision: 2,
    operations: [{ kind: 'create', elementId: 'agent-note', shape: 'text', text: 'Working on this', x: 240, y: 30 }] });
  assert.equal(agentResult.success, true);
  assert.equal(toolText(agentResult).ok, true);
  await delay(950); assert.equal(runtime.steers.length, 1);
  runtime.complete(); await f.create('idle-drawing');
  await delay(950);
  assert.equal(runtime.steers.length, 1);
  assert.equal(runtime.starts.length, 1);
});

test('retrying an accepted board mutation does not create another resource notice', async t => {
  const f = await fixture(t);
  await f.message('work'); const runtime = f.runtimes[0];
  const command = { requestId: 'draw-once', observedBoardRevision: 0,
    operations: [{ kind: 'create', elementId: 'one', element: { id: 'one', type: 'rectangle', x: 0, y: 0, width: 100, height: 80 } }] };
  const first = await f.request('/api/board/mutate', command);
  await waitFor(() => runtime.steers.length === 1);
  const retry = await f.request('/api/board/mutate', command);
  assert.deepEqual(retry.body, first.body);
  assert.equal(f.application.store.board().revision, 1);
  await delay(950);
  assert.equal(runtime.steers.length, 1);
});

test('a human undo notifies the active agent of the newly deleted object', async t => {
  const f = await fixture(t);
  const created = await f.create('design');
  await f.message('work'); const runtime = f.runtimes[0];
  const undone = await f.request('/api/board/undo', { requestId: 'undo-design', mutationId: created.body.mutationId });
  assert.equal(undone.body.ok, true);
  await waitFor(() => runtime.steers.length === 1);
  const notice = JSON.parse(runtime.steers[0].text.split('\n')[1]);
  assert.deepEqual(notice.deletedIds, ['design']);
});

test('an uncertain canvas notice is not retried until an explicit update delivers fresh context', async t => {
  const f = await fixture(t);
  await f.message('work'); const runtime = f.runtimes[0];
  runtime.nextSteerError = Object.assign(new Error('Lost the steering response'), { uncertain: true });
  await f.create('first-correction');
  await waitFor(() => runtime.steers.length === 1);
  await f.create('second-correction');
  await delay(950);
  assert.equal(runtime.steers.length, 1);
  assert.equal(f.application.state().runtime.capabilities.canvasChangeNotices, false);
  await f.message('explicit-update', 'Use my latest corrections');
  assert.equal(runtime.steers.length, 2);
  const current = JSON.parse(runtime.steers[1].text.split('[Current canvas resource context]\n')[1]);
  assert.equal(current.revision, 2);
  assert.equal(current.overview.length, 2);
  await f.create('third-correction');
  await waitFor(() => runtime.steers.length === 3);
  const nextNotice = JSON.parse(runtime.steers[2].text.split('\n')[1]);
  assert.deepEqual(nextNotice.changedIds, ['third-correction']);
});

test('a queued message uses fresh dispatch context while preserving its original board reference', async t => {
  const f = await fixture(t);
  await f.message('first'); const runtime = f.runtimes[0];
  runtime.approval(1);
  const queued = await f.message('queued', 'Use the new box', ['draw-later']);
  assert.equal(queued.response.status, 202);
  assert.equal(runtime.starts.length, 1);
  assert.equal(runtime.steers.length, 0);
  assert.equal(f.application.state().sessions[0].queued.length, 1);
  await f.create('draw-later');
  runtime.complete();
  await waitFor(() => runtime.starts.length === 2);
  const resource = context(runtime.starts[1].text);
  assert.equal(resource.revision, 1);
  assert.deepEqual(resource.selectedIds, ['draw-later']);
  assert.deepEqual(resource.missingSelectedIds, []);
  assert.ok(resource.overview.some((element: any) => element.id === 'draw-later'));
  const original = f.application.state().sessions[0].messages.find(message => message.id === 'queued');
  assert.equal(original!.canvasReference!.revision, 0);
});

test('only an advertised approval decision is sent, and the native request is answered once', async t => {
  const f = await fixture(t);
  await f.message('work'); const runtime = f.runtimes[0];
  runtime.approval(42);
  const approval = f.application.state().sessions[0].pendingApprovals[0];
  const path = `/api/sessions/${f.sessionId}/approvals/${approval.id}`;
  assert.equal((await f.request(path, { decision: 'acceptForSession' })).response.status, 400);
  assert.equal(runtime.answers.length, 0);
  assert.equal((await f.request(path, { requestId: 'approval-once', decision: 'accept' })).response.status, 200);
  assert.deepEqual(runtime.answers, [{ id: 42, result: { decision: 'accept' } }]);
  assert.equal((await f.request(path, { requestId: 'approval-once', decision: 'accept' })).response.status, 409);
  assert.equal(runtime.answers.length, 1);
  assert.equal(f.application.state().sessions[0].status, 'running');
});

test('Computer Use permission elicitation offers approval and sends an empty accepted form exactly once', async t => {
  const f = await fixture(t);
  await f.message('computer-use'); const runtime = f.runtimes[0];
  runtime.options.onApproval({ id: 0, method: 'mcpServer/elicitation/request', params: {
    threadId: runtime.threadId, turnId: runtime.activeTurnId, serverName: 'cua_repl', mode: 'form',
    message: 'Allow Computer Use to use "Google Chrome"?',
    requestedSchema: { type: 'object', properties: {} },
    _meta: { codex_approval_kind: 'mcp_tool_call', connector_name: 'Computer Use', persist: ['session', 'always'] },
  } });
  const approval = f.application.state().sessions[0].pendingApprovals[0];
  assert.deepEqual(approval.choices, ['accept', 'decline', 'cancel']);
  assert.equal(runtime.answers.length, 0);
  const path = `/api/sessions/${f.sessionId}/approvals/${approval.id}`;
  assert.equal((await f.request(path, { decision: 'acceptForSession' })).response.status, 400);
  assert.equal((await f.request(path, { decision: 'accept' })).response.status, 200);
  assert.deepEqual(runtime.answers, [{ id: 0, result: { action: 'accept', content: {}, _meta: null } }]);
  assert.equal((await f.request(path, { decision: 'accept' })).response.status, 409);
  assert.equal(runtime.answers.length, 1);
  assert.equal(f.application.state().sessions[0].status, 'running');
});

test('denied and cancelled elicitations do not submit form content', async t => {
  const f = await fixture(t);
  await f.message('computer-use'); const runtime = f.runtimes[0];
  for (const decision of ['decline', 'cancel']) {
    runtime.options.onApproval({ id: decision, method: 'mcpServer/elicitation/request', params: {
      threadId: runtime.threadId, mode: 'form', message: 'Allow this app?', requestedSchema: { type: 'object', properties: {}, required: [] },
    } });
    const approval = f.application.state().sessions[0].pendingApprovals[0];
    assert.equal((await f.request(`/api/sessions/${f.sessionId}/approvals/${approval.id}`, { decision })).response.status, 200);
    assert.deepEqual(runtime.answers.at(-1), { id: decision, result: { action: decision, content: null, _meta: null } });
  }
});

test('forms with inputs, unsupported constraints, or verification flows cannot be blindly approved', async t => {
  const f = await fixture(t);
  await f.message('forms'); const runtime = f.runtimes[0];
  const unsupported = [
    { mode: 'form', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
    { mode: 'form', requestedSchema: { type: 'object', properties: {}, required: ['missing'] } },
    { mode: 'form', requestedSchema: { type: 'object', properties: {}, minProperties: 1 } },
    { mode: 'form', requestedSchema: { type: 'object', properties: [] } },
    { mode: 'form', requestedSchema: null },
    { mode: 'url', url: 'https://example.com/verify', elicitationId: 'verify' },
    { mode: 'openai/userVerification', challenge: 'verification-required' },
  ];
  for (const params of unsupported) {
    runtime.options.onApproval({ id: 'form', method: 'mcpServer/elicitation/request', params: {
      ...params, threadId: runtime.threadId, message: 'Provide input', availableDecisions: ['accept', 'decline'],
    } });
    const approval = f.application.state().sessions[0].pendingApprovals[0];
    assert.deepEqual(approval.choices, ['decline', 'cancel']);
    const path = `/api/sessions/${f.sessionId}/approvals/${approval.id}`;
    const count = runtime.answers.length;
    assert.equal((await f.request(path, { decision: 'accept' })).response.status, 400);
    assert.equal(runtime.answers.length, count);
    assert.equal((await f.request(path, { decision: 'decline' })).response.status, 200);
  }
});

test('agent publishes durable outputs and receives an explicit unavailable capture without a browser', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, 'report.txt'), 'Original output');
  await f.message('work'); const runtime = f.runtimes[0];
  const published = await runtime.options.onTool('publish_artifact', { requestId: 'publish-report', sourcePath: 'report.txt', title: 'Report' });
  assert.equal(published.success, true);
  const artifact = toolText(published);
  assert.equal(artifact.title, 'Report');
  writeFileSync(join(f.workspace, 'report.txt'), 'Changed workspace file');
  const response = await fetch(`${f.base}/api/artifacts/${artifact.id}`, { headers: { cookie: f.bootstrap.response.headers.get('set-cookie')!.split(';')[0] } });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'Original output');
  assert.match(response.headers.get('content-disposition')!, /^attachment;/);
  const attached = await runtime.options.onTool('attach_artifact', { requestId: 'attach-report', artifactId: artifact.id, x: 300, y: 100 });
  assert.equal(toolText(attached).ok, true);
  assert.equal(f.application.store.board().elements[0].link, `/api/artifacts/${artifact.id}`);
  const unavailable = await runtime.options.onTool('capture_region', {});
  assert.equal(unavailable.success, false);
  assert.match(toolText(unavailable).error, /RESOURCE_UNAVAILABLE/);
  assert.equal((await f.request(`/api/artifacts/${artifact.id}`, undefined, {}, false)).response.status, 401);
});

test('authorization failure updates the visible runtime state for a fresh login', async t => {
  const f = await fixture(t);
  await f.message('needs-login');
  const runtime = f.runtimes[0];
  runtime.options.onEvent({ type: 'error', payload: { threadId: runtime.threadId,
    error: { message: 'Please sign in again.', codexErrorInfo: 'unauthorized' } } });
  runtime.complete('failed');
  assert.equal(f.application.state().runtime.authenticated, false);
  assert.equal(f.application.state().runtime.error, 'Please sign in again.');
  assert.equal(f.application.state().sessions[0].status, 'failed');
});

test('queued dispatch waits for a late start acknowledgment after terminal completion', async t => {
  let acceptStart: (() => void) | undefined;
  const f = await fixture(t, runtime => {
    const start = runtime.start.bind(runtime);
    runtime.start = async (text, requestId) => {
      const turnId = await start(text, requestId);
      if (requestId === 'slow-start') await new Promise<void>(resolveStart => { acceptStart = resolveStart; });
      return turnId;
    };
  });
  const first = f.message('slow-start');
  await waitFor(() => !!acceptStart);
  const runtime = f.runtimes[0];
  runtime.approval(700);
  await f.message('queued-followup', 'Continue with the latest canvas');
  assert.equal(f.application.state().sessions[0].queued.length, 1);
  runtime.complete();
  await delay(30);
  assert.equal(runtime.starts.length, 1);
  acceptStart!();
  await first;
  await waitFor(() => runtime.starts.length === 2);
  assert.equal(f.application.state().sessions[0].status, 'running');
});

test('another conversation can start before a pending start acknowledgment returns', async t => {
  let acknowledge: (() => void) | undefined;
  const f = await fixture(t, runtime => {
    const start = runtime.start.bind(runtime);
    runtime.start = async (text, id) => {
      const turnId = await start(text, id);
      if (id === 'slow-first') await new Promise<void>(resolve => { acknowledge = resolve; });
      return turnId;
    };
  });
  const first = f.message('slow-first');
  await waitFor(() => !!acknowledge);
  const other = (await f.request('/api/sessions', { title: 'Parallel work' })).body;
  const second = f.request(`/api/sessions/${other.id}/messages`, { requestId: 'second', text: 'Work in parallel' });
  try {
    await waitFor(() => f.runtimes[1]?.starts.length === 1);
    assert.equal((await second).response.status, 202);
    assert.deepEqual(f.application.state().sessions.map(s => s.status), ['running', 'running']);
    assert.notEqual(f.runtimes[0].threadId, f.runtimes[1].threadId);
    assert.equal(f.application.state().activeSessionId, other.id);
    f.runtimes[0].complete(); f.runtimes[1].complete();
    assert.equal((await f.request('/api/settings', { model: 'test-model' })).response.status, 200);
    assert.equal(f.application.state().runtime.settings.model, 'test-model');
    assert.equal(f.application.state().sessions[0].settings?.model, '');
    assert.ok(f.runtimes.every(runtime => !runtime.closed));
  } finally { acknowledge!(); await first; }
});

test('parallel streams, approvals with matching native IDs, steering and stop stay in their conversation', async t => {
  const f = await fixture(t);
  const other = (await f.request('/api/sessions', { title: 'Other' })).body;
  const sendOther = (id: string) => f.request(`/api/sessions/${other.id}/messages`, { requestId: id, text: 'Other task' });
  await Promise.all([f.message('first'), sendOther('second')]);
  const [first, second] = f.runtimes;
  for (const [runtime, text] of [[first, 'First reply'], [second, 'Second reply']] as const) {
    runtime.options.onEvent({ type: 'item/agentMessage/delta', payload: { threadId: runtime.threadId, turnId: runtime.activeTurnId, itemId: 'same-item', delta: text } });
    runtime.approval(42);
  }
  const [a, b] = f.application.state().sessions;
  assert.equal(a.messages.find(m => m.id === 'same-item')?.text, 'First reply');
  assert.equal(b.messages.find(m => m.id === 'same-item')?.text, 'Second reply');
  assert.equal((await f.request(`/api/sessions/${a.id}/approvals/${b.pendingApprovals[0].id}`, { decision: 'accept' })).response.status, 409);
  await f.request(`/api/sessions/${a.id}/approvals/${a.pendingApprovals[0].id}`, { decision: 'accept' });
  assert.equal(first.answers.length, 1); assert.equal(second.answers.length, 0);
  assert.equal(b.status, 'awaiting_approval');
  await f.message('update-first', 'Update the first task');
  assert.equal(first.steers.length, 1); assert.equal(second.steers.length, 0);
  await sendOther('queued-second');
  assert.equal(b.queued.length, 1);
  await f.request(`/api/sessions/${a.id}/interrupt`, {});
  assert.equal(a.status, 'idle'); assert.equal(b.status, 'awaiting_approval');
  assert.equal(b.queued.length, 1); assert.ok(second.activeTurnId);
  second.complete();
  await waitFor(() => second.starts.length === 2);
  assert.equal(a.status, 'idle'); assert.equal(b.status, 'running');
});

test('canvas notices and MCP credentials are independent across simultaneous turns', async t => {
  const f = await fixture(t);
  await f.message('first');
  const other = (await f.request('/api/sessions', { title: 'Other' })).body;
  await f.request(`/api/sessions/${other.id}/messages`, { requestId: 'second', text: 'Other task' });
  const [first, second] = f.runtimes;
  const clients = await Promise.all(f.runtimes.map(runtime => canvasClient(t, runtime.options.canvasMcp!.url(), runtime.options.canvasMcp!.token)));
  const wrongToken = await f.request(`/mcp/${other.id}`, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: `Bearer ${first.options.canvasMcp!.token}` });
  assert.equal(wrongToken.response.status, 401);
  for (const client of clients) {
    const draw = await client.callTool({ name: 'apply_canvas_ops', arguments: { requestId: 'same-draw', observedBoardRevision: 0,
      operations: [{ kind: 'create', shape: 'text', text: 'Parallel note' }] } });
    assert.equal(draw.isError, false);
  }
  assert.equal(f.application.store.board().elements.length, 2);
  assert.deepEqual(new Set(Object.values(f.application.store.board().metadata).map(m => m.actor)), new Set([`agent:${f.sessionId}`, `agent:${other.id}`]));
  first.nextSteerError = Object.assign(new Error('Uncertain first notice'), { uncertain: true });
  await f.create('human-edit');
  await waitFor(() => first.steers.length === 1 && second.steers.length === 1);
  await f.create('second-edit');
  await waitFor(() => second.steers.length === 2);
  assert.equal(first.steers.length, 1);
  first.complete();
  await f.create('after-first-completes');
  await waitFor(() => second.steers.length === 3);
  assert.equal(first.steers.length, 1);
  assert.equal((await clients[0].callTool({ name: 'read_canvas', arguments: {} })).isError, true);
  assert.equal((await clients[1].callTool({ name: 'read_canvas', arguments: {} })).isError, false);
});

test('a disconnected runtime can resume without interrupting other work or accepting stale events', async t => {
  const f = await fixture(t);
  await f.message('first');
  const other = (await f.request('/api/sessions', { title: 'Other' })).body;
  await f.request(`/api/sessions/${other.id}/messages`, { requestId: 'second', text: 'Other task' });
  const [first, second] = f.runtimes;
  const originalThread = first.threadId;
  first.options.onEvent({ type: 'connection.changed', payload: { state: 'disconnected', reason: 'First process exited', activeTurnId: first.activeTurnId } });
  first.activeTurnId = null;
  assert.deepEqual(f.application.state().sessions.map(s => s.status), ['unknown', 'running']);
  assert.equal(f.application.state().runtime.connected, true);
  assert.equal(f.application.state().runtime.authenticated, true);
  await f.message('resume-first');
  const resumed = f.runtimes[2];
  assert.equal(resumed.threadId, originalThread);
  assert.notEqual(resumed.options.canvasMcp!.token, first.options.canvasMcp!.token);
  first.options.onEvent({ type: 'turn/completed', payload: { threadId: originalThread, turn: { id: 'turn-1', status: 'completed' } } });
  assert.deepEqual(f.application.state().sessions.map(s => s.status), ['running', 'running']);
  assert.ok(second.activeTurnId);
  await f.application.close();
  assert.ok(f.runtimes.every(runtime => runtime.closed));
});

function settingsCatalog(runtime: FakeRuntime) {
  runtime.connection.models = [
    { id: 'test-model', name: 'Test model', isDefault: true, defaultReasoningEffort: 'high',
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }, { reasoningEffort: 'high', description: 'Thorough' }],
      serviceTiers: [{ id: 'fast', name: 'Fast' }, { id: 'flex', name: 'Flexible' }] },
    { id: 'small-model', name: 'Small model', defaultReasoningEffort: 'low',
      supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Quick' }], serviceTiers: [{ id: 'flex', name: 'Flexible' }] },
  ];
}

test('workspace settings are defaults for new conversations; existing sessions keep independent settings', async t => {
  const f = await fixture(t, settingsCatalog);
  assert.deepEqual(f.bootstrap.body.runtime.settings, defaultAgentSettings());
  assert.deepEqual(f.bootstrap.body.sessions[0].settings, defaultAgentSettings());
  await f.request('/api/runtime/connect', {});
  const defaults = { model: 'test-model', reasoningEffort: 'high', serviceTier: 'fast', networkAccess: true,
    writableRoots: [f.workspace], configOverrides: { personality: 'friendly' } };
  assert.equal((await f.request('/api/settings', defaults)).response.status, 200);
  const other = (await f.request('/api/sessions', { title: 'Configured defaults' })).body;
  assert.deepEqual(other.settings, { ...defaultAgentSettings(), ...defaults });
  assert.deepEqual(f.application.state().sessions[0].settings, defaultAgentSettings());
  const changed = await f.request(`/api/sessions/${other.id}/settings`, { reasoningEffort: 'low', serviceTier: 'flex' });
  assert.equal(changed.response.status, 200);
  assert.equal(f.application.state().sessions[1].settings?.reasoningEffort, 'low');
  assert.equal(f.application.state().runtime.settings.reasoningEffort, 'high');
  assert.equal(f.application.state().runtime.model, 'test-model');
  assert.equal((await f.request('/api/settings', { verbosity: 'low' })).response.status, 200);
  assert.equal(f.application.state().runtime.settings.model, 'test-model', 'Partial defaults preserve the other selected values.');
  assert.equal(f.application.state().sessions[1].settings?.verbosity, '', 'Changing defaults leaves existing sessions unchanged.');
  await Promise.all([
    f.message('original-defaults'),
    f.request(`/api/sessions/${other.id}/messages`, { requestId: 'custom-defaults', text: 'Use the configured settings' }),
  ]);
  assert.deepEqual(f.runtimes[0].starts[0].settings, defaultAgentSettings());
  assert.deepEqual(f.runtimes[1].starts[0].settings, { ...defaultAgentSettings(), ...defaults, reasoningEffort: 'low', serviceTier: 'flex' });
  assert.ok(f.runtimes.every(runtime => !runtime.closed));
});

test('remembered composer settings survive restart and apply to new conversations without copying conversation instructions', async t => {
  const f = await fixture(t, settingsCatalog);
  await f.request('/api/runtime/connect', {});
  const workspaceSettings = { additionalInstructions: 'Use the workspace conventions.', configOverrides: { model_context_window: 200000 } };
  assert.equal((await f.request('/api/settings', workspaceSettings)).response.status, 200);
  const conversationSettings = { additionalInstructions: 'Draw a diagram for this conversation.', configOverrides: { personality: 'pragmatic' } };
  assert.equal((await f.request(`/api/sessions/${f.sessionId}/settings`, conversationSettings)).response.status, 200);
  const existing = (await f.request('/api/sessions', { title: 'Keep my settings' })).body;
  const existingSettings = structuredClone(existing.settings);
  const approvalSettings = { approvalPolicy: 'on-request' as const, approvalsReviewer: 'auto_review' as const, sandboxMode: 'workspace-write' as const };
  const modelSettings = { model: 'test-model', reasoningEffort: 'high', serviceTier: 'fast' };
  for (const patch of [approvalSettings, modelSettings]) {
    const saved = await f.request(`/api/sessions/${f.sessionId}/settings?remember=true`, patch);
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.id, f.sessionId, 'Remembering preferences keeps the existing session response shape.');
    assert.deepEqual(saved.body.settings, { ...defaultAgentSettings(), ...conversationSettings, ...approvalSettings,
      ...(patch === modelSettings ? modelSettings : {}) });
  }
  const expectedDefaults = { ...defaultAgentSettings(), ...workspaceSettings, ...approvalSettings, ...modelSettings };
  assert.deepEqual(f.application.state().runtime.settings, expectedDefaults);
  assert.equal(f.application.state().runtime.model, modelSettings.model);
  assert.deepEqual(f.application.state().sessions.find(session => session.id === existing.id)!.settings, existingSettings);
  assert.deepEqual((await f.request('/api/sessions', { title: 'Use remembered preferences' })).body.settings, expectedDefaults);
  const dataDir = f.application.store.dataDir;
  await f.application.close();
  const reopened = createApplication({ workspace: f.workspace, dataDir, port: 0 });
  try {
    assert.deepEqual(reopened.state().runtime.settings, expectedDefaults);
    assert.deepEqual(reopened.store.get('settings'), expectedDefaults);
    assert.deepEqual(reopened.state().sessions.find(session => session.id === f.sessionId)!.settings,
      { ...defaultAgentSettings(), ...conversationSettings, ...approvalSettings, ...modelSettings });
    assert.deepEqual(reopened.state().sessions.find(session => session.id === existing.id)!.settings, existingSettings);
    await new Promise<void>(resolveListen => reopened.server.listen(0, '127.0.0.1', resolveListen));
    const address = reopened.server.address(); assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const state = await fetch(`${base}/api/state`);
    const cookie = state.headers.get('set-cookie')!.split(';')[0];
    const created = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(created.status, 200);
    assert.deepEqual((await created.json() as any).settings, expectedDefaults);
  } finally { await reopened.close(); }
});

test('remembered settings validate the conversation, defaults and opt-in before changing saved preferences', async t => {
  const f = await fixture(t, settingsCatalog);
  await f.request('/api/runtime/connect', {});
  assert.equal((await f.request('/api/settings', { model: 'small-model', reasoningEffort: 'low', serviceTier: 'flex' })).response.status, 200);
  assert.equal((await f.request(`/api/sessions/${f.sessionId}/settings`, { model: 'test-model', reasoningEffort: 'high', serviceTier: 'fast' })).response.status, 200);
  const original = structuredClone(f.application.state());
  const savedSessions = f.application.store.get('sessions');
  const savedDefaults = f.application.store.get('settings');
  for (const [query, patch] of [
    ['?remember=true', { reasoningEffort: 'high' }], // Valid for this conversation, incompatible with the default model.
    ['?remember=true', { model: 'small-model' }], // Valid for defaults, incompatible with the conversation's thinking and speed.
    ['?remember=true', { approvalsReviewer: 'unsupported' }],
    ['?remember=false', { verbosity: 'low' }],
    ['?remember=', { verbosity: 'low' }],
    ['?remember=true&remember=true', { verbosity: 'low' }],
  ] as const) {
    const response = await f.request(`/api/sessions/${f.sessionId}/settings${query}`, patch);
    assert.equal(response.response.status, 400, `Must reject ${query} with ${JSON.stringify(patch)}.`);
    assert.deepEqual(f.application.state().runtime.settings, original.runtime.settings);
    assert.equal(f.application.state().runtime.model, original.runtime.model);
    assert.deepEqual(f.application.state().sessions, original.sessions);
    assert.deepEqual(f.application.store.get('sessions'), savedSessions);
    assert.deepEqual(f.application.store.get('settings'), savedDefaults);
    assert.equal(f.runtimes[0].closed, false);
  }
});

test('settings changed during parallel work apply to the next turn, including queued dispatch', async t => {
  const f = await fixture(t, settingsCatalog);
  await f.message('first');
  const other = (await f.request('/api/sessions', { title: 'Other active task' })).body;
  await f.request(`/api/sessions/${other.id}/messages`, { requestId: 'other', text: 'Continue independently' });
  const [first, second] = f.runtimes;
  const originalThreadId = first.threadId;
  const originalSettings = structuredClone(first.starts[0].settings);
  first.approval(31);
  await f.message('queued-settings', 'Use my new thinking level for the next turn');
  const update = { model: 'test-model', reasoningEffort: 'high', serviceTier: 'fast', collaborationMode: 'plan' as const };
  assert.equal((await f.request(`/api/sessions/${f.sessionId}/settings`, update)).response.status, 200);
  assert.equal((await f.request('/api/settings', { model: 'small-model', reasoningEffort: 'low' })).response.status, 200);
  assert.deepEqual(first.starts[0].settings, originalSettings, 'An active turn retains its dispatch snapshot.');
  assert.deepEqual(second.starts[0].settings, defaultAgentSettings());
  assert.equal(f.application.state().sessions[1].settings?.model, '');
  assert.equal(f.application.state().sessions[0].pendingApprovals.length, 1);
  assert.ok(f.runtimes.every(runtime => !runtime.closed));
  assert.ok(second.activeTurnId);
  first.complete();
  await waitFor(() => f.runtimes[2]?.starts.length === 1);
  const resumed = f.runtimes[2];
  assert.equal(first.closed, true, 'A changed configuration reconnects only after the active turn completes.');
  assert.equal(first.starts.length, 1);
  assert.deepEqual(first.starts[0].settings, originalSettings);
  assert.deepEqual(resumed.starts[0].settings, { ...defaultAgentSettings(), ...update });
  assert.equal(resumed.threadId, originalThreadId, 'Reconnecting configuration preserves the existing native thread.');
  assert.equal(resumed.opens[0].threadId, originalThreadId);
  assert.equal(second.starts.length, 1);
  assert.equal(second.closed, false);
  assert.ok(second.activeTurnId);
  resumed.complete();
  assert.equal((await f.request(`/api/sessions/${f.sessionId}/settings`, { reasoningEffort: 'low', collaborationMode: 'default' })).response.status, 200);
  assert.equal(resumed.closed, false, 'Saving settings leaves an idle runtime open until the next dispatch.');
  await f.message('after-settings');
  const next = f.runtimes[3];
  assert.equal(resumed.closed, true);
  assert.equal(next.threadId, originalThreadId);
  assert.equal(next.starts[0].settings.reasoningEffort, 'low');
  assert.equal(next.starts[0].settings.collaborationMode, 'default');
  assert.equal(next.starts[0].settings.serviceTier, 'fast');
  assert.equal(second.closed, false);
});

test('invalid settings and incompatible capabilities retain prior values without closing active runtimes', async t => {
  const f = await fixture(t, runtime => {
    settingsCatalog(runtime);
    runtime.connection.requirements = { allowedApprovalPolicies: ['on-request'], allowedApprovalsReviewers: ['user'],
      allowedSandboxModes: ['read-only', 'workspace-write'], allowedWebSearchModes: ['disabled', 'cached'] };
  });
  await f.message('active-validation');
  const original = structuredClone(f.application.state());
  const invalid: any[] = [
    { model: 'test-model', reasoningEffort: 'ultra' },
    { model: 'small-model', reasoningEffort: 'high' }, { model: 'small-model', serviceTier: 'fast' },
    { reasoningEffort: 'ultra' }, { serviceTier: 'turbo' }, { approvalPolicy: 'never' },
    { approvalsReviewer: 'auto_review' }, { sandboxMode: 'danger-full-access' }, { webSearch: 'live' },
    { fastMode: true }, { networkAccess: 'true' }, { writableRoots: [42] }, { configOverrides: [] },
    { collaborationMode: 'unsupported' }, { reasoningSummary: 'verbose' }, { verbosity: 'xhigh' }, { model: null },
  ];
  for (const value of invalid) {
    for (const path of ['/api/settings', `/api/sessions/${f.sessionId}/settings`]) {
      const response = await f.request(path, value);
      assert.equal(response.response.status, 400, `${path} must reject ${JSON.stringify(value)}`);
      assert.deepEqual(f.application.state().runtime.settings, original.runtime.settings);
      assert.deepEqual(f.application.state().sessions[0].settings, original.sessions[0].settings);
      assert.equal(f.application.state().sessions[0].status, 'running');
      assert.equal(f.runtimes.length, 1);
      assert.equal(f.runtimes[0].closed, false);
    }
  }
  assert.equal((await f.request('/api/sessions/missing-session/settings', { model: 'test-model' })).response.status, 404);
});

test('Vim defaults on and editor preferences persist without starting a runtime', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/editor/settings')).body, { vimEnabled: true });
  assert.equal((await f.request('/api/editor/settings', { vimEnabled: false }, {}, false)).response.status, 401);
  assert.equal((await f.request('/api/editor/settings', { vimEnabled: false })).response.status, 200);
  assert.equal((await f.request('/api/editor/settings', { vimEnabled: 'yes' })).response.status, 400);
  assert.deepEqual((await f.request('/api/editor/settings')).body, { vimEnabled: false });
  assert.equal(f.runtimes.length, 0);
  const dataDir = f.application.store.dataDir;
  await f.application.close();
  const reopened = createApplication({ workspace: f.workspace, dataDir, port: 0 });
  try { assert.deepEqual(reopened.store.get('editorSettings'), { vimEnabled: false }); }
  finally { await reopened.close(); }
});

test('layout settings require project authentication and reject invalid changes without losing saved sizes', async t => {
  const f = await fixture(t);
  const defaults = { sidebarWidth: 240, chatRatio: 0.85 / 2.35 };
  assert.deepEqual((await f.request('/api/layout/settings')).body, defaults);
  assert.equal((await f.request('/api/layout/settings', undefined, {}, false)).response.status, 401);
  assert.equal((await f.request('/api/layout/settings', { sidebarWidth: 300, chatRatio: 0.5 }, {}, false)).response.status, 401);
  assert.equal((await f.request('/api/layout/settings', undefined, { Origin: 'https://outside.example' })).response.status, 403);
  assert.equal((await f.request('/api/layout/settings', { sidebarWidth: 300, chatRatio: 0.5 }, { Origin: 'https://outside.example' })).response.status, 403);
  assert.deepEqual((await f.request('/api/layout/settings')).body, defaults);
  for (const settings of [{ sidebarWidth: 180, chatRatio: 0.1 }, { sidebarWidth: 420, chatRatio: 0.9 }, { sidebarWidth: 305.5, chatRatio: 0.47 }]) {
    const saved = await f.request('/api/layout/settings', settings);
    assert.equal(saved.response.status, 200);
    assert.deepEqual(saved.body, settings);
  }
  const expected = { sidebarWidth: 305.5, chatRatio: 0.47 };
  for (const invalid of [null, {}, [], { sidebarWidth: 240 }, { chatRatio: 0.5 },
    { sidebarWidth: '240', chatRatio: 0.5 }, { sidebarWidth: 240, chatRatio: '0.5' },
    { sidebarWidth: 179.99, chatRatio: 0.5 }, { sidebarWidth: 420.01, chatRatio: 0.5 },
    { sidebarWidth: 240, chatRatio: 0.099 }, { sidebarWidth: 240, chatRatio: 0.901 },
    { ...expected, extra: true }]) {
    assert.equal((await f.request('/api/layout/settings', invalid)).response.status, 400);
    assert.deepEqual((await f.request('/api/layout/settings')).body, expected);
  }
  const cookie = f.bootstrap.response.headers.get('set-cookie')!.split(';')[0];
  for (const body of ['{"sidebarWidth":1e309,"chatRatio":0.5}', '{"sidebarWidth":240,"chatRatio":-1e309}']) {
    const response = await fetch(`${f.base}/api/layout/settings`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body });
    assert.equal(response.status, 400);
    assert.deepEqual((await f.request('/api/layout/settings')).body, expected);
  }
  assert.deepEqual(f.application.store.get('layoutSettings'), expected);
  assert.equal(f.runtimes.length, 0);
});

test('layout settings persist per workspace when the local service restarts on a different port', async t => {
  const f = await fixture(t);
  const other = await fixture(t);
  const settings = { sidebarWidth: 320, chatRatio: 0.44 };
  assert.equal((await f.request('/api/layout/settings', settings)).response.status, 200);
  assert.deepEqual((await other.request('/api/layout/settings')).body, { sidebarWidth: 240, chatRatio: 0.85 / 2.35 });
  const dataDir = f.application.store.dataDir;
  const previousPort = Number(new URL(f.base).port);
  await f.application.close();
  // Reserve the previous address so the restart must use a different port.
  const reserved = createServer();
  await new Promise<void>(resolve => reserved.listen(previousPort, '127.0.0.1', resolve));
  const reopened = createApplication({ workspace: f.workspace, dataDir, port: 0 });
  try {
    await new Promise<void>(resolve => reopened.server.listen(0, '127.0.0.1', resolve));
    const address = reopened.server.address(); assert.ok(address && typeof address !== 'string');
    assert.notEqual(address.port, previousPort);
    const base = `http://127.0.0.1:${address.port}`;
    const bootstrap = await fetch(`${base}/api/state`);
    const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
    const restored = await fetch(`${base}/api/layout/settings`, { headers: { cookie } });
    assert.equal(restored.status, 200);
    assert.deepEqual(await restored.json(), settings);
    assert.deepEqual(reopened.store.get('layoutSettings'), settings);
    assert.deepEqual((await other.request('/api/layout/settings')).body, { sidebarWidth: 240, chatRatio: 0.85 / 2.35 });
  } finally {
    await reopened.close();
    await new Promise<void>(resolve => reserved.close(() => resolve()));
  }
});

test('session settings and workspace defaults survive restart without being merged into one another', async t => {
  const f = await fixture(t, settingsCatalog);
  await f.request('/api/runtime/connect', {});
  const sessionSettings = { model: 'test-model', reasoningEffort: 'high', serviceTier: 'fast', approvalPolicy: 'untrusted' as const,
    sandboxMode: 'read-only' as const, additionalInstructions: 'Keep all diagrams compact.', configOverrides: { personality: 'pragmatic' } };
  assert.equal((await f.request(`/api/sessions/${f.sessionId}/settings`, sessionSettings)).response.status, 200);
  const defaults = { model: 'small-model', reasoningEffort: 'low', verbosity: 'high' as const };
  assert.equal((await f.request('/api/settings', defaults)).response.status, 200);
  await f.message('persist-settings');
  f.runtimes.at(-1)!.complete();
  const threadId = f.runtimes.at(-1)!.threadId;
  const dataDir = f.application.store.dataDir;
  await f.application.close();
  const reopened = createApplication({ workspace: f.workspace, dataDir, port: 0 });
  try {
    assert.deepEqual(reopened.state().runtime.settings, { ...defaultAgentSettings(), ...defaults });
    assert.deepEqual(reopened.state().sessions[0].settings, { ...defaultAgentSettings(), ...sessionSettings });
    assert.equal(reopened.state().sessions[0].threadId, threadId);
    assert.equal(reopened.state().runtime.model, 'small-model');
  } finally { await reopened.close(); }
});

test('legacy saved model migrates to session settings once and remains separate from later defaults', async t => {
  const f = await fixture(t);
  const dataDir = f.application.store.dataDir;
  await f.application.close();
  const store = new Store(dataDir);
  const sessions = store.get<any[]>('sessions')!;
  delete sessions[0].settings;
  store.set('sessions', sessions);
  store.set('model', 'test-model');
  store.set('settings', null);
  store.close();
  const migrated = createApplication({ workspace: f.workspace, dataDir, port: 0 });
  assert.deepEqual(migrated.state().sessions[0].settings, { ...defaultAgentSettings(), model: 'test-model' });
  assert.deepEqual(migrated.store.get<any[]>('sessions')![0].settings, migrated.state().sessions[0].settings,
    'Migration must be durable before workspace defaults can change or the application exits unexpectedly.');
  await migrated.close();
  const changedDefaults = new Store(dataDir);
  changedDefaults.set('settings', { ...defaultAgentSettings(), model: 'small-model', reasoningEffort: 'low' });
  changedDefaults.set('model', 'small-model');
  changedDefaults.close();
  const reopened = createApplication({ workspace: f.workspace, dataDir, port: 0 });
  try {
    assert.equal(reopened.state().runtime.settings.model, 'small-model');
    assert.deepEqual(reopened.state().sessions[0].settings, { ...defaultAgentSettings(), model: 'test-model' });
  } finally { await reopened.close(); }
});
