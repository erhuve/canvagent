import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createApplication } from '../src/server/app.ts';
import { createWorkspaceHost } from '../src/server/workspaces.ts';
import type { RuntimeOptions } from '../src/server/runtime.ts';
import type { AppNotification } from '../src/shared/notifications.ts';

class FakeRuntime {
  threadId: string | null = null;
  activeTurnId: string | null = null;
  startError?: Error;
  disconnectOnStartError = false;
  interruptStatus = 'interrupted';
  resumeTurn?: string;
  constructor(readonly options: RuntimeOptions) {}
  async connect() { return { authenticated: true, version: 'test', models: [] }; }
  async open(threadId?: string) {
    this.threadId = threadId ?? randomUUID();
    if (this.resumeTurn) { this.activeTurnId = this.resumeTurn; this.resumeTurn = undefined; }
    return this.threadId;
  }
  async start() {
    if (this.startError) {
      if (this.disconnectOnStartError) this.disconnect(this.startError.message);
      throw this.startError;
    }
    this.activeTurnId = randomUUID();
    this.event('turn/started', { turn: { id: this.activeTurnId } });
    return this.activeTurnId;
  }
  event(type: string, payload: any) { this.options.onEvent({ type, payload: { threadId: this.threadId, ...payload } }); }
  complete(status = 'completed', error?: string) {
    const id = this.activeTurnId; this.activeTurnId = null;
    const turn = { id, status, ...(error ? { error: { message: error } } : {}) };
    this.event('turn/completed', { turn });
    return turn;
  }
  approval(id: number, input = false) {
    this.options.onApproval({ id, method: input ? 'item/tool/requestUserInput' : 'item/commandExecution/requestApproval',
      params: { threadId: this.threadId, turnId: this.activeTurnId, reason: input ? 'Choose a color.' : 'Run tests.' } });
  }
  disconnect(reason: string) { this.event('connection.changed', { state: 'disconnected', reason, activeTurnId: this.activeTurnId }); }
  answer() {}
  async interrupt() { this.complete(this.interruptStatus); }
  close() {}
}

async function listen(server: Server) {
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

async function request(base: string, path: string, body?: any, cookie = '', headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { response, body: await response.json() as any, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

async function fixture(t: TestContext, customize: (runtime: FakeRuntime) => void = () => {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'canvagent-notifications-')));
  const workspace = join(directory, 'workspace'); mkdirSync(workspace);
  const runtimes: FakeRuntime[] = [];
  const options = { workspace, dataDir: join(directory, 'data'), port: 0,
    runtimeFactory: (configuration: RuntimeOptions) => {
      const runtime = new FakeRuntime(configuration); customize(runtime); runtimes.push(runtime); return runtime as any;
    } };
  let application = createApplication(options);
  let base = await listen(application.server);
  let bootstrap = await request(base, '/api/state');
  let cookie = bootstrap.cookie;
  const sessionId = bootstrap.body.activeSessionId as string;
  t.after(async () => { await application.close(); rmSync(directory, { recursive: true, force: true }); });
  return {
    runtimes, sessionId,
    get application() { return application; }, get base() { return base; }, get cookie() { return cookie; },
    request: (path: string, body?: any, authenticated = true, headers: Record<string, string> = {}) => request(base, path, body, authenticated ? cookie : '', headers),
    message: (id = randomUUID()) => request(base, `/api/sessions/${sessionId}/messages`, { requestId: id, text: 'Build the canvas' }, cookie),
    async restart() {
      await application.close(); application = createApplication(options); base = await listen(application.server);
      bootstrap = await request(base, '/api/state'); cookie = bootstrap.cookie;
    },
  };
}

test('notifications come from completed turns and requests, with duplicate and stale events ignored', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.request('/api/notifications')).body, { notifications: [] });
  await f.request('/api/runtime/connect', {});
  assert.deepEqual(f.application.notifications(), []);
  await f.message();
  const runtime = f.runtimes[0];
  runtime.approval(1); runtime.approval(1); runtime.approval(2, true);
  let notifications = f.application.notifications();
  assert.deepEqual(notifications.map(notification => notification.title), ['Agent needs your input', 'Permission requested']);
  assert.equal(f.application.state().sessions[0].pendingApprovals.length, 2);
  runtime.event('item/completed', { turnId: runtime.activeTurnId, item: { id: 'answer', type: 'agentMessage', text: 'The canvas is ready.' } });
  const completed = runtime.complete();
  runtime.event('turn/completed', { turn: completed });
  notifications = f.application.notifications();
  assert.equal(notifications.length, 3);
  assert.equal(notifications[0].kind, 'completed');
  assert.equal(notifications[0].body, 'The canvas is ready.');
  assert.equal(notifications[0].projectId, '');
  assert.equal(notifications[0].projectName, 'workspace');
  assert.equal(notifications[0].sessionId, f.sessionId);
  assert.equal(notifications[0].sessionTitle, 'Build the canvas');
  assert.ok(!Number.isNaN(Date.parse(notifications[0].createdAt)));
  await f.message();
  runtime.event('turn/started', { turn: { id: completed.id } });
  runtime.event('turn/completed', { turn: completed });
  assert.equal(f.application.state().sessions[0].status, 'running');
  assert.equal(f.application.notifications().length, 3);
  runtime.complete('failed', 'The compiler stopped.');
  assert.equal(f.application.notifications()[0].kind, 'failed');
  assert.equal(f.application.notifications()[0].body, 'The compiler stopped.');
  runtime.disconnect('Process exited');
  assert.equal(f.application.notifications().length, 4);
});

