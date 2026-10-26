import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MAX_DIRECTORY_ENTRIES, MAX_INDEX_RESULTS, MAX_SEARCH_RESULTS, MAX_TEXT_FILE_BYTES, SEARCH_DEADLINE_MS, WorkspaceFiles } from '../src/server/workspace-files.ts';
import { createWorkspaceHost } from '../src/server/workspaces.ts';

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'canvagent-files-')));
  const workspace = join(directory, 'workspace'); mkdirSync(workspace);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, workspace, files: new WorkspaceFiles(workspace) };
}
const status = (expected: number) => (error: any) => error?.status === expected;

test('workspace files list one directory, sort folders first, and include ordinary hidden files', async t => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, 'z-folder'));
  mkdirSync(join(f.workspace, 'a-folder'));
  mkdirSync(join(f.workspace, '.git'));
  writeFileSync(join(f.workspace, '.git', 'config'), 'internal');
  writeFileSync(join(f.workspace, 'z.txt'), 'last');
  writeFileSync(join(f.workspace, 'a.txt'), 'first');
  writeFileSync(join(f.workspace, '.env.example'), 'PORT=3000');
  writeFileSync(join(f.workspace, 'a-folder', 'nested.txt'), 'nested');
  const root = await f.files.list();
  assert.equal(root.path, '');
  assert.deepEqual(root.entries.map(entry => entry.name), ['a-folder', 'z-folder', '.env.example', 'a.txt', 'z.txt']);
  assert.deepEqual(root.entries.find(entry => entry.name === 'a.txt'), { name: 'a.txt', path: 'a.txt', kind: 'file', size: 5 });
  const nested = await f.files.list('./a-folder/');
  assert.equal(nested.path, 'a-folder');
  assert.equal(nested.entries[0].path, 'a-folder/nested.txt');
  assert.equal((await f.files.read('.env.example')).content, 'PORT=3000');
});

test('workspace file paths reject traversal, absolute paths, git internals, and escaped symlinks', async t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'secret.txt'), 'outside');
  writeFileSync(join(f.workspace, 'safe.txt'), 'inside');
  mkdirSync(join(f.workspace, '.git')); writeFileSync(join(f.workspace, '.git', 'config'), 'internal');
  symlinkSync(join(f.directory, 'secret.txt'), join(f.workspace, 'outside-link'));
  symlinkSync(f.directory, join(f.workspace, 'outside-directory'));
  symlinkSync(join(f.workspace, '.git'), join(f.workspace, 'git-alias'));
  symlinkSync(join(f.workspace, 'safe.txt'), join(f.workspace, 'safe-link'));
  for (const path of ['../secret.txt', 'nested/../../secret.txt', '/etc/passwd', 'C:\\secret.txt', '\\server\\file', 'safe.txt\0', 'nested\\..\\secret.txt']) {
    await assert.rejects(f.files.read(path), status(400));
    await assert.rejects(f.files.list(path), status(400));
  }
  for (const path of ['.git/config', './.git', '.GIT/config', 'git-alias/config', 'outside-link', 'outside-directory/secret.txt']) {
    await assert.rejects(f.files.read(path), status(403));
  }
  assert.equal((await f.files.read('safe-link')).content, 'inside');
  await assert.rejects(f.files.write('outside-link', 'overwrite', '0'.repeat(64)), status(403));
  await assert.rejects(f.files.write('git-alias/config', 'overwrite', '0'.repeat(64)), status(403));
  assert.equal(readFileSync(join(f.directory, 'secret.txt'), 'utf8'), 'outside');
  assert.equal(readFileSync(join(f.workspace, '.git', 'config'), 'utf8'), 'internal');
  const listing = await f.files.list();
  assert.deepEqual(listing.entries.map(entry => entry.name), ['safe-link', 'safe.txt']);
  await assert.rejects(f.files.raw('outside-link'), status(403));
});

