import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import express from 'express';
import { MAX_GIT_DIFF_BYTES, WorkspaceGit, createGitRouter } from '../src/server/git.ts';

function fixture(t: TestContext, initialize = true) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'canvagent-git-')));
  const workspace = join(directory, 'workspace'); mkdirSync(workspace);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const run = (...args: string[]) => execFileSync('git', ['--literal-pathspecs', ...args], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (initialize) {
    run('init', '-b', 'review-test');
    run('config', 'user.name', 'Canvagent test');
    run('config', 'user.email', 'test@example.invalid');
    run('config', 'commit.gpgsign', 'false');
  }
  const save = (path: string, content: string | Buffer) => writeFileSync(join(workspace, path), content);
  const commit = () => { run('add', '--', '.'); run('commit', '-m', 'Initial test files'); };
  return { directory, workspace, run, save, commit, git: new WorkspaceGit(workspace) };
}
const status = (expected: number) => (error: any) => error?.status === expected;

test('Git review distinguishes index, worktree and untracked changes without altering files or index', async t => {
  const f = fixture(t);
  f.save('both.txt', 'original\n'); f.save('deleted.txt', 'delete me\n'); f.commit();
  f.save('both.txt', 'staged edit\n'); f.run('add', '--', 'both.txt');
  f.save('both.txt', 'working edit\n'); unlinkSync(join(f.workspace, 'deleted.txt'));
  f.save('new.txt', 'new untracked content\n');
  const index = readFileSync(join(f.workspace, '.git', 'index'));
  const result = await f.git.status();
  assert.equal(result.available, true); assert.equal(result.branch, 'review-test');
  assert.deepEqual(result.files.find(file => file.path === 'both.txt'), { path: 'both.txt', status: 'MM', staged: true, unstaged: true, untracked: false });
  assert.deepEqual(result.files.find(file => file.path === 'new.txt'), { path: 'new.txt', status: '??', staged: false, unstaged: false, untracked: true });
  assert.equal(result.files.find(file => file.path === 'deleted.txt')?.unstaged, true);
  const staged = await f.git.diff('both.txt', true);
  assert.match(staged.diff, /-original\n\+staged edit/); assert.doesNotMatch(staged.diff, /working edit/);
  const working = await f.git.diff('both.txt', false);
  assert.match(working.diff, /-staged edit\n\+working edit/);
  assert.match((await f.git.diff('new.txt', false)).diff, /\+new untracked content/);
  assert.equal((await f.git.diff('new.txt', true)).diff, '');
  assert.match((await f.git.diff('deleted.txt', false)).diff, /-delete me/);
  assert.deepEqual(readFileSync(join(f.workspace, '.git', 'index')), index);
  assert.equal(readFileSync(join(f.workspace, 'both.txt'), 'utf8'), 'working edit\n');
});

test('porcelain NUL parsing preserves unusual filenames and consumes rename source records', async t => {
  const f = fixture(t);
  const before = 'before →\n雪.txt', after = 'after [x]\t"quoted".txt';
  f.save(before, 'renamed body\n'); f.save('other.txt', 'unchanged\n'); f.commit();
  renameSync(join(f.workspace, before), join(f.workspace, after));
  f.run('add', '--', '.'); f.save('other.txt', 'other edit\n');
  const result = await f.git.status();
  assert.equal(result.files.length, 2);
  const renamed = result.files.find(file => file.path === after);
  assert.equal(renamed?.status, 'R '); assert.equal(renamed.originalPath, before);
  assert.equal(result.files.find(file => file.path === 'other.txt')?.status, ' M');
  assert.match((await f.git.diff(after, true)).diff, /renamed body/);
  f.save('new\nfile.txt', 'newline untracked\n');
  assert.match((await f.git.diff('new\nfile.txt', false)).diff, /\+newline untracked/);
});

test('diff paths are literal, reject traversal and internals, and never expand pathspec magic or options', async t => {
  const f = fixture(t);
  const literal = ':(glob)*.txt';
  f.save(literal, 'literal before\n'); f.save('other.txt', 'other before\n'); f.commit();
  f.save(literal, 'literal after\n'); f.save('other.txt', 'other private content\n');
  f.save('--output=should-not-exist', 'option filename\n');
  const result = await f.git.diff(literal, false);
  assert.match(result.diff, /literal after/); assert.doesNotMatch(result.diff, /other private content/);
  assert.match((await f.git.diff('--output=should-not-exist', false)).diff, /option filename/);
  assert.equal(existsSync(join(f.workspace, 'should-not-exist')), false);
  await assert.rejects(f.git.diff(':(glob)*', false), status(404));
  for (const path of ['../outside', 'folder/../../outside', '/etc/passwd', 'C:\\outside', '\\\\server\\file', 'other.txt\0']) await assert.rejects(f.git.diff(path, false), status(400));
  for (const path of ['.git/config', '.GIT/config', 'folder/.git/config']) await assert.rejects(f.git.diff(path, false), status(403));
  await assert.rejects(f.git.diff('unchanged-or-missing.txt', false), status(404));
});

