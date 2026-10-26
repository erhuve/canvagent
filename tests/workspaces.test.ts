import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createWorkspaceHost } from '../src/server/workspaces.ts';
import type { RuntimeOptions } from '../src/server/runtime.ts';

class FakeRuntime {
  closed = false;
  threadId: string | null = null;
  activeTurnId: string | null = null;
  constructor(readonly options: RuntimeOptions) {}
  async connect() { return { authenticated: true, version: 'test-runtime', models: [] }; }
  async open(threadId?: string) { this.threadId = threadId ?? randomUUID(); return this.threadId; }
  async start() {
    this.activeTurnId = randomUUID();
    this.options.onEvent({ type: 'turn/started', payload: { threadId: this.threadId, turn: { id: this.activeTurnId } } });
    return this.activeTurnId;
  }
  complete() {
    const id = this.activeTurnId; this.activeTurnId = null;
    this.options.onEvent({ type: 'turn/completed', payload: { threadId: this.threadId, turn: { id, status: 'completed' } } });
  }
  close() { this.closed = true; }
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'Expected runtime state was not reached.'); await delay(5); }
}

async function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'canvagent-workspaces-')));
  const workspace = join(directory, 'first'); mkdirSync(workspace);
  const otherWorkspace = join(directory, 'second'); mkdirSync(otherWorkspace);
  const distDir = join(directory, 'dist'); mkdirSync(join(distDir, 'assets'), { recursive: true });
  writeFileSync(join(distDir, 'index.html'), '<html><link rel="icon" href="/brand/app-icon.svg"><img src="/brand/mark.svg"><script src="/assets/app.js"></script></html>');
  writeFileSync(join(distDir, 'assets', 'app.js'), 'window.test = true;');
  const brandAssets = {
    'mark.svg': '<svg xmlns="http://www.w3.org/2000/svg"><title>Canvagent mark</title></svg>',
    'app-icon.svg': '<svg xmlns="http://www.w3.org/2000/svg"><title>Canvagent app icon</title></svg>',
  };
  mkdirSync(join(distDir, 'brand'));
  for (const [name, source] of Object.entries(brandAssets)) writeFileSync(join(distDir, 'brand', name), source);
  const dataRoot = join(directory, 'data');
  const dataDir = join(directory, 'existing-data');
  const runtimes: FakeRuntime[] = [];
  const options = { workspace, dataRoot, dataDir, distDir, port: 0,
    runtimeFactory: (configuration: RuntimeOptions) => { const runtime = new FakeRuntime(configuration); runtimes.push(runtime); return runtime as any; } };
  let host = createWorkspaceHost(options);
  let base = '';
  let cookie = '';
  async function listen() {
    await new Promise<void>(done => host.server.listen(0, '127.0.0.1', done));
    const address = host.server.address(); assert.ok(address && typeof address === 'object');
    base = `http://127.0.0.1:${address.port}`;
    const bootstrap = await fetch(`${base}/api/projects`);
    cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  }
  async function request(path: string, body?: any, requestCookie = cookie, headers: Record<string, string> = {}) {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
      ...(requestCookie ? { cookie: requestCookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { response, body: await response.json() as any };
  }
  async function open(id: string) {
    const result = await request(`${host.projectPath(id)}api/state`);
    assert.equal(result.response.status, 200);
    return { ...result, cookie: result.response.headers.get('set-cookie')!.split(';')[0], path: host.projectPath(id), id };
  }
  async function add() {
    const result = await request('/api/projects', { workspace: otherWorkspace });
    assert.equal(result.response.status, 201);
    return open(result.body.project.id);
  }
  await listen();
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  return { directory, workspace, otherWorkspace, dataRoot, dataDir, brandAssets, runtimes, request, open, add,
    get host() { return host; }, get base() { return base; },
    async restart() { await host.close(); host = createWorkspaceHost(options); await listen(); },
  };
}

test('workspace host isolates board, conversations, artifacts, and cookie scopes', async t => {
  const f = await fixture(t);
  const first = await f.open(f.host.initialProjectId);
  assert.match(first.response.headers.get('set-cookie')!, new RegExp(`Path=${first.path}`));
  assert.equal(f.host.applications.get(first.id)!.store.dataDir, f.dataDir);
  const second = await f.add();
  assert.notEqual(first.body.board.id, second.body.board.id);
  assert.equal((await f.request(`${second.path}api/sessions`, { title: 'Wrong project' }, first.cookie)).response.status, 401);
  assert.equal((await f.request(`${second.path}api/sessions/${first.body.activeSessionId}/activate`, {}, second.cookie)).response.status, 404);
  const created = await f.request(`${first.path}api/board/mutate`, { requestId: 'draw', observedBoardRevision: 0,
    operations: [{ kind: 'create', elementId: 'first-only', element: { id: 'first-only', type: 'rectangle', x: 0, y: 0, width: 120, height: 80, link: '/api/artifacts/legacy-output' } }] }, first.cookie);
  assert.equal(created.body.ok, true);
  const firstBoard = (await f.open(first.id)).body.board;
  assert.equal(firstBoard.elements[0].link, `${first.path}api/artifacts/legacy-output`);
  assert.deepEqual(firstBoard.metadata, f.host.applications.get(first.id)!.store.board().metadata);
  assert.equal(f.host.applications.get(first.id)!.store.board().elements[0].link, '/api/artifacts/legacy-output');
  assert.equal((await f.open(second.id)).body.board.revision, 0);
  const session = await f.request(`${first.path}api/sessions`, { title: 'First project work' }, first.cookie);
  assert.equal(session.body.title, 'First project work');
  assert.equal((await f.open(second.id)).body.sessions.length, 1);
  const file = 'output.txt'; writeFileSync(join(f.workspace, file), 'project-specific output');
  const firstApp = f.host.applications.get(first.id)!;
  const published = await firstApp.tools.call('publish_artifact', { requestId: 'publish', sourcePath: file, title: 'Output' });
  const artifact = JSON.parse(published.contentItems[0].text);
  const attached = await firstApp.tools.call('attach_artifact', { requestId: 'attach', artifactId: artifact.id, x: 200, y: 100 });
  assert.equal(attached.success, true);
  assert.equal(firstApp.store.board().elements.at(-1)!.link, `${first.path}api/artifacts/${artifact.id}`);
  assert.equal((await f.request(`${second.path}api/artifacts/${artifact.id}`, undefined, second.cookie)).response.status, 404);
  assert.equal((await f.request('/api/state')).response.status, 404);
  const summary = await f.request('/api/projects');
  assert.equal(summary.body.projects.length, 2);
  assert.ok(summary.body.projects.find((project: any) => project.id === first.id).sessions.some((entry: any) => entry.title === 'First project work'));
  assert.ok(summary.body.projects.every((project: any) => !('board' in project) && project.sessions.every((entry: any) => !('messages' in entry))));
  const index = await fetch(`${f.base}${second.path}`);
  const html = await index.text(); assert.match(html, /\/assets\/app.js/);
  assert.equal((await fetch(`${f.base}/assets/app.js`)).status, 200);
  for (const [name, source] of Object.entries(f.brandAssets)) {
    const path = `/brand/${name}`;
    assert.ok(html.includes(`"${path}"`));
    const asset = await fetch(new URL(path, index.url), { headers: { referer: index.url } });
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get('content-type')!, /^image\/svg\+xml(?:;|$)/);
    assert.equal(await asset.text(), source);
  }
  const redirect = await fetch(f.base, { redirect: 'manual' });
  assert.equal(redirect.headers.get('location'), first.path);
});