test('directory enumeration is bounded and marks truncated results', async t => {
  const f = fixture(t);
  for (let index = 0; index <= MAX_DIRECTORY_ENTRIES; index++) writeFileSync(join(f.workspace, `file-${index}.txt`), '');
  const listing = await f.files.list();
  assert.equal(listing.entries.length, MAX_DIRECTORY_ENTRIES);
  assert.equal(listing.truncated, true);
});

test('text reads preserve unicode and BOM but reject binary, invalid UTF8, and oversized content', async t => {
  const f = fixture(t);
  const content = '\ufeffHello, 世界 🌸\r\n';
  writeFileSync(join(f.workspace, 'unicode.txt'), content);
  const opened = await f.files.read('unicode.txt');
  assert.equal(opened.content, content);
  assert.equal(opened.size, Buffer.byteLength(content));
  assert.match(opened.revision, /^[a-f0-9]{64}$/);
  writeFileSync(join(f.workspace, 'binary'), Buffer.from([97, 0, 98]));
  writeFileSync(join(f.workspace, 'invalid'), Buffer.from([0xff, 0xfe, 0xfd]));
  writeFileSync(join(f.workspace, 'control'), Buffer.from([1, 2, 3]));
  writeFileSync(join(f.workspace, 'oversized'), Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 97));
  for (const path of ['binary', 'invalid', 'control']) await assert.rejects(f.files.read(path), status(415));
  await assert.rejects(f.files.read('oversized'), status(413));
  await assert.rejects(f.files.write('unicode.txt', 'a'.repeat(MAX_TEXT_FILE_BYTES + 1), opened.revision), status(413));
  await assert.rejects(f.files.write('unicode.txt', 'a\0b', opened.revision), status(415));
  await assert.rejects(f.files.write('unicode.txt', '\ud800', opened.revision), status(415));
  assert.equal(readFileSync(join(f.workspace, 'unicode.txt'), 'utf8'), content);
});

test('atomic file saves preserve permissions and symlinks and return a new disk revision', async t => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'script.sh'), '#!/bin/sh\necho before\n');
  chmodSync(join(f.workspace, 'script.sh'), 0o751);
  symlinkSync(join(f.workspace, 'script.sh'), join(f.workspace, 'script-link'));
  const original = await f.files.read('script-link');
  const result = await f.files.write('script-link', '#!/bin/sh\necho after\n', original.revision);
  assert.equal(result.path, 'script-link');
  assert.notEqual(result.revision, original.revision);
  assert.equal(statSync(join(f.workspace, 'script.sh')).mode & 0o777, 0o751);
  assert.equal(realpathSync(join(f.workspace, 'script-link')), join(f.workspace, 'script.sh'));
  assert.equal(readFileSync(join(f.workspace, 'script.sh'), 'utf8'), result.content);
  assert.deepEqual(await f.files.read('script-link'), result);
  assert.ok(readdirSync(f.workspace).every(name => !name.startsWith('.canvagent-save-')));
  await assert.rejects(f.files.write('missing.txt', 'no new files', original.revision), status(404));
});

