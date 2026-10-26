import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import { createApplication } from '../src/server/app.ts';
import type { RuntimeOptions } from '../src/server/runtime.ts';
import { TurnReviews } from '../src/server/turn-review.ts';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
class AdmissionRuntime {
  threadId: string | null = null;
  activeTurnId: string | null = null;
  starts: string[] = [];
  firstAcknowledgment?: ReturnType<typeof gate>;
  completeBeforeFirstAcknowledgment = false;
  steering = false;
  steerEntered?: ReturnType<typeof gate>;
  steerOutcome?: ReturnType<typeof gate>;
  constructor(private options: RuntimeOptions) {}
  async connect() { return { authenticated: true, version: 'admission-test', models: [], capabilities: { steering: this.steering, imageInput: true, canvasTools: true, canvasChangeNotices: false } }; }
  async open(id?: string) { this.threadId = id ?? randomUUID(); return this.threadId; }
  async start(text: string) {
    const first = this.starts.length === 0;
    const id = randomUUID();
    this.starts.push(text);
    this.activeTurnId = id;
    this.options.onEvent({ type: 'turn/started', payload: { threadId: this.threadId, turn: { id } } });
    if (first && this.completeBeforeFirstAcknowledgment) this.complete();
    if (first && this.firstAcknowledgment) await this.firstAcknowledgment.promise;
    return id;
  }
  async steer() { this.steerEntered?.release(); if (this.steerOutcome) await this.steerOutcome.promise; throw new Error('Steering unavailable'); }
  async interrupt() { this.complete('interrupted'); }
  answer() {}
  close() {}
  complete(status = 'completed') {
    const id = this.activeTurnId;
    this.activeTurnId = null;
    this.options.onEvent({ type: 'turn/completed', payload: { threadId: this.threadId, turn: { id, status } } });
  }
}
async function fixture(t: TestContext, configure?: (runtime: AdmissionRuntime) => void) {
  const directory = mkdtempSync(join(tmpdir(), 'canvagent-admission-'));
  const workspace = join(directory, 'project'); mkdirSync(workspace);
  writeFileSync(join(workspace, 'readme.txt'), 'An unchanged test file.\n');
  const releases: (() => void)[] = [];
  const runtimes: AdmissionRuntime[] = [];
  const app = createApplication({ workspace, dataDir: join(directory, 'data'), runtimeFactory: options => {
    const runtime = new AdmissionRuntime(options); configure?.(runtime); runtimes.push(runtime); return runtime;
  } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const release of releases) release(); await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const address = app.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const bootstrap = await fetch(`${base}/api/state`);
  const cookie = bootstrap.headers.getSetCookie()[0].split(';')[0];
  const id = (await bootstrap.json()).activeSessionId;
  const request = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const message = (text: string) => request(`/api/sessions/${id}/messages`, { text, requestId: randomUUID() });
  const session = () => app.state().sessions.find(session => session.id === id)!;
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 4000;
    while (!predicate()) { if (Date.now() > deadline) assert.fail('Expected message admission state did not arrive.'); await delay(5); }
  };
  // The request's body parser runs before this end listener. Its microtask
  // confirms that the incoming handler has reached its review await.
  const nextMessageRead = () => new Promise<void>(resolve => app.server.once('request', req => req.once('end', () => queueMicrotask(resolve))));
  return { app, runtimes, releases, request, message, session, waitFor, nextMessageRead, id };
}

