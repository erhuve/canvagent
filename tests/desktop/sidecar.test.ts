import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
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
const selectedBundle = process.env.CANVAGENT_DESKTOP_BUNDLE;
let executable = resolve('src-tauri/binaries', `canvagent-node-${triples[`${process.platform}-${process.arch}`]}${process.platform === 'win32' ? '.exe' : ''}`);
let resources = resolve('src-tauri/resources');
if (selectedBundle !== undefined) {
  assert.ok(selectedBundle.trim(), 'CANVAGENT_DESKTOP_BUNDLE must point to a .app bundle.');
  const bundle = resolve(selectedBundle);
  assert.ok(bundle.endsWith('.app') && existsSync(bundle) && statSync(bundle).isDirectory(), `Desktop bundle does not exist or is not a .app directory: ${bundle}`);
  executable = join(bundle, 'Contents/MacOS/canvagent-node');
  resources = join(bundle, 'Contents/Resources/desktop');
  for (const path of [executable, join(resources, 'server.mjs')]) {
    assert.ok(existsSync(path) && statSync(path).isFile(), `Desktop bundle is missing a required file: ${path}`);
  }
}

function directory(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'canvagent-desktop-'));
  mkdirSync(join(root, 'workspace'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

async function start(t: TestContext, root: string, environment: NodeJS.ProcessEnv = {}, resourceDirectory = resources) {
  const child = spawn(executable, [join(resourceDirectory, 'server.mjs'), '--workspace', join(root, 'workspace'), '--data-root', join(root, 'data'), '--resources', resourceDirectory], {
    // An installed app must not depend on this checkout as its working directory.
    cwd: root, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...environment },
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
      if (message.type === 'ready') { clearTimeout(timer); resolveReady(message.url.replace(/\/$/, '')); }
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

test('packaged file creation, folder rename, and deletion undo survive a desktop restart', async t => {
  const root = directory(t);
  const first = await start(t, root);
  const bootstrap = await fetch(`${first.url}/api/state`);
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  const request = async (backend: { url: string }, credential: string, path: string, body?: unknown) => {
    const response = await fetch(`${backend.url}/api/files/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { cookie: credential, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as any;
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  };
  await request(first, cookie, 'create', { path: 'created', kind: 'directory' });
  await request(first, cookie, 'create', { path: 'created/note.md', kind: 'file' });
  const blank = await request(first, cookie, 'content?path=created/note.md');
  await request(first, cookie, 'content', { path: 'created/note.md', content: '# Saved in the packaged app\n', revision: blank.revision });
  const folder = await request(first, cookie, 'info?path=created');
  await request(first, cookie, 'rename', { path: 'created', newPath: 'renamed', revision: folder.revision });
  const note = await request(first, cookie, 'info?path=renamed/note.md');
  const deleted = await request(first, cookie, 'delete', { path: 'renamed/note.md', revision: note.revision });
  assert.equal(deleted.trashed, true);
  first.child.stdin.write('shutdown\n');
  assert.equal((await first.exited)[0], 0);
  const second = await start(t, root);
  const reopened = await fetch(`${second.url}/api/state`);
  const reopenedCookie = reopened.headers.get('set-cookie')!.split(';')[0];
  await request(second, reopenedCookie, 'restore', { trashId: deleted.trashId });
  const restored = await request(second, reopenedCookie, 'content?path=renamed/note.md');
  assert.equal(restored.content, '# Saved in the packaged app\n');
  second.child.stdin.write('shutdown\n');
  assert.equal((await second.exited)[0], 0);
});

test('the bundled PTY opens an interactive project shell outside the source checkout', async t => {
  const root = directory(t);
  const backend = await start(t, root, { SHELL: '/bin/sh' });
  const bootstrap = await fetch(`${backend.url}/api/state`);
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  const response = await fetch(`${backend.url}/api/terminals`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ cols: 90, rows: 25 }),
  });
  assert.equal(response.status, 201);
  const { terminal } = await response.json() as any;
  const socket = new WebSocket(`${backend.url.replace('http:', 'ws:')}/api/terminals/${terminal.id}/events`, { origin: new URL(backend.url).origin, headers: { cookie } });
  t.after(() => socket.terminate());
  let output = '';
  await new Promise<void>((resolveOutput, reject) => {
    const timer = setTimeout(() => reject(new Error('The bundled PTY did not produce shell output.')), 5000);
    socket.on('error', reject);
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'ready') {
        socket.send(JSON.stringify({ type: 'input', data: 'printf "__PTY_%s__\\n" "READY"; printf "__CWD__%s\\n" "$PWD"\r' }));
      } else if (message.type === 'data') output += message.data;
      if (output.includes('__PTY_READY__') && output.includes(`__CWD__${realpathSync(join(root, 'workspace'))}`)) { clearTimeout(timer); resolveOutput(); }
    });
  });
  const closed = await fetch(`${backend.url}/api/terminals/${terminal.id}/close`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(closed.status, 200);
  assert.deepEqual(await (await fetch(`${backend.url}/api/terminals`, { headers: { cookie } })).json(), { terminals: [] });
  backend.child.stdin.write('shutdown\n');
  assert.equal((await backend.exited)[0], 0);
});

test('an unavailable optional terminal helper leaves the desktop board usable', async t => {
  const root = directory(t);
  const isolatedResources = join(root, 'resources-without-terminal');
  mkdirSync(isolatedResources);
  copyFileSync(join(resources, 'server.mjs'), join(isolatedResources, 'server.mjs'));
  // The copy lives outside the checkout, and NODE_PATH cannot supply node-pty.
  const backend = await start(t, root, { NODE_PATH: '' }, isolatedResources);
  const bootstrap = await fetch(`${backend.url}/api/state`);
  assert.equal(bootstrap.status, 200);
  assert.equal((await bootstrap.json() as any).project.desktop, true);
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  const terminal = await fetch(`${backend.url}/api/terminals`, {
    method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ cols: 80, rows: 24 }),
  });
  assert.equal(terminal.status, 503);
  assert.match((await terminal.json() as { error: string }).error, /native terminal helper or login shell is unavailable/);
  assert.deepEqual(await (await fetch(`${backend.url}/api/terminals`, { headers: { cookie } })).json(), { terminals: [] });
  const mutation = await fetch(`${backend.url}/api/board/mutate`, {
    method: 'POST', headers: { Origin: backend.url, cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: 'without-terminal', observedBoardRevision: 0, operations: [{ kind: 'create', elementId: 'still-usable', element: { id: 'still-usable', type: 'rectangle', x: 10, y: 20, width: 30, height: 40, version: 1, isDeleted: false } }] }),
  });
  assert.equal(mutation.status, 200);
  const state = await (await fetch(`${backend.url}/api/state`, { headers: { cookie } })).json() as any;
  assert.equal(state.board.elements[0].id, 'still-usable');
  backend.child.stdin.write('shutdown\n');
  assert.equal((await backend.exited)[0], 0);
});