test('external edits and concurrent saves conflict without overwriting the current disk file', async t => {
  const f = fixture(t);
  const path = join(f.workspace, 'source.ts'); writeFileSync(path, 'original');
  const original = await f.files.read('source.ts');
  writeFileSync(path, 'changed by an external editor');
  await assert.rejects(f.files.write('source.ts', 'stale overwrite', original.revision), status(409));
  assert.equal(readFileSync(path, 'utf8'), 'changed by an external editor');
  const current = await f.files.read('source.ts');
  const results = await Promise.allSettled([
    f.files.write('source.ts', 'first save', current.revision),
    f.files.write('source.ts', 'second save', current.revision),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejection = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.equal(rejection.reason.status, 409);
  assert.equal(readFileSync(path, 'utf8'), 'first save');
  assert.ok(readdirSync(f.workspace).every(name => !name.startsWith('.canvagent-save-')));
});

test('raw files stream exact bytes and use inert content types for active source formats', async t => {
  const f = fixture(t);
  const png = Buffer.from([137, 80, 78, 71, 0, 1, 2, 3]);
  writeFileSync(join(f.workspace, 'picture.png'), png);
  writeFileSync(join(f.workspace, 'page.html'), '<script>alert(document.cookie)</script>');
  writeFileSync(join(f.workspace, 'vector.svg'), '<svg onload="alert(1)"></svg>');
  writeFileSync(join(f.workspace, 'data.bin'), Buffer.from([0, 1, 2]));
  const image = await f.files.raw('picture.png');
  assert.equal(image.mimeType, 'image/png');
  const chunks: Buffer[] = []; for await (const chunk of image.stream) chunks.push(Buffer.from(chunk));
  assert.deepEqual(Buffer.concat(chunks), png);
  for (const path of ['page.html', 'vector.svg']) {
    const result = await f.files.raw(path);
    assert.equal(result.mimeType, 'text/plain; charset=utf-8');
    for await (const _chunk of result.stream) { /* Drain and close the file. */ }
  }
  const binary = await f.files.raw('data.bin');
  assert.equal(binary.mimeType, 'application/octet-stream'); assert.match(binary.disposition, /^attachment;/);
  for await (const _chunk of binary.stream) { /* Drain and close the file. */ }
});

test('quick file discovery recursively ranks fuzzy filenames and excludes generated or escaped paths', async t => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, 'src', 'ui'), { recursive: true });
  writeFileSync(join(f.workspace, 'src', 'ui', 'Button.tsx'), 'export const Button = 1;');
  writeFileSync(join(f.workspace, 'src', 'ui', 'Button.test.ts'), 'test');
  writeFileSync(join(f.workspace, 'README.md'), 'readme');
  for (const name of ['.git', 'node_modules', '.canvagent', 'dist', 'build', 'target', '.next', 'coverage']) {
    mkdirSync(join(f.workspace, name)); writeFileSync(join(f.workspace, name, 'Button-secret.txt'), 'hidden');
  }
  const outside = join(f.directory, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'Button-outside.txt'), 'outside');
  symlinkSync(outside, join(f.workspace, 'outside-directory'));
  symlinkSync(join(outside, 'Button-outside.txt'), join(f.workspace, 'outside-file'));
  symlinkSync(f.workspace, join(f.workspace, 'cycle'));
  symlinkSync(join(f.workspace, 'src', 'ui', 'Button.tsx'), join(f.workspace, 'Button-link.tsx'));
  const matches = await f.files.index('BUTTON.TSX');
  assert.equal(matches.truncated, false);
  assert.equal(matches.files[0].path, 'src/ui/Button.tsx');
  assert.deepEqual(matches, await f.files.index('BUTTON.TSX'));
  const fuzzy = await f.files.index('srcuiBtn');
  assert.ok(fuzzy.files.some(file => file.path === 'src/ui/Button.tsx'));
  const all = await f.files.index();
  assert.deepEqual(all.files.map(file => file.path).sort(), ['Button-link.tsx', 'README.md', 'src/ui/Button.test.ts', 'src/ui/Button.tsx'].sort());
  assert.deepEqual((await f.files.index('cannotmatch')).files, []);
  await assert.rejects(f.files.index('a'.repeat(1001)));
});

