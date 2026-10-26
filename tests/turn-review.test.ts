import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { TurnReviews, type ReviewSnapshot } from '../src/server/turn-review.js';
import type { TurnReview } from '../src/shared/context.js';

const revision = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const status = (expected: number) => (error: any) => error?.status === expected;
const review = (): TurnReview => ({ id: randomUUID(), messageId: randomUUID(), createdAt: new Date().toISOString(), status: 'completed', files: [], canvasElementIds: [] });

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'canvagent-turn-review-')));
  const workspace = join(directory, 'workspace'); mkdirSync(workspace);
  const dataDir = join(workspace, '.canvagent');
  const state = new Map<string, any>();
  const store = {
    get<T>(key: string): T | undefined { const value = state.get(key); return value === undefined ? undefined : JSON.parse(value); },
    set<T>(key: string, value: T) { state.set(key, JSON.stringify(value)); },
  };
  const board: { elements: any[] } = { elements: [] };
  const reviews = new TurnReviews({ workspace, dataDir, store, board: () => board });
  const save = (path: string, content: string | Buffer) => { mkdirSync(dirname(join(workspace, path)), { recursive: true }); writeFileSync(join(workspace, path), content); };
  const remove = (path: string) => rmSync(join(workspace, path), { force: true, recursive: true });
  const read = (path: string) => readFileSync(join(workspace, path), 'utf8');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, workspace, dataDir, state, store, board, reviews, save, remove, read };
}

test('turn reviews capture added, modified, deleted and canvas changes with immutable revisions', async t => {
  const f = fixture(t);
  f.save('source.txt', 'before\n'); f.save('deleted.txt', 'deleted content\n'); f.save('unchanged.txt', 'same\n');
  f.board.elements = [{ id: 'changed', x: 0 }, { id: 'removed', x: 1 }, { id: 'same', x: 2 }];
  const before = await f.reviews.capture();
  f.save('source.txt', 'after\n'); f.save('added.txt', 'added content\n'); f.remove('deleted.txt');
  f.board.elements = [{ id: 'changed', x: 3 }, { id: 'added', x: 4 }, { id: 'same', x: 2 }];
  const result = await f.reviews.finish(before, review());
  assert.deepEqual(result.files.map(file => ({ path: file.path, status: file.status })), [
    { path: 'added.txt', status: 'added' }, { path: 'deleted.txt', status: 'deleted' }, { path: 'source.txt', status: 'modified' },
  ]);
  assert.equal(result.files.find(file => file.path === 'source.txt')?.beforeRevision, revision('before\n'));
  assert.equal(result.files.find(file => file.path === 'source.txt')?.afterRevision, revision('after\n'));
  assert.deepEqual(result.canvasElementIds.sort(), ['added', 'changed', 'removed']);
  assert.equal(result.truncated, false); assert.ok(result.completedAt);
  assert.equal(readFileSync(join(f.dataDir, 'review-blobs', revision('before\n')), 'utf8'), 'before\n');
});

test('turn review diffs compare saved before/after bytes even after live files change', async t => {
  const f = fixture(t);
  f.save('nested/source.txt', 'before\n'); const before = await f.reviews.capture();
  f.save('nested/source.txt', 'turn edit\n'); const result = await f.reviews.finish(before, review());
  f.save('nested/source.txt', 'later human edit\n');
  const diff = await f.reviews.diff(result, 'nested/source.txt');
  assert.match(diff.diff, /-before\n\+turn edit/);
  assert.doesNotMatch(diff.diff, /later human edit/);
  assert.doesNotMatch(diff.diff, /review-diff|canvagent-turn-review-/);
  assert.equal(f.read('nested/source.txt'), 'later human edit\n');
});

