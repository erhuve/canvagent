import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { spawn as spawnPty } from 'node-pty';
import { WebSocket } from 'ws';
import { z } from 'zod';
import { createTerminalService, MAX_TERMINALS, TERMINAL_INPUT_LIMIT, TERMINAL_SCROLLBACK_LIMIT, type TerminalProcess, type TerminalServiceOptions } from '../src/server/terminals.ts';
import { createWorkspaceHost } from '../src/server/workspaces.ts';

class FakePty implements TerminalProcess {
  dataListeners = new Set<(data: string) => void>();
  exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  writes: string[] = [];
  resizes: [number, number][] = [];
  kills: (string | undefined)[] = [];
  onData(listener: (data: string) => void) { this.dataListeners.add(listener); return { dispose: () => this.dataListeners.delete(listener) }; }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void) { this.exitListeners.add(listener); return { dispose: () => this.exitListeners.delete(listener) }; }
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.resizes.push([cols, rows]); }
  kill(signal?: string) { this.kills.push(signal); this.exit(0, 1); }
  data(data: string) { for (const listener of this.dataListeners) listener(data); }
  exit(exitCode: number, signal?: number) { for (const listener of [...this.exitListeners]) listener({ exitCode, signal }); }
}

async function waitFor(predicate: () => boolean, description = 'Expected terminal state', timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { assert.ok(Date.now() < deadline, `${description} was not reached.`); await delay(5); }
}