test('user interruption produces no completion notification, including a racing success response', async t => {
  const f = await fixture(t);
  await f.message();
  assert.equal((await f.request(`/api/sessions/${f.sessionId}/interrupt`, {})).response.status, 200);
  assert.deepEqual(f.application.notifications(), []);
  await f.message();
  f.runtimes[0].interruptStatus = 'completed';
  assert.equal((await f.request(`/api/sessions/${f.sessionId}/interrupt`, {})).response.status, 200);
  assert.deepEqual(f.application.notifications(), []);
  await f.message(); f.runtimes[0].complete();
  assert.equal(f.application.notifications().length, 1);
});

test('resumed active turns and the message queued behind them each notify when completed', async t => {
  const f = await fixture(t, runtime => { runtime.resumeTurn = 'existing-turn'; });
  await f.message();
  const runtime = f.runtimes[0];
  assert.equal(runtime.activeTurnId, 'existing-turn');
  runtime.complete();
  const deadline = Date.now() + 2000;
  while (!runtime.activeTurnId) { assert.ok(Date.now() < deadline, 'Queued turn did not start.'); await delay(5); }
  runtime.complete();
  assert.equal(f.application.notifications().length, 2);
  assert.notEqual(f.application.notifications()[0].id, f.application.notifications()[1].id);
});

test('dispatch failures and busy disconnections each produce one persistent alert', async t => {
  const f = await fixture(t, runtime => { runtime.startError = new Error('Runtime pipe closed'); runtime.disconnectOnStartError = true; });
  await f.message();
  assert.equal(f.application.notifications().length, 1, 'The disconnection and rejected start describe one failure.');
  assert.equal(f.application.notifications()[0].kind, 'failed');
  assert.equal(f.application.notifications()[0].body, 'Runtime pipe closed');
  f.runtimes[0].disconnect('Duplicate disconnect');
  const original = f.application.notifications()[0];
  await f.restart();
  assert.deepEqual(f.application.notifications(), [original]);

  const fresh = await fixture(t);
  await fresh.message();
  fresh.runtimes[0].disconnect('The agent process exited');
  fresh.runtimes[0].disconnect('Repeated close');
  assert.equal(fresh.application.notifications().length, 1);
  assert.equal(fresh.application.notifications()[0].body, 'The agent process exited');
});

test('inbox keeps the newest 100 entries and read state is idempotent and survives restart', async t => {
  const f = await fixture(t);
  const generated: AppNotification[] = [];
  for (let index = 0; index < 103; index++) {
    await f.message(); f.runtimes[0].complete();
    generated.push(f.application.notifications()[0]);
  }
  const listed = (await f.request('/api/notifications')).body.notifications as AppNotification[];
  assert.equal(listed.length, 100);
  assert.deepEqual(listed.map(notification => notification.id), generated.slice(-100).reverse().map(notification => notification.id));
  const selected = [listed[0].id, listed[2].id];
  const marked = (await f.request('/api/notifications/read', { ids: selected })).body.notifications as AppNotification[];
  assert.ok(marked[0].readAt && marked[2].readAt);
  assert.equal(marked[1].readAt, undefined);
  const repeated = (await f.request('/api/notifications/read', { ids: [...selected, 'missing'] })).body.notifications;
  assert.deepEqual(repeated, marked);
  const external = f.application.notifications(); external[0].title = 'Changed outside';
  assert.equal(f.application.notifications()[0].title, 'Agent finished');
  await f.restart();
  assert.deepEqual(f.application.notifications(), marked);
});