test('review diff header cleanup preserves SQL comments and other hunk lines that resemble headers', async t => {
  const f = fixture(t);
  f.save('query.sql', '-- old comment\n++ old value\n'); const before = await f.reviews.capture();
  f.save('query.sql', '-- new comment\n++ new value\n'); const result = await f.reviews.finish(before, review());
  const diff = await f.reviews.diff(result, 'query.sql');
  assert.match(diff.diff, /^--- old comment$/m);
  assert.match(diff.diff, /^\+-- new comment$/m);
  assert.match(diff.diff, /^-\+\+ old value$/m);
  assert.match(diff.diff, /^\+\+\+ new value$/m);
});

test('bounded review diffs retain the truncation notice after replacing temporary path headers', async t => {
  const f = fixture(t);
  f.save('large.txt', 'before line\n'.repeat(30000)); const before = await f.reviews.capture();
  f.save('large.txt', 'after line\n'.repeat(30000)); const result = await f.reviews.finish(before, review());
  const diff = await f.reviews.diff(result, 'large.txt');
  assert.equal(diff.truncated, true);
  assert.ok(Buffer.byteLength(diff.diff) <= 512 * 1024);
  assert.doesNotMatch(diff.diff, /review-diff/);
});

test('turn review restores modified, added and deleted text files once without changing its saved diff', async t => {
  const f = fixture(t);
  f.save('modified.txt', 'before\n'); f.save('deleted.txt', 'restore me\n'); const before = await f.reviews.capture();
  f.save('modified.txt', 'after\n'); f.save('added.txt', 'remove me\n'); f.remove('deleted.txt');
  const result = await f.reviews.finish(before, review());
  for (const path of ['modified.txt', 'added.txt', 'deleted.txt']) assert.deepEqual(await f.reviews.restore(result, path), { ok: true });
  assert.equal(f.read('modified.txt'), 'before\n'); assert.equal(f.read('deleted.txt'), 'restore me\n');
  assert.equal(existsSync(join(f.workspace, 'added.txt')), false);
  assert.equal((await f.reviews.diff(result, 'modified.txt')).restored, true);
  assert.match((await f.reviews.diff(result, 'modified.txt')).diff, /-before\n\+after/);
  f.save('modified.txt', 'new human work\n');
  assert.deepEqual(await f.reviews.restore(result, 'modified.txt'), { ok: true, alreadyRestored: true });
  assert.equal(f.read('modified.txt'), 'new human work\n');
});

test('turn review restores preserve later edits and recreated deleted files with a conflict', async t => {
  const f = fixture(t);
  f.save('modified.txt', 'before\n'); f.save('deleted.txt', 'before deletion\n'); const before = await f.reviews.capture();
  f.save('modified.txt', 'turn edit\n'); f.save('added.txt', 'turn addition\n'); f.remove('deleted.txt');
  const result = await f.reviews.finish(before, review());
  for (const path of ['modified.txt', 'added.txt', 'deleted.txt']) {
    f.save(path, 'later human work\n');
    await assert.rejects(f.reviews.restore(result, path), status(409));
    assert.equal(f.read(path), 'later human work\n');
  }
});

test('deleted-file restoration preserves private and executable permissions', async t => {
  const f = fixture(t);
  for (const [path, mode] of [['secret.env', 0o600], ['script.sh', 0o751]] as const) {
    f.save(path, 'saved content\n'); chmodSync(join(f.workspace, path), mode);
  }
  const before = await f.reviews.capture();
  f.remove('secret.env'); f.remove('script.sh');
  const result = await f.reviews.finish(before, review());
  for (const [path, mode] of [['secret.env', 0o600], ['script.sh', 0o751]] as const) {
    await f.reviews.restore(result, path);
    assert.equal(statSync(join(f.workspace, path)).mode & 0o777, mode);
    assert.equal(f.read(path), 'saved content\n');
  }
});

