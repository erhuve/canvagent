import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createApplication } from '../src/server/app.ts';
import type { RuntimeOptions } from '../src/server/runtime.ts';

class FakeRuntime {
  threadId: string | null = null;
  activeTurnId: string | null = null;
  starts: { text: string; requestId?: string; turnId: string }[] = [];
  steers: { text: string; turnId: string }[] = [];
  answers: { id: string | number; result: any }[] = [];
  nextSteerError: Error | undefined;
  constructor(readonly options: RuntimeOptions) {}
  async connect() {
    this.options.onEvent({ type: 'connection.changed', payload: { state: 'connected' } });
    return { authenticated: true, version: 'test-runtime', models: [{ id: 'test-model', name: 'Test model' }] };
  }
  async open(threadId?: string) { this.threadId = threadId ?? 'thread-test'; return this.threadId; }
  async start(text: string, requestId?: string) {
    this.activeTurnId = `turn-${this.starts.length + 1}`;
    this.starts.push({ text, requestId, turnId: this.activeTurnId });
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
  close() {}
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
