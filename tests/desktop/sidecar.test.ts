import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { test, type TestContext } from 'node:test';
import { WebSocket } from 'ws';

const triples: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu', 'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-arm64': 'aarch64-pc-windows-msvc', 'win32-x64': 'x86_64-pc-windows-msvc',
};
const executable = resolve('src-tauri/binaries', `canvagent-node-${triples[`${process.platform}-${process.arch}`]}${process.platform === 'win32' ? '.exe' : ''}`);
const resources = resolve('src-tauri/resources');

function directory(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'canvagent-desktop-'));
  mkdirSync(join(root, 'workspace'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function start(t: TestContext, root: string) {
  const child = spawn(executable, [join(resources, 'server.mjs'), '--workspace', join(root, 'workspace'), '--data-root', join(root, 'data'), '--resources', resources], {
    // An installed app must not depend on this checkout as its working directory.
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; }
  });
  let diagnostic = '';
  child.stderr.on('data', bytes => { diagnostic += bytes.toString(); });
  const lines = createInterface({ input: child.stdout });
  const url = await new Promise<string>((resolveReady, reject) => {
    const timer = setTimeout(() => reject(new Error(`Desktop service did not become ready: ${diagnostic}`)), 10000);
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.type === 'ready') { clearTimeout(timer); resolveReady(message.url); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Desktop service exited: ${diagnostic}`)); });
  });
  return { child, url, exited };
}

test('the bundled Node helper serves the app and persists a board and Codex preferences across desktop restarts', async t => {
  const root = directory(t);
  const first = await start(t, root);
  const response = await fetch(`${first.url}/api/state`);
  const state = await response.json() as any;
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  assert.equal(state.project.desktop, true);
  assert.equal(state.project.workspace, realpathSync(join(root, 'workspace')));
  assert.match(await (await fetch(first.url)).text(), /Canvagent/);
  const assets = await fetch(`${first.url}/excalidraw-assets/index.css`);
  assert.equal(assets.status, 200);
  const rejected = await fetch(`${first.url}/api/board/mutate`, {
    method: 'POST', headers: { Origin: 'https://example.com', cookie, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(rejected.status, 403);
  const mutation = await fetch(`${first.url}/api/board/mutate`, {
    method: 'POST', headers: { Origin: first.url, cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'desktop-drawing', observedBoardRevision: 0, operations: [{ kind: 'create', elementId: 'desktop-shape', element: { id: 'desktop-shape', type: 'rectangle', x: 50, y: 60, width: 100, height: 80, version: 1, isDeleted: false } }] }),
  });
  assert.equal(mutation.status, 200);
  const remembered = await fetch(`${first.url}/api/sessions/${state.activeSessionId}/settings?remember=true`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandboxMode: 'workspace-write' }),
  });
  assert.equal(remembered.status, 200);
  assert.equal((await remembered.json() as any).settings.approvalsReviewer, 'auto_review');
  const socket = new WebSocket(`${first.url.replace('http:', 'ws:')}/api/events`, { origin: first.url, headers: { cookie } });
  const [snapshot] = await once(socket, 'message');
  assert.equal(JSON.parse(snapshot.toString()).state.board.elements[0].id, 'desktop-shape');
  socket.close();
  first.child.stdin.write('shutdown\n');
  assert.equal((await first.exited)[0], 0);
  const reserved = createServer();
  t.after(() => new Promise<void>(resolveClose => reserved.close(() => resolveClose())));
  await new Promise<void>((resolveListen, reject) => {
    reserved.once('error', reject);
    reserved.listen(Number(new URL(first.url).port), '127.0.0.1', resolveListen);
  });
  const second = await start(t, root);
  assert.notEqual(new URL(second.url).port, new URL(first.url).port);
  const secondBootstrap = await fetch(`${second.url}/api/state`);
  const secondCookie = secondBootstrap.headers.get('set-cookie')!.split(';')[0];
  const reopened = await secondBootstrap.json() as any;
  assert.equal(reopened.board.elements[0].id, 'desktop-shape');
  assert.equal(reopened.activeSessionId, state.activeSessionId);
  assert.equal(reopened.sessions.find((session: any) => session.id === state.activeSessionId).settings.approvalsReviewer, 'auto_review');
  assert.equal(reopened.runtime.settings.approvalsReviewer, 'auto_review');
  const created = await fetch(`${second.url}/api/sessions`, {
    method: 'POST', headers: { cookie: secondCookie, 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal(created.status, 200);
  assert.equal((await created.json() as any).settings.approvalsReviewer, 'auto_review');
  second.child.stdin.write('shutdown\n');
  assert.equal((await second.exited)[0], 0);
});

test('closing the native control pipe stops its backend instead of leaving an orphan service', async t => {
  const backend = await start(t, directory(t));
  backend.child.stdin.end();
  assert.equal((await backend.exited)[0], 0);
  await assert.rejects(fetch(`${backend.url}/api/state`, { signal: AbortSignal.timeout(1500) }));
});