async function fixture(t: TestContext, options: TerminalServiceOptions = {}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'canvagent-terminal-test-')));
  const workspace = join(directory, 'project'); mkdirSync(workspace);
  const link = join(directory, 'project-link'); symlinkSync(workspace, link);
  const service = createTerminalService(link, options);
  const app = express();
  app.use('/api/terminals', service.router);
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof z.ZodError ? 400 : error.status ?? 500).json({ error: error.message });
  });
  const server = createServer(app);
  server.on('upgrade', (request, socket, head) => {
    if (!service.handleUpgrade(request, socket, head)) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await service.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  });
  async function request(path = '', body?: unknown) {
    const response = await fetch(`${base}/api/terminals${path}`, body === undefined ? undefined : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  }
  async function connect(id: string) {
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}/api/terminals/${id}/events`);
    const messages: any[] = [];
    socket.on('message', data => messages.push(JSON.parse(data.toString())));
    await once(socket, 'open');
    async function next(type: string) {
      await waitFor(() => messages.some(message => message.type === type), `Terminal ${type} message`);
      return messages.splice(messages.findIndex(message => message.type === type), 1)[0];
    }
    return { socket, messages, next, send: (message: object) => socket.send(JSON.stringify(message)) };
  }
  return { service, directory, workspace, base, request, connect };
}

test('terminal creation is lazy, validates dimensions, and uses the canonical project login environment', async t => {
  const spawned: any[] = [];
  const f = await fixture(t, { shell: '/bin/example-shell', env: { PATH: '/test/bin', CUSTOM: 'kept' }, spawn: (shell, args, options) => {
    spawned.push({ shell, args, options }); return new FakePty();
  } });
  assert.deepEqual((await f.request()).body, { terminals: [] });
  assert.equal(spawned.length, 0);
  for (const body of [{ cols: 0 }, { rows: 201 }, { cols: 80.5 }, { shell: '/bin/other' }]) assert.equal((await f.request('', body)).status, 400);
  assert.equal(spawned.length, 0);
  const created = await f.request('', {});
  assert.equal(created.status, 201);
  assert.deepEqual({ ...created.body.terminal, id: 'id' }, { id: 'id', title: 'example-shell 1', cols: 80, rows: 24, exited: false });
  assert.deepEqual(spawned[0], { shell: '/bin/example-shell', args: process.platform === 'win32' ? [] : ['-l'], options: {
    name: 'xterm-256color', cols: 80, rows: 24, cwd: f.workspace, encoding: 'utf8',
    env: { PATH: '/test/bin', CUSTOM: 'kept', PWD: f.workspace, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'Canvagent' },
  } });
});

test('a failed terminal helper leaves the service usable and returns a clean error before a manual retry', async t => {
  let attempts = 0;
  const f = await fixture(t, { shell: '/bin/example-shell', spawn: () => {
    if (++attempts === 1) throw Object.assign(new Error('dlopen(/private/example/node-pty/build/Release/pty.node): code signature invalid\n    at Module._extensions..node\n    at require'), { code: 'ERR_DLOPEN_FAILED' });
    return new FakePty();
  } });
  assert.equal(attempts, 0);
  assert.deepEqual(await f.request(), { status: 200, body: { terminals: [] } });
  assert.equal(attempts, 0);
  const failed = await f.request('', {});
  assert.equal(failed.status, 503);
  assert.deepEqual(failed.body, { error: 'Unable to start a terminal. The native terminal helper or login shell is unavailable. Reinstall Canvagent or check your login shell, then try again.' });
  assert.equal(attempts, 1);
  assert.deepEqual(await f.request(), { status: 200, body: { terminals: [] } });
  const retried = await f.request('', {});
  assert.equal(retried.status, 201);
  assert.equal(retried.body.terminal.title, 'example-shell 1');
  assert.equal(attempts, 2);
  assert.equal((await f.request()).body.terminals.length, 1);
});

test('terminal sockets replay bounded output, validate input/resize, and reconnect without killing the shell', async t => {
  const pty = new FakePty();
  const f = await fixture(t, { spawn: () => pty });
  const id = (await f.request('', { cols: 90, rows: 30 })).body.terminal.id;
  pty.data('initial output\r\n');
  const first = await f.connect(id);
  assert.equal((await first.next('ready')).output, 'initial output\r\n');
  first.send({ type: 'input', data: 'echo hello\r' });
  first.send({ type: 'resize', cols: 110, rows: 41 });
  await waitFor(() => pty.writes.length === 1 && pty.resizes.length === 1);
  assert.deepEqual(pty.writes, ['echo hello\r']); assert.deepEqual(pty.resizes, [[110, 41]]);
  for (const message of [{ type: 'input', data: 'x'.repeat(TERMINAL_INPUT_LIMIT + 1) }, { type: 'resize', cols: -1, rows: 20 }, { type: 'unknown' }]) {
    first.send(message); assert.match((await first.next('error')).message, /Invalid terminal/);
  }
  first.socket.send('{'); assert.match((await first.next('error')).message, /valid JSON/);
  assert.equal(pty.writes.length, 1); assert.equal(pty.resizes.length, 1);
  first.socket.close(); await once(first.socket, 'close');
  assert.deepEqual(pty.kills, []);
  pty.data('x'.repeat(TERMINAL_SCROLLBACK_LIMIT + 50)); pty.data('\r\nend');
  const second = await f.connect(id);
  const ready = await second.next('ready');
  assert.equal(ready.output.length, TERMINAL_SCROLLBACK_LIMIT); assert.ok(ready.output.endsWith('\r\nend'));
  assert.equal(ready.terminal.cols, 110); assert.equal(ready.terminal.rows, 41);
  pty.data('live output'); assert.equal((await second.next('data')).data, 'live output');
  pty.exit(7, 15); assert.deepEqual(await second.next('exit'), { type: 'exit', exitCode: 7, signal: 15 });
  second.socket.close(); await once(second.socket, 'close');
  const third = await f.connect(id);
  assert.equal((await third.next('ready')).terminal.exited, true);
  assert.equal((await third.next('exit')).exitCode, 7);
  third.send({ type: 'input', data: 'after exit' }); assert.match((await third.next('error')).message, /exited/);
});

test('each service bounds session count and closing a terminal or app cleans up sessions and sockets', async t => {
  const processes: FakePty[] = [];
  const f = await fixture(t, { spawn: () => { const pty = new FakePty(); processes.push(pty); return pty; } });
  const ids: string[] = [];
  for (let index = 0; index < MAX_TERMINALS; index++) ids.push((await f.request('', {})).body.terminal.id);
  assert.equal((await f.request('', {})).status, 409); assert.equal(processes.length, MAX_TERMINALS);
  const client = await f.connect(ids[0]); await client.next('ready');
  const socketClosed = once(client.socket, 'close');
  assert.equal((await f.request(`/${ids[0]}/close`, {})).body.ok, true);
  await socketClosed;
  assert.equal(processes[0].kills.length, 1); assert.equal((await f.request()).body.terminals.length, MAX_TERMINALS - 1);
  assert.equal((await f.request(`/${ids[0]}/close`, {})).status, 404);
  assert.equal((await f.request('', {})).status, 201);
  await f.service.close(); await f.service.close();
  assert.ok(processes.every(pty => pty.kills.length === 1 && pty.dataListeners.size === 0 && pty.exitListeners.size === 0));
  assert.equal((await f.request()).status, 503);
});

test('terminal upgrades require the exact route and terminal ids belong to only their own service', async t => {
  const first = await fixture(t, { spawn: () => new FakePty() });
  const second = await fixture(t, { spawn: () => new FakePty() });
  const id = (await first.request('', {})).body.terminal.id;
  async function rejected(base: string, path: string) {
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}${path}`);
    const status = await new Promise<number>((resolve, reject) => {
      socket.once('unexpected-response', (_request, response) => { resolve(response.statusCode!); response.resume(); socket.terminate(); });
      socket.on('error', () => undefined); socket.once('open', () => reject(new Error('Unexpected terminal connection.')));
    });
    return status;
  }
  assert.equal(await rejected(second.base, `/api/terminals/${id}/events`), 404);
  for (const path of [`/api/terminals/${id}/events/extra`, `/api/terminals/${id}/events/`, `/api/terminals/${id}/other`, '/api/events']) assert.equal(await rejected(first.base, path), 404);
});