test('legacy deleted-file snapshots without permissions restore with private access', async t => {
  const f = fixture(t);
  f.save('legacy.txt', 'legacy snapshot\n');
  const before = await f.reviews.capture(); delete before.files['legacy.txt'].mode;
  f.remove('legacy.txt'); const result = await f.reviews.finish(before, review());
  await f.reviews.restore(result, 'legacy.txt');
  assert.equal(statSync(join(f.workspace, 'legacy.txt')).mode & 0o777, 0o600);
});

test('binary turn changes have no text diff or restore action', async t => {
  const f = fixture(t);
  f.save('image.bin', Buffer.from([0, 1, 2])); const before = await f.reviews.capture();
  f.save('image.bin', Buffer.from([0, 3, 4])); const result = await f.reviews.finish(before, review());
  assert.deepEqual(await f.reviews.diff(result, 'image.bin'), { path: 'image.bin', diff: '', binary: true, restored: false });
  await assert.rejects(f.reviews.restore(result, 'image.bin'), /Binary file restoration is not supported/);
  assert.deepEqual(readFileSync(join(f.workspace, 'image.bin')), Buffer.from([0, 3, 4]));
});

test('incomplete turn snapshots do not label an unobserved side as an addition or deletion', async t => {
  for (const missing of ['before', 'after'] as const) {
    const f = fixture(t);
    f.save('known.txt', 'before\n'); f.save('unobserved.txt', 'same\n');
    const before = await f.reviews.capture();
    f.save('known.txt', 'after\n'); const after = await f.reviews.capture();
    const incomplete: ReviewSnapshot = missing === 'before' ? before : after;
    delete incomplete.files['unobserved.txt']; incomplete.truncated = true;
    f.reviews.capture = async () => after;
    const result = await f.reviews.finish(before, review());
    assert.equal(result.truncated, true);
    assert.deepEqual(result.files.map(file => file.path), ['known.txt']);
    await assert.rejects(f.reviews.restore(result, 'unobserved.txt'), status(404));
    assert.equal(f.read('unobserved.txt'), 'same\n');
  }
});

test('turn capture skips symlinks, generated folders and its own saved snapshots', async t => {
  const f = fixture(t);
  f.save('inside.txt', 'inside\n'); f.save('.git/config', 'git secret\n'); f.save('node_modules/library/index.js', 'dependency\n');
  f.save('.canvagent/private.txt', 'private state\n'); f.save('dist/app.js', 'generated\n');
  const outside = join(f.directory, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'secret.txt'), 'outside secret\n');
  symlinkSync(outside, join(f.workspace, 'outside-directory'));
  symlinkSync(join(outside, 'secret.txt'), join(f.workspace, 'outside-file'));
  symlinkSync(join(f.workspace, '.git'), join(f.workspace, 'git-alias'));
  const snapshot = await f.reviews.capture();
  assert.deepEqual(Object.keys(snapshot.files), ['inside.txt']);
  assert.equal(snapshot.truncated, false);
});

test('turn reviews preserve legal filenames matching JavaScript prototype properties after persistence', async t => {
  const f = fixture(t);
  const before = await f.reviews.capture();
  const names = ['__proto__', 'constructor', 'toString'];
  for (const name of names) f.save(name, `Added ${name}\n`);
  const result = await f.reviews.finish(before, review());
  assert.deepEqual(result.files.map(file => [file.path, file.status]).sort(), names.map(name => [name, 'added']).sort());
  for (const name of names) {
    assert.ok((await f.reviews.diff(result, name)).diff.includes(`+Added ${name}`));
    assert.deepEqual(await f.reviews.restore(result, name), { ok: true });
    assert.equal(existsSync(join(f.workspace, name)), false);
  }
});

test('turn capture never rewrites a literal backslash filename into a different nested path', async t => {
  const f = fixture(t);
  f.save('literal\\file.txt', 'literal filename\n');
  const snapshot = await f.reviews.capture();
  assert.equal(Object.hasOwn(snapshot.files, 'literal/file.txt'), false);
  // The workspace file API rejects backslash paths, so review must omit them.
  assert.equal(Object.hasOwn(snapshot.files, 'literal\\file.txt'), false);
  assert.equal(snapshot.truncated, true);
});