test('content search returns editor line/column positions with case, word, regex, and literal options', async t => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, 'src'));
  const lines = ['Alpha alpha ALPHA alpha_beta alphabet', '🌸 Alpha', 'last Alpha', 'literal a.b and axb and [x]'];
  writeFileSync(join(f.workspace, 'src', 'code.txt'), lines.join('\r\n'));
  const words = await f.files.search({ query: 'alpha', wholeWord: true });
  assert.equal(words.truncated, false);
  assert.deepEqual(words.matches.map(({ path, line, column }) => [path, line, column]), [
    ['src/code.txt', 1, 1], ['src/code.txt', 1, 7], ['src/code.txt', 1, 13], ['src/code.txt', 2, 4], ['src/code.txt', 3, 6],
  ]);
  const exactCase = await f.files.search({ query: 'Alpha', caseSensitive: true, wholeWord: true });
  assert.deepEqual(exactCase.matches.map(({ line, column }) => [line, column]), [[1, 1], [2, 4], [3, 6]]);
  const literal = await f.files.search({ query: 'a.b' });
  assert.equal(literal.matches.length, 1); assert.equal(literal.matches[0].column, 9);
  assert.equal((await f.files.search({ query: '[x]' })).matches.length, 1);
  const regex = await f.files.search({ query: 'a.b', regex: true });
  assert.equal(regex.matches.length, 3);
  assert.equal(regex.matches.filter(match => match.line === 4).length, 2);
  assert.equal((await f.files.search({ query: 'never present' })).matches.length, 0);
  await assert.rejects(f.files.search({ query: '(', regex: true }), status(400));
  await assert.rejects(f.files.search({ query: '' }));
  await assert.rejects(f.files.search({ query: 'a'.repeat(1001) }));
});

test('discovery and search bound result counts and snippets while skipping unsafe text sources', async t => {
  const f = fixture(t);
  for (let index = 0; index <= MAX_INDEX_RESULTS; index++) writeFileSync(join(f.workspace, `entry-${index}.txt`), 'entry');
  const index = await f.files.index('entry');
  assert.equal(index.files.length, MAX_INDEX_RESULTS); assert.equal(index.truncated, true);
  writeFileSync(join(f.workspace, 'many.txt'), 'match '.repeat(MAX_SEARCH_RESULTS + 1));
  const many = await f.files.search({ query: 'match' });
  assert.equal(many.matches.length, MAX_SEARCH_RESULTS); assert.equal(many.truncated, true);
  assert.ok(many.matches.every(match => match.text.length <= 300));
  assert.equal(many.matches.at(-1)!.column, (MAX_SEARCH_RESULTS - 1) * 6 + 1);
  const excluded = 'unique-excluded-marker';
  mkdirSync(join(f.workspace, 'node_modules')); writeFileSync(join(f.workspace, 'node_modules', 'private.txt'), excluded);
  writeFileSync(join(f.workspace, 'binary'), Buffer.from(`${excluded}\0`));
  writeFileSync(join(f.workspace, 'invalid'), Buffer.concat([Buffer.from(excluded), Buffer.from([0xff])]));
  writeFileSync(join(f.workspace, 'oversized'), `${excluded}${'x'.repeat(MAX_TEXT_FILE_BYTES)}`);
  writeFileSync(join(f.directory, 'external.txt'), excluded);
  symlinkSync(join(f.directory, 'external.txt'), join(f.workspace, 'outside-link'));
  const absent = await f.files.search({ query: excluded });
  assert.equal(absent.truncated, false); assert.deepEqual(absent.matches, []);
});

test('pathological regex execution has a deadline and keeps the HTTP event loop responsive', async t => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'pathological.txt'), `${'a'.repeat(50_000)}!`);
  const started = Date.now();
  const search = f.files.search({ query: '(a+)+$', regex: true });
  await delay(40);
  assert.ok(Date.now() - started < 1000, 'Regex matching must run off the main event loop.');
  const result = await search;
  assert.equal(result.truncated, true); assert.deepEqual(result.matches, []);
  assert.ok(Date.now() - started < SEARCH_DEADLINE_MS + 2000);
  const controller = new AbortController();
  const canceled = f.files.search({ query: '(a+)+$', regex: true }, controller.signal);
  const canceledAt = Date.now();
  await delay(40); controller.abort();
  assert.equal((await canceled).truncated, true);
  assert.ok(Date.now() - canceledAt < 1000, 'Canceled searches must promptly terminate their worker.');
});