test('a real PTY supports shell output, project cwd, input, resize, exit, and app cleanup', { skip: process.platform === 'win32' }, async t => {
  const pids: number[] = [];
  const f = await fixture(t, { shell: '/bin/sh', shellArgs: [], env: { ...process.env, PS1: '', ENV: undefined }, spawn: (shell, args, options) => {
    const terminal = spawnPty(shell, args, options); pids.push(terminal.pid); return terminal;
  } });
  const id = (await f.request('', {})).body.terminal.id;
  const client = await f.connect(id); await client.next('ready');
  let output = '';
  client.socket.on('message', raw => { const message = JSON.parse(raw.toString()); if (message.type === 'data') output += message.data; });
  client.send({ type: 'input', data: "printf '\\n__PTY_CWD__%s\\n' \"$PWD\"; printf '__PTY_TERM__%s\\n' \"$TERM\"\r" });
  await waitFor(() => output.includes(`__PTY_CWD__${f.workspace}\r\n`) && output.includes('__PTY_TERM__xterm-256color\r\n'), 'PTY cwd and environment');
  client.send({ type: 'resize', cols: 113, rows: 31 });
  client.send({ type: 'input', data: 'stty size\r' });
  await waitFor(() => output.includes('31 113\r\n'), 'PTY resized dimensions');
  client.send({ type: 'input', data: "read answer; printf '\\n__PTY_INPUT__%s\\n' \"$answer\"\rterminal-input\r" });
  await waitFor(() => output.includes('__PTY_INPUT__terminal-input\r\n'), 'PTY interactive input');
  client.send({ type: 'input', data: 'exit 7\r' });
  assert.equal((await client.next('exit')).exitCode, 7);
  assert.equal((await f.request()).body.terminals[0].exitCode, 7);
  const other = (await f.request('', {})).body.terminal.id;
  assert.ok(other && pids.length === 2);
  await f.service.close();
  await waitFor(() => { try { process.kill(pids[1], 0); return false; } catch { return true; } }, 'PTY process cleanup');
});

