import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createApplication } from '../src/server/app.ts';
import type { RuntimeOptions } from '../src/server/runtime.ts';
import type { RuntimeImage } from '../src/shared/context.ts';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
type FakeCapabilities = { images: boolean; steering: boolean; connectDelay?: number };
class FakeRuntime {
  threadId: string | null = null;
  activeTurnId: string | null = null;
  starts: { text: string; images: RuntimeImage[] }[] = [];
  steers: { text: string; images: RuntimeImage[] }[] = [];
  constructor(readonly options: RuntimeOptions, private caps: FakeCapabilities) {}
  async connect() { if (this.caps.connectDelay) await delay(this.caps.connectDelay); return { authenticated: true, models: [], version: 'context-test', capabilities: { imageInput: this.caps.images, steering: this.caps.steering, canvasChangeNotices: false, canvasTools: true } }; }
  async open(id?: string) { this.threadId = id ?? randomUUID(); return this.threadId; }
  async start(text: string, _id?: string, images: RuntimeImage[] = []) { this.starts.push({ text, images }); this.activeTurnId = randomUUID(); this.options.onEvent({ type: 'turn/started', payload: { turn: { id: this.activeTurnId } } }); return this.activeTurnId; }
  async steer(text: string, _id: string, images: RuntimeImage[] = []) { this.steers.push({ text, images }); }
  async interrupt() { this.complete('interrupted'); }
  answer() {}
  close() {}
  complete(status = 'completed') { const id = this.activeTurnId; this.activeTurnId = null; this.options.onEvent({ type: 'turn/completed', payload: { turn: { id, status } } }); }
}
async function fixture(t: TestContext, caps: FakeCapabilities = { images: true, steering: true }) {
  const directory = mkdtempSync(join(tmpdir(), 'canvagent-context-http-'));
  const workspace = join(directory, 'project'); mkdirSync(workspace);
  writeFileSync(join(workspace, 'example.txt'), 'first line\nsecond line\n');
  const runtimes: FakeRuntime[] = [];
  const app = createApplication({ workspace, dataDir: join(directory, 'data'), runtimeFactory: options => { const runtime = new FakeRuntime(options, caps); runtimes.push(runtime); return runtime; } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const bootstrap = await fetch(`${base}/api/state`); const cookie = bootstrap.headers.getSetCookie()[0].split(';')[0];
  const initial = await bootstrap.json(); const id = initial.activeSessionId;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { cookie, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const message = (text: string, attachments: string[] = [], requestId: string = randomUUID()) => request(`/api/sessions/${id}/messages`, { text, attachments, requestId });
  const waitFor = async (predicate: () => boolean) => { const deadline = Date.now() + 4000; while (!predicate()) { if (Date.now() > deadline) assert.fail('Expected application state did not arrive.'); await delay(10); } };
  return { app, workspace, request, message, id, runtimes, waitFor, base };
}

test('mentions dispatch frozen file snapshots and message receipts include attachment identity', async t => {
  const f = await fixture(t);
  const attachment = (await f.request('/api/context/attachments', { reference: { kind: 'file', path: 'example.txt', startLine: 2, endLine: 2 } })).body;
  writeFileSync(join(f.workspace, 'example.txt'), 'changed after attaching\n');
  const sent = await f.message('Explain the selected line', [attachment.id], 'same-receipt');
  assert.equal(sent.status, 202); assert.match(f.runtimes[0].starts[0].text, /second line/);
  assert.ok(!f.runtimes[0].starts[0].text.includes('changed after attaching'));
  assert.equal((await f.message('Explain the selected line', [attachment.id], 'same-receipt')).status, 200);
  assert.equal((await f.message('Explain the selected line', [], 'same-receipt')).status, 409);
  assert.equal(f.runtimes[0].starts.length, 1);
  assert.equal(f.app.state().sessions[0].messages[0].attachments?.[0].id, attachment.id);
  const suggestions = (await f.request('/api/context/suggestions?query=example')).body.items;
  assert.ok(suggestions.some((item: any) => item.reference.path === 'example.txt'));
});

test('image-only messages and image steering hydrate bytes only at the runtime boundary', async t => {
  const f = await fixture(t);
  const image = (await f.request('/api/context/images', { name: 'clipboard.png', dataUrl: png })).body;
  assert.equal((await f.message('', [image.id])).status, 202);
  assert.equal(f.runtimes[0].starts[0].images[0].url, png);
  await f.message('Look at this too', [image.id]);
  assert.equal(f.runtimes[0].steers[0].images[0].url, png);
  const state = (await f.request('/api/state')).body;
  assert.ok(!JSON.stringify(state).includes(png));
  const unauthenticated = await fetch(`${f.base}/api/context/images/${image.imageId}`);
  assert.equal(unauthenticated.status, 401);
});

test('simultaneous image retries accept one message while capabilities are connecting', async t => {
  const f = await fixture(t, { images: true, steering: false, connectDelay: 100 });
  const image = (await f.request('/api/context/images', { name: 'retry.png', dataUrl: png })).body;
  const responses = await Promise.all(Array.from({ length: 3 }, () => f.message('', [image.id], 'same-image-request')));
  assert.deepEqual(responses.map(result => result.status).sort(), [200, 200, 202]);
  const session = f.app.state().sessions[0];
  assert.equal(session.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(f.runtimes[0].starts.length, 1);
  assert.equal(session.status, 'running');
  assert.equal(session.queued.length, 0);
});

test('queued images survive to their own next turn and unsupported images do not accept a message', async t => {
  const f = await fixture(t, { images: true, steering: false });
  const image = (await f.request('/api/context/images', { name: 'queued.png', dataUrl: png })).body;
  await f.message('First'); await f.message('', [image.id]);
  assert.equal(f.runtimes[0].steers.length, 0);
  f.runtimes[0].complete();
  await f.waitFor(() => f.runtimes[0].starts.length === 2);
  assert.equal(f.runtimes[0].starts[1].images[0].url, png);
  const unsupported = await fixture(t, { images: false, steering: false });
  const other = (await unsupported.request('/api/context/images', { name: 'unsupported.png', dataUrl: png })).body;
  assert.equal((await unsupported.message('', [other.id])).status, 400);
  assert.equal(unsupported.app.state().sessions[0].messages.length, 0);
  assert.equal((await unsupported.message('Wrong workspace', [image.id])).status, 404);
});

test('conversation reviews retain turn diffs, reject foreign sessions and preserve newer disk edits', async t => {
  const f = await fixture(t);
  await f.message('Edit the file');
  writeFileSync(join(f.workspace, 'example.txt'), 'after the turn\n');
  f.runtimes[0].complete();
  await f.waitFor(() => !!f.app.state().sessions[0].reviews?.[0].files.length);
  const review = f.app.state().sessions[0].reviews![0];
  const path = `/api/sessions/${f.id}/reviews/${review.id}`;
  writeFileSync(join(f.workspace, 'example.txt'), 'newer human edit\n');
  const diff = await f.request(`${path}?path=example.txt`);
  assert.match(diff.body.diff, /after the turn/); assert.ok(!diff.body.diff.includes('newer human edit'));
  assert.equal((await f.request(`${path}/restore`, { path: 'example.txt', requestId: 'restore-newer' })).status, 409);
  assert.equal(readFileSync(join(f.workspace, 'example.txt'), 'utf8'), 'newer human edit\n');
  writeFileSync(join(f.workspace, 'example.txt'), 'after the turn\n');
  assert.equal((await f.request(`${path}/restore`, { path: 'example.txt', requestId: 'restore-safe' })).status, 200);
  assert.equal((await f.request(`${path}/restore`, { path: 'example.txt', requestId: 'restore-safe' })).status, 200);
  assert.match(readFileSync(join(f.workspace, 'example.txt'), 'utf8'), /first line/);
  const other = (await f.request('/api/sessions', {})).body;
  assert.equal((await f.request(`/api/sessions/${other.id}/reviews/${review.id}?path=example.txt`)).status, 404);
});