test('project registry restores data and keeps unavailable folders registered', async t => {
  const f = await fixture(t);
  const second = await f.add();
  await f.request(`${second.path}api/sessions`, { title: 'Saved second project' }, second.cookie);
  const link = join(f.directory, 'linked-second'); symlinkSync(f.otherWorkspace, link);
  const duplicate = await f.request('/api/projects', { workspace: link });
  assert.equal(duplicate.response.status, 200); assert.equal(duplicate.body.project.id, second.id);
  await f.restart();
  assert.equal((await f.open(second.id)).body.sessions.at(-1).title, 'Saved second project');
  await f.host.close(); rmSync(f.otherWorkspace, { recursive: true });
  await f.restart();
  const unavailable = (await f.request('/api/projects')).body.projects.find((project: any) => project.id === second.id);
  assert.equal(unavailable.available, false);
  assert.equal((await f.request(`${second.path}api/state`)).response.status, 410);
  assert.ok(JSON.parse(readFileSync(join(f.dataRoot, 'projects.json'), 'utf8')).projects.some((project: any) => project.id === second.id));
  mkdirSync(f.otherWorkspace);
  const restored = await f.request('/api/projects', { workspace: f.otherWorkspace });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.project.available, true);
  assert.equal((await f.open(second.id)).body.sessions.at(-1).title, 'Saved second project');
});