test('turn restore rejects file and directory symlinks that lead outside the project', async t => {
  const f = fixture(t);
  f.save('changed.txt', 'before\n'); f.save('folder/deleted.txt', 'restore me\n'); const before = await f.reviews.capture();
  f.save('changed.txt', 'turn edit\n'); f.remove('folder/deleted.txt'); const result = await f.reviews.finish(before, review());
  const outside = join(f.directory, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'changed.txt'), 'turn edit\n');
  unlinkSync(join(f.workspace, 'changed.txt')); symlinkSync(join(outside, 'changed.txt'), join(f.workspace, 'changed.txt'));
  f.remove('folder'); symlinkSync(outside, join(f.workspace, 'folder'));
  await assert.rejects(f.reviews.restore(result, 'changed.txt'));
  await assert.rejects(f.reviews.restore(result, 'folder/deleted.txt'));
  assert.equal(readFileSync(join(outside, 'changed.txt'), 'utf8'), 'turn edit\n');
  assert.equal(existsSync(join(outside, 'deleted.txt')), false);
});

test('deleted-file restore rejects a former parent replaced with a Git-internal symlink', async t => {
  const f = fixture(t);
  f.save('.git/config', 'git config\n'); f.save('folder/config.worktree', 'unrelated project text\n'); const before = await f.reviews.capture();
  f.remove('folder/config.worktree'); const result = await f.reviews.finish(before, review());
  f.remove('folder'); symlinkSync(join(f.workspace, '.git'), join(f.workspace, 'folder'));
  await assert.rejects(f.reviews.restore(result, 'folder/config.worktree'), status(403));
  assert.equal(existsSync(join(f.workspace, '.git/config.worktree')), false);
  assert.equal(f.read('.git/config'), 'git config\n');
});

test('deleted-file restore reports a preservation conflict when its parent was removed', async t => {
  const f = fixture(t);
  f.save('folder/deleted.txt', 'before deletion\n'); const before = await f.reviews.capture();
  f.remove('folder'); const result = await f.reviews.finish(before, review());
  await assert.rejects(f.reviews.restore(result, 'folder/deleted.txt'), status(409));
  assert.equal(existsSync(join(f.workspace, 'folder')), false);
});

test('missing or corrupt immutable snapshots fail before creating a deleted file', async t => {
  for (const missing of [false, true]) {
    const f = fixture(t);
    f.save('deleted.txt', 'before deletion\n'); const before = await f.reviews.capture();
    f.remove('deleted.txt'); const result = await f.reviews.finish(before, review());
    const blob = join(f.dataDir, 'review-blobs', revision('before deletion\n'));
    if (missing) unlinkSync(blob); else writeFileSync(blob, 'corrupt snapshot\n');
    await assert.rejects(f.reviews.restore(result, 'deleted.txt'), status(409));
    assert.equal(existsSync(join(f.workspace, 'deleted.txt')), false);
  }
});

test('turn diff and restore are scoped to changed paths in the requested review', async t => {
  const f = fixture(t);
  f.save('changed.txt', 'before\n'); f.save('unchanged.txt', 'same\n'); const before = await f.reviews.capture();
  f.save('changed.txt', 'after\n'); const result = await f.reviews.finish(before, review());
  for (const path of ['unchanged.txt', '../outside.txt', '/etc/passwd', '.git/config', 'folder/../changed.txt']) {
    await assert.rejects(f.reviews.diff(result, path), status(404));
    await assert.rejects(f.reviews.restore(result, path), status(404));
  }
  const otherReview = { ...result, id: randomUUID() };
  await assert.rejects(f.reviews.diff(otherReview, 'changed.txt'), status(404));
  await assert.rejects(f.reviews.restore(otherReview, 'changed.txt'), status(404));
  assert.equal(f.read('changed.txt'), 'after\n');
});
