import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { createWorkspaceHost } from '../src/server/workspaces.ts';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'canvagent-file-management-http-'));
  const workspace = join(directory, 'first'); const other = join(directory, 'second');
  mkdirSync(workspace); mkdirSync(other);
  const options = { workspace, dataRoot: join(directory, 'data'), port: 0 };
  let host = createWorkspaceHost(options);
  const listen = async () => {
    await new Promise<void>(resolve => host.server.listen(0, '127.0.0.1', resolve));
    const address = host.server.address(); assert.ok(address && typeof address === 'object');
    return `http://127.0.0.1:${address.port}`;
  };
  let base = await listen();
  t.after(async () => { await host.close(); rmSync(directory, { recursive: true, force: true }); });
  const bootstrap = async (path: string) => {
    const response = await fetch(`${base}${path}api/state`);
    assert.equal(response.status, 200);
    return response.headers.getSetCookie()[0].split(';')[0];
  };
  const firstPath = host.projectPath(host.initialProjectId);
  let firstCookie = await bootstrap(firstPath);
  const registry = await fetch(`${base}/api/projects`);
  const hostCookie = registry.headers.getSetCookie()[0].split(';')[0];
  const registered = await fetch(`${base}/api/projects`, { method: 'POST', headers: { cookie: hostCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ workspace: other }) });
  assert.equal(registered.status, 201);
  const otherPath = (await registered.json()).path;
  const otherCookie = await bootstrap(otherPath);
  const request = async (path: string, body?: unknown, projectPath = firstPath, cookie = firstCookie, origin?: string) => {
    const response = await fetch(`${base}${projectPath}api/files/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const restart = async () => { await host.close(); host = createWorkspaceHost(options); base = await listen(); firstCookie = await bootstrap(firstPath); };
  return { workspace, other, firstPath, otherPath, otherCookie, request, restart };
}

test('file management routes require the originating project cookie and local origin', async t => {
  const f = await fixture(t);
  const input = { path: 'created.txt', kind: 'file' };
  assert.equal((await f.request('create', input, f.firstPath, '')).status, 401);
  assert.equal((await f.request('create', input, f.firstPath, f.otherCookie)).status, 401);
  assert.equal((await f.request('create', input, f.firstPath, undefined, 'https://example.com')).status, 403);
  assert.ok([200, 201].includes((await f.request('create', input)).status));
  assert.equal(readFileSync(join(f.workspace, 'created.txt'), 'utf8'), '');
  assert.equal((await f.request('info?path=created.txt', undefined, f.firstPath, '')).status, 401);
  assert.equal((await f.request('create', { path: '../outside.txt', kind: 'file' })).status, 400);
  assert.equal((await f.request('create', { path: '.git/config', kind: 'file' })).status, 403);
});

test('recovery storage remains project-scoped and restores saved contents after a restart', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, 'notes.txt'), 'Recover this original content.\n');
  const info = await f.request('info?path=notes.txt'); assert.equal(info.status, 200);
  const deleted = await f.request('delete', { path: 'notes.txt', revision: info.body.revision });
  assert.equal(deleted.status, 200); assert.equal(deleted.body.trashed, true);
  assert.equal(typeof deleted.body.trashId, 'string');
  assert.equal((await f.request('restore', { trashId: deleted.body.trashId }, f.otherPath, f.otherCookie)).status, 404);
  await f.restart();
  assert.equal((await f.request('restore', { trashId: deleted.body.trashId })).status, 200);
  assert.equal(readFileSync(join(f.workspace, 'notes.txt'), 'utf8'), 'Recover this original content.\n');
});

test('undoing a deletion never replaces a newer file with the same name', async t => {
  const f = await fixture(t);
  writeFileSync(join(f.workspace, 'notes.txt'), 'Original content.\n');
  const info = await f.request('info?path=notes.txt');
  const deleted = await f.request('delete', { path: 'notes.txt', revision: info.body.revision });
  assert.equal(deleted.status, 200);
  writeFileSync(join(f.workspace, 'notes.txt'), 'Newer content created outside the app.\n');
  assert.equal((await f.request('restore', { trashId: deleted.body.trashId })).status, 409);
  assert.equal(readFileSync(join(f.workspace, 'notes.txt'), 'utf8'), 'Newer content created outside the app.\n');
  rmSync(join(f.workspace, 'notes.txt'));
  assert.equal((await f.request('restore', { trashId: deleted.body.trashId })).status, 200);
  assert.equal(readFileSync(join(f.workspace, 'notes.txt'), 'utf8'), 'Original content.\n');
});