test('project registration requires local origin, host authorization, and a real directory', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/api/projects', { workspace: f.otherWorkspace }, '')).response.status, 401);
  assert.equal((await f.request('/api/projects', { workspace: f.otherWorkspace }, undefined, { origin: 'https://example.com' })).response.status, 403);
  const hostileHostStatus = await new Promise<number | undefined>((done, reject) => {
    const request = httpRequest(`${f.base}/api/projects`, { headers: { host: 'example.com' } }, response => { response.resume(); done(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await f.request('/api/projects', { workspace: join(f.directory, 'missing') })).response.status, 400);
  const file = join(f.directory, 'file.txt'); writeFileSync(file, 'text');
  assert.equal((await f.request('/api/projects', { workspace: file })).response.status, 400);
  const first = await f.open(f.host.initialProjectId);
  assert.equal((await f.request('/api/projects', { workspace: f.otherWorkspace }, first.cookie)).response.status, 401);
  assert.equal((await f.request(`${first.path}api/state`, undefined, '', { origin: 'http://localhost:1' })).response.status, 403);
});

test('project WebSockets and canvas MCP stay isolated while other runtimes continue', async t => {
  const f = await fixture(t);
  const first = await f.open(f.host.initialProjectId);
  const second = await f.add();
  function socket(project: typeof first) {
    const ws = new WebSocket(`${f.base.replace('http:', 'ws:')}${project.path}api/events`, { headers: { cookie: project.cookie, origin: f.base } });
    t.after(() => ws.terminate());
    return ws;
  }
  const firstSocket = socket(first);
  const [firstMessage] = await once(firstSocket, 'message');
  assert.equal(JSON.parse(firstMessage.toString()).state.project.workspace, f.workspace);
  const firstMessageResult = await f.request(`${first.path}api/sessions/${first.body.activeSessionId}/messages`, { requestId: 'first-work', text: 'Work in the first workspace' }, first.cookie);
  assert.equal(firstMessageResult.response.status, 202);
  await waitFor(() => !!f.runtimes[0]?.activeTurnId);
  const firstRuntime = f.runtimes[0];
  firstSocket.close();
  const secondSocket = socket(second);
  const [secondMessage] = await once(secondSocket, 'message');
  assert.equal(JSON.parse(secondMessage.toString()).state.project.workspace, f.otherWorkspace);
  const secondEvents: any[] = []; secondSocket.on('message', message => secondEvents.push(JSON.parse(message.toString())));
  await f.open(second.id);
  const secondMessageResult = await f.request(`${second.path}api/sessions/${second.body.activeSessionId}/messages`, { requestId: 'second-work', text: 'Work in the second workspace' }, second.cookie);
  assert.equal(secondMessageResult.response.status, 202);
  await waitFor(() => !!f.runtimes[1]?.activeTurnId);
  assert.equal(firstRuntime.closed, false); assert.ok(firstRuntime.activeTurnId);
  assert.equal(f.runtimes.length, 2);
  assert.equal(firstRuntime.options.canvasMcp!.url(), `${f.base}${first.path}mcp/${first.body.activeSessionId}`);
  const client = new Client({ name: 'workspace-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(firstRuntime.options.canvasMcp!.url()), { requestInit: { headers: { Authorization: `Bearer ${firstRuntime.options.canvasMcp!.token}` } } }));
  t.after(() => client.close());
  const mutation = await client.callTool({ name: 'apply_canvas_ops', arguments: { requestId: 'runtime-draw', observedBoardRevision: 0,
    operations: [{ kind: 'create', elementId: 'background-work', shape: 'rectangle', x: 0, y: 0 }] } });
  assert.equal(mutation.isError, false);
  assert.equal(f.host.applications.get(first.id)!.store.board().revision, 1);
  await delay(30);
  assert.ok(secondEvents.every(event => event.type !== 'board'));
  firstRuntime.complete();
  assert.equal((await f.open(first.id)).body.sessions[0].status, 'idle');
  assert.equal(f.runtimes[1].closed, false); assert.ok(f.runtimes[1].activeTurnId);
  const rejected = new WebSocket(`${f.base.replace('http:', 'ws:')}${second.path}api/events`, { headers: { cookie: first.cookie, origin: f.base } });
  rejected.on('error', () => {});
  const [, response] = await once(rejected, 'unexpected-response');
  assert.equal(response.statusCode, 403); rejected.terminate();
});