test('an arrival during review completion stays behind the previously queued message', async t => {
  const finishing = gate(), entered = gate();
  const original = TurnReviews.prototype.finish;
  let finishes = 0;
  t.mock.method(TurnReviews.prototype, 'finish', async function (this: TurnReviews, ...args: Parameters<TurnReviews['finish']>) {
    if (finishes++ === 0) { entered.release(); await finishing.promise; }
    return original.apply(this, args);
  });
  const f = await fixture(t); f.releases.push(finishing.release);
  assert.equal((await f.message('First turn.')).status, 202);
  assert.equal((await f.message('Previously queued turn.')).status, 202);
  const runtime = f.runtimes[0];
  assert.equal(f.session().queued.length, 1);
  runtime.complete();
  await entered.promise;
  const requestRead = f.nextMessageRead();
  const arriving = f.message('New arrival while the review finishes.');
  await requestRead;
  finishing.release();
  assert.equal((await arriving).status, 202);
  await f.waitFor(() => runtime.starts.length >= 2);
  assert.ok(runtime.starts[1].startsWith('Previously queued turn.'));
  assert.equal(f.session().status, 'running');
  assert.equal(f.session().queued.length, 1);
  assert.equal(f.session().queued[0].text, 'New arrival while the review finishes.');
  runtime.complete();
  await f.waitFor(() => runtime.starts.length === 3);
  assert.ok(runtime.starts[2].startsWith('New arrival while the review finishes.'));
  assert.equal(f.session().status, 'running');
  assert.equal(f.session().queued.length, 0);
  runtime.complete();
});

test('completion before a start acknowledgment does not strand the next queued message', async t => {
  const acknowledgment = gate();
  const f = await fixture(t); f.releases.push(acknowledgment.release);
  assert.equal((await f.request('/api/runtime/connect', { sessionId: f.id })).status, 200);
  const runtime = f.runtimes[0];
  runtime.firstAcknowledgment = acknowledgment;
  runtime.completeBeforeFirstAcknowledgment = true;
  const first = f.message('Fast first turn with delayed acknowledgment.');
  await f.waitFor(() => runtime.starts.length === 1 && !!f.session().reviews?.[0]?.completedAt);
  assert.equal(f.session().status, 'idle');
  const next = f.message('Next message while the start acknowledgment is pending.');
  await f.waitFor(() => f.session().queued.length === 1);
  assert.equal((await next).status, 202);
  assert.equal(runtime.starts.length, 1);
  acknowledgment.release();
  assert.equal((await first).status, 202);
  await f.waitFor(() => runtime.starts.length === 2);
  assert.ok(runtime.starts[1].startsWith('Next message while the start acknowledgment is pending.'));
  assert.equal(f.session().status, 'running');
  assert.equal(f.session().queued.length, 0);
  runtime.complete();
});

test('a steering rejection after turn review completion dispatches the update as its next turn', async t => {
  const entered = gate(), outcome = gate();
  const f = await fixture(t, runtime => { runtime.steering = true; runtime.steerEntered = entered; runtime.steerOutcome = outcome; });
  f.releases.push(outcome.release);
  assert.equal((await f.message('Original active turn.')).status, 202);
  const runtime = f.runtimes[0];
  const update = f.message('An update that misses the active turn.');
  await entered.promise;
  runtime.complete();
  await f.waitFor(() => !!f.session().reviews?.[0]?.completedAt);
  outcome.release();
  assert.equal((await update).status, 202);
  await f.waitFor(() => runtime.starts.length === 2);
  assert.ok(runtime.starts[1].startsWith('An update that misses the active turn.'));
  assert.equal(f.session().status, 'running');
  assert.equal(f.session().queued.length, 0);
  runtime.complete();
});

test('closing during baseline capture prevents late runtime start and store writes', async t => {
  const baseline = gate(), captured = gate(), released = gate();
  const originalCapture = TurnReviews.prototype.capture;
  t.mock.method(TurnReviews.prototype, 'capture', async function (this: TurnReviews) {
    const result = await originalCapture.call(this);
    captured.release();
    await baseline.promise;
    released.release();
    return result;
  });
  const f = await fixture(t); f.releases.push(baseline.release);
  let closed = false, lateWrites = 0;
  const originalSet = f.app.store.set;
  t.mock.method(f.app.store, 'set', function (this: typeof f.app.store, key: string, value: unknown) {
    if (closed) lateWrites++;
    return originalSet.call(this, key, value);
  });
  const sending = f.message('Close before this turn reaches the runtime.').catch(() => undefined);
  await captured.promise;
  await f.app.close();
  closed = true;
  baseline.release();
  await released.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  await sending;
  assert.equal(f.runtimes[0].starts.length, 0);
  assert.equal(lateWrites, 0);
});