test('file HTTP routes require workspace authentication and isolate registered projects', async t => {
  const f = fixture(t);
  const other = join(f.directory, 'other'); mkdirSync(other);
  writeFileSync(join(f.workspace, 'notes.txt'), 'first workspace');
  writeFileSync(join(other, 'notes.txt'), 'second workspace');
  writeFileSync(join(f.workspace, 'index.html'), '<script>alert(1)</script>');
  const host = createWorkspaceHost({ workspace: f.workspace, dataRoot: join(f.directory, 'data'), port: 0 });
  t.after(() => host.close());
  await new Promise<void>(done => host.server.listen(0, '127.0.0.1', done));
  const address = host.server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const firstPath = host.projectPath(host.initialProjectId);
  const bootstrap = await fetch(`${base}${firstPath}api/state`);
  const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(`${base}${firstPath}api/files`)).status, 401);
  assert.equal((await fetch(`${base}${firstPath}api/files/index`)).status, 401);
  assert.equal((await fetch(`${base}${firstPath}api/files/search?query=workspace`)).status, 401);
  assert.equal((await fetch(`${base}${firstPath}api/files?path=`, { headers: { cookie, origin: 'https://example.com' } })).status, 403);
  const contentResponse = await fetch(`${base}${firstPath}api/files/content?path=notes.txt`, { headers: { cookie } });
  const content = await contentResponse.json() as any;
  assert.equal(content.content, 'first workspace');
  const index = await fetch(`${base}${firstPath}api/files/index?query=ntxt`, { headers: { cookie } });
  assert.equal((await index.json() as any).files[0].path, 'notes.txt');
  const search = await fetch(`${base}${firstPath}api/files/search?query=first`, { headers: { cookie } });
  assert.equal((await search.json() as any).matches[0].path, 'notes.txt');
  assert.equal((await fetch(`${base}${firstPath}api/files/search?query=first&regex=invalid`, { headers: { cookie } })).status, 400);
  assert.equal((await fetch(`${base}${firstPath}api/files/search?query=%28&regex=true`, { headers: { cookie } })).status, 400);
  const root = await fetch(`${base}/api/projects`);
  const hostCookie = root.headers.get('set-cookie')!.split(';')[0];
  const added = await fetch(`${base}/api/projects`, { method: 'POST', headers: { cookie: hostCookie, 'content-type': 'application/json' }, body: JSON.stringify({ workspace: other }) });
  const project = await added.json() as any;
  const otherBootstrap = await fetch(`${base}${project.path}api/state`);
  const otherCookie = otherBootstrap.headers.get('set-cookie')!.split(';')[0];
  const otherResponse = await fetch(`${base}${project.path}api/files/content?path=notes.txt`, { headers: { cookie: otherCookie } });
  assert.equal((await otherResponse.json() as any).content, 'second workspace');
  const isolatedSearch = await fetch(`${base}${project.path}api/files/search?query=first`, { headers: { cookie: otherCookie } });
  assert.deepEqual((await isolatedSearch.json() as any).matches, []);
  const saveBody = { path: 'notes.txt', content: 'saved from editor', revision: content.revision };
  assert.equal((await fetch(`${base}${project.path}api/files/content`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(saveBody) })).status, 401);
  const saved = await fetch(`${base}${firstPath}api/files/content`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(saveBody) });
  assert.equal(saved.status, 200);
  assert.equal(readFileSync(join(f.workspace, 'notes.txt'), 'utf8'), 'saved from editor');
  assert.equal(readFileSync(join(other, 'notes.txt'), 'utf8'), 'second workspace');
  const stale = await fetch(`${base}${firstPath}api/files/content`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(saveBody) });
  assert.equal(stale.status, 409);
  const raw = await fetch(`${base}${firstPath}api/files/raw?path=index.html`, { headers: { cookie } });
  assert.match(raw.headers.get('content-type')!, /^text\/plain/);
  assert.match(raw.headers.get('content-security-policy')!, /sandbox/);
  assert.equal(await raw.text(), '<script>alert(1)</script>');
  assert.equal((await fetch(`${base}/api/files/content?path=notes.txt`, { headers: { cookie } })).status, 404);
});