test('project terminals require their own cookie and same-origin requests across HTTP and WebSocket', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'canvagent-terminal-auth-')));
  const firstWorkspace = join(directory, 'first'); const secondWorkspace = join(directory, 'second');
  mkdirSync(firstWorkspace); mkdirSync(secondWorkspace);
  const host = createWorkspaceHost({ workspace: firstWorkspace, dataRoot: join(directory, 'data'), port: 0 });
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  await new Promise<void>(resolve => host.server.listen(0, '127.0.0.1', resolve));
  const address = host.server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const firstPath = host.projectPath(host.initialProjectId);
  const firstBootstrap = await fetch(`${base}${firstPath}api/state`);
  const firstCookie = firstBootstrap.headers.get('set-cookie')!.split(';')[0];
  const list = await fetch(`${base}/api/projects`);
  const hostCookie = list.headers.get('set-cookie')!.split(';')[0];
  const added = await fetch(`${base}/api/projects`, { method: 'POST', headers: { cookie: hostCookie, 'content-type': 'application/json' }, body: JSON.stringify({ workspace: secondWorkspace }) });
  const secondPath = (await added.json() as any).path;
  const secondBootstrap = await fetch(`${base}${secondPath}api/state`);
  const secondCookie = secondBootstrap.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(`${base}${firstPath}api/terminals`)).status, 401);
  assert.equal((await fetch(`${base}${firstPath}api/terminals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}${firstPath}api/terminals`, { headers: { cookie: firstCookie, origin: 'https://outside.example' } })).status, 403);
  assert.deepEqual(await (await fetch(`${base}${firstPath}api/terminals`, { headers: { cookie: firstCookie } })).json(), { terminals: [] });
  const created = await fetch(`${base}${firstPath}api/terminals`, { method: 'POST', headers: { cookie: firstCookie, origin: base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(created.status, 201);
  const id = (await created.json() as any).terminal.id;
  assert.equal((await fetch(`${base}${secondPath}api/terminals`, { headers: { cookie: firstCookie } })).status, 401);
  assert.deepEqual(await (await fetch(`${base}${secondPath}api/terminals`, { headers: { cookie: secondCookie } })).json(), { terminals: [] });
  assert.equal((await fetch(`${base}${secondPath}api/terminals/${id}/close`, { method: 'POST', headers: { cookie: secondCookie, 'content-type': 'application/json' }, body: '{}' })).status, 404);
  async function rejectUpgrade(path: string, cookie: string, origin = base, extra: Record<string, string> = {}) {
    const socket = new WebSocket(`${base.replace('http:', 'ws:')}${path}`, { headers: { ...(cookie ? { cookie } : {}), ...extra }, origin });
    return new Promise<number>((resolve, reject) => {
      socket.on('error', () => undefined);
      socket.once('unexpected-response', (_request, response) => { response.resume(); socket.terminate(); resolve(response.statusCode!); });
      socket.once('open', () => { socket.terminate(); reject(new Error('Unexpected authenticated terminal connection.')); });
    });
  }
  const firstEvents = `${firstPath}api/terminals/${id}/events`;
  assert.equal(await rejectUpgrade(firstEvents, ''), 403);
  assert.equal(await rejectUpgrade(firstEvents, secondCookie), 403);
  assert.equal(await rejectUpgrade(firstEvents, firstCookie, 'https://outside.example'), 403);
  assert.equal(await rejectUpgrade(firstEvents, firstCookie, base, { host: 'outside.example' }), 403);
  assert.equal(await rejectUpgrade(`${secondPath}api/terminals/${id}/events`, firstCookie), 403);
  assert.equal(await rejectUpgrade(`${secondPath}api/terminals/${id}/events`, secondCookie), 404);
  const socket = new WebSocket(`${base.replace('http:', 'ws:')}${firstEvents}`, { headers: { cookie: firstCookie }, origin: base });
  const ready = once(socket, 'message');
  await once(socket, 'open');
  const [message] = await ready;
  assert.equal(JSON.parse(message.toString()).terminal.id, id);
  const socketClosed = once(socket, 'close');
  await host.close();
  await socketClosed;
});