test('review excludes symlink escapes and Git aliases while allowing deleted files in ordinary folders', async t => {
  const f = fixture(t);
  f.save('base.txt', 'base\n'); mkdirSync(join(f.workspace, 'folder')); f.save('folder/deleted.txt', 'removed\n'); f.commit();
  f.save('base.txt', 'changed\n');
  writeFileSync(join(f.directory, 'outside.txt'), 'outside secret');
  symlinkSync(join(f.directory, 'outside.txt'), join(f.workspace, 'outside-link'));
  symlinkSync(f.directory, join(f.workspace, 'outside-directory'));
  symlinkSync(join(f.workspace, '.git'), join(f.workspace, 'git-alias'));
  unlinkSync(join(f.workspace, 'folder', 'deleted.txt')); rmSync(join(f.workspace, 'folder'), { recursive: true });
  for (const path of ['outside-link', 'outside-directory/outside.txt', 'git-alias/config']) await assert.rejects(f.git.diff(path, false), status(403));
  const result = await f.git.status();
  assert.ok(result.files.some(file => file.path === 'base.txt'));
  assert.ok(result.files.every(file => !/outside-|git-alias/.test(file.path)));
  assert.match((await f.git.diff('folder/deleted.txt', false)).diff, /-removed/);
});

test('a workspace nested inside a repository exposes only paths inside that workspace', async t => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, 'nested')); f.save('outside.txt', 'outside before\n'); f.save('nested/inside.txt', 'inside before\n'); f.commit();
  f.save('outside.txt', 'outside changed secret\n'); f.save('nested/inside.txt', 'inside changed\n'); f.save('nested/new.txt', 'inside new\n');
  const nested = new WorkspaceGit(join(f.workspace, 'nested'));
  assert.deepEqual((await nested.status()).files.map(file => file.path).sort(), ['inside.txt', 'new.txt']);
  assert.match((await nested.diff('inside.txt', false)).diff, /inside changed/);
  assert.doesNotMatch((await nested.diff('inside.txt', false)).diff, /outside changed secret/);
  assert.match((await nested.diff('new.txt', false)).diff, /inside new/);
  await assert.rejects(nested.diff('../outside.txt', false), status(400));
});

test('binary diffs are identified and large text diffs are bounded', async t => {
  const f = fixture(t);
  f.save('binary.bin', Buffer.from([0, 1, 2])); f.save('text.txt', 'before\n'); f.commit();
  f.save('binary.bin', Buffer.from([0, 3, 4]));
  assert.equal((await f.git.diff('binary.bin', false)).binary, true);
  f.save('new.bin', Buffer.from([0, 3, 4]));
  assert.equal((await f.git.diff('new.bin', false)).binary, true);
  f.save('text.txt', 'large added line\n'.repeat(70_000));
  const result = await f.git.diff('text.txt', false);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.diff) <= MAX_GIT_DIFF_BYTES);
  assert.match(result.diff, /\+large added line/);
});

test('review disables configured filesystem monitors, clean filters, external diffs and text converters', async t => {
  const f = fixture(t);
  f.save('.gitattributes', '*.txt filter=review diff=review\n'); f.save('source.txt', 'before\n'); f.commit();
  f.run('config', 'filter.review.clean', 'touch .review-filter-ran; cat');
  f.run('config', 'filter.review.required', 'true');
  f.run('config', 'diff.review.command', 'touch .review-external-ran');
  f.run('config', 'diff.review.textconv', 'touch .review-converter-ran; cat');
  f.run('config', 'core.fsmonitor', 'touch .review-monitor-ran');
  f.save('source.txt', 'after\n');
  assert.equal((await f.git.status()).files.find(file => file.path === 'source.txt')?.unstaged, true);
  assert.match((await f.git.diff('source.txt', false)).diff, /\+after/);
  for (const name of ['filter', 'external', 'converter', 'monitor']) assert.equal(existsSync(join(f.workspace, `.review-${name}-ran`)), false);
});

test('folders without a Git repository have an explicit unavailable state', async t => {
  const f = fixture(t, false);
  assert.deepEqual(await f.git.status(), { available: false, files: [] });
  await assert.rejects(f.git.diff('file.txt', false), status(404));
});

test('undecodable filenames cannot be confused with a different Unicode path', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  await assert.rejects(f.git.diff('invalid-\ud800', false), status(400));
  try { writeFileSync(Buffer.concat([Buffer.from(`${f.workspace}/invalid-`), Buffer.from([0xff])]), 'invalid filename'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EILSEQ') { t.skip('This filesystem requires valid UTF-8 filenames.'); return; } throw error; }
  await assert.rejects(f.git.status(), status(415));
});

test('Git routes validate query values and support read-only review only', async t => {
  const f = fixture(t);
  f.save('file.txt', 'before\n'); f.commit(); f.save('file.txt', 'after\n');
  const app = express(); app.use('/api/git', createGitRouter(f.workspace));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).json({ error: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}/api/git`;
  assert.equal((await fetch(`${base}/status`)).status, 200);
  const diff = await fetch(`${base}/diff?path=file.txt&staged=false`);
  assert.match((await diff.json() as any).diff, /\+after/);
  for (const query of ['path=file.txt&staged=yes', 'path=file.txt&staged=true&staged=false', 'path=file.txt&path=other.txt', 'path=../file.txt', 'staged=true']) assert.equal((await fetch(`${base}/diff?${query}`)).status, 400);
  assert.equal((await fetch(`${base}/status`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/stage`, { method: 'POST' })).status, 404);
});