test('standalone notification endpoints bootstrap cookies and protect writes and settings', async t => {
  const f = await fixture(t);
  const bootstrap = await f.request('/api/notifications', undefined, false);
  assert.equal(bootstrap.response.status, 200);
  assert.match(bootstrap.response.headers.get('set-cookie')!, /HttpOnly/);
  assert.match(bootstrap.response.headers.get('set-cookie')!, /SameSite=Strict/);
  assert.equal((await f.request('/api/notifications/read', { ids: [] }, false)).response.status, 401);
  assert.equal((await f.request('/api/notifications/read', { ids: [1] })).response.status, 400);
  assert.equal((await f.request('/api/notifications/read', { ids: [], all: true })).response.status, 400);
  assert.equal((await f.request('/api/notifications', undefined, false, { origin: 'https://example.com' })).response.status, 403);
  assert.deepEqual((await f.request('/api/notification-settings')).body, { systemEnabled: false });
  assert.equal((await f.request('/api/notification-settings', { systemEnabled: true }, false)).response.status, 401);
  assert.equal((await f.request('/api/notification-settings', { systemEnabled: 'true' })).response.status, 400);
  assert.equal((await f.request('/api/notification-settings', { systemEnabled: true, extra: 1 })).response.status, 400);
  assert.deepEqual((await f.request('/api/notification-settings', { systemEnabled: true })).body, { systemEnabled: true });
  await f.restart();
  assert.deepEqual((await f.request('/api/notification-settings')).body, { systemEnabled: true });
});

test('host aggregates background projects, marks selected entries read, and persists global opt-in', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'canvagent-notification-host-')));
  const firstWorkspace = join(directory, 'first'); mkdirSync(firstWorkspace);
  const secondWorkspace = join(directory, 'second'); mkdirSync(secondWorkspace);
  const runtimes: FakeRuntime[] = [];
  const options = { workspace: firstWorkspace, dataRoot: join(directory, 'data'), port: 0,
    runtimeFactory: (configuration: RuntimeOptions) => { const runtime = new FakeRuntime(configuration); runtimes.push(runtime); return runtime as any; } };
  let host = createWorkspaceHost(options);
  let base = await listen(host.server);
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  const bootstrap = await request(base, '/api/notifications');
  const hostCookie = bootstrap.cookie;
  assert.deepEqual(bootstrap.body, { notifications: [] });
  assert.match(bootstrap.response.headers.get('set-cookie')!, /Path=\//);
  assert.equal((await request(base, '/api/notifications/read', { ids: [] })).response.status, 401);
  assert.equal((await request(base, '/api/notifications/read', { ids: [] }, hostCookie, { origin: 'https://example.com' })).response.status, 403);
  assert.equal((await request(base, '/api/notifications/read', { ids: [1] }, hostCookie)).response.status, 400);
  const hostileHost = await new Promise<number | undefined>((done, reject) => {
    const raw = httpRequest(`${base}/api/notifications`, { headers: { host: 'example.com' } }, response => { response.resume(); done(response.statusCode); });
    raw.on('error', reject); raw.end();
  });
  assert.equal(hostileHost, 403);
  const firstPath = host.projectPath(host.initialProjectId);
  const first = await request(base, `${firstPath}api/state`);
  const added = await request(base, '/api/projects', { workspace: secondWorkspace }, hostCookie);
  const secondPath = host.projectPath(added.body.project.id);
  const second = await request(base, `${secondPath}api/state`);
  await request(base, `${firstPath}api/sessions/${first.body.activeSessionId}/messages`, { requestId: 'first', text: 'First project task' }, first.cookie);
  await request(base, `${secondPath}api/sessions/${second.body.activeSessionId}/messages`, { requestId: 'second', text: 'Second project task' }, second.cookie);
  runtimes[0].complete(); runtimes[1].approval(1);
  const all = (await request(base, '/api/notifications')).body.notifications as AppNotification[];
  assert.equal(all.length, 2);
  assert.deepEqual(new Set(all.map(notification => notification.projectName)), new Set(['first', 'second']));
  assert.deepEqual(new Set(all.map(notification => notification.projectId)), new Set([host.initialProjectId, added.body.project.id]));
  assert.equal((await request(base, '/api/notifications/read', { ids: [] }, first.cookie)).response.status, 401);
  assert.equal((await request(base, `${firstPath}api/notifications/read`, { ids: [] }, hostCookie)).response.status, 401);
  const firstNotification = all.find(notification => notification.projectName === 'first')!;
  const read = (await request(base, '/api/notifications/read', { ids: [firstNotification.id] }, hostCookie)).body.notifications as AppNotification[];
  assert.ok(read.find(notification => notification.id === firstNotification.id)!.readAt);
  assert.equal(read.find(notification => notification.projectName === 'second')!.readAt, undefined);
  assert.ok(host.applications.get(host.initialProjectId)!.notifications()[0].readAt);
  assert.deepEqual((await request(base, '/api/notification-settings')).body, { systemEnabled: false });
  assert.equal((await request(base, '/api/notification-settings', { systemEnabled: true }, first.cookie)).response.status, 401);
  assert.equal((await request(base, '/api/notification-settings', { systemEnabled: true, extra: 1 }, hostCookie)).response.status, 400);
  assert.deepEqual((await request(base, '/api/notification-settings', { systemEnabled: true }, hostCookie)).body, { systemEnabled: true });
  await host.close(); host = createWorkspaceHost(options); base = await listen(host.server);
  assert.deepEqual((await request(base, '/api/notification-settings')).body, { systemEnabled: true });
  assert.deepEqual((await request(base, '/api/notifications')).body.notifications, read);
});
