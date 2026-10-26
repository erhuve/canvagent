import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ContextAttachments, MAX_ATTACHMENT_TEXT, MAX_IMAGE_BYTES } from '../src/server/context-attachments.ts';
import { Store } from '../src/server/store.ts';
import type { ContextAttachment } from '../src/shared/context.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2XcAAAAASUVORK5CYII=', 'base64');
const dataUrl = (bytes = png, mime = 'image/png') => `data:${mime};base64,${bytes.toString('base64')}`;
const status = (expected: number) => (error: any) => error?.status === expected;

function fixture(t: TestContext) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'canvagent-context-')));
  const workspace = join(directory, 'workspace'), dataDir = join(directory, 'data');
  mkdirSync(workspace);
  const store = new Store(dataDir);
  const board: any = { id: 'board', revision: 3, elements: [{ id: 'one', type: 'rectangle', x: 12, width: 100 }, { id: 'picture', type: 'image', fileId: 'asset' }], files: { asset: { id: 'asset', mimeType: 'image/png', dataURL: 'data:image/png;base64,HUGE', created: 123 } } };
  const sessions = [{ id: 'conversation', title: 'Earlier conversation', messages: [{ role: 'user', text: 'Make it blue', context: [{ text: 'NEVER RECURSE CONTEXT' }] }, { role: 'assistant', text: 'I changed the color.' }, { role: 'system', text: 'PRIVATE RUNTIME METADATA' }] }];
  const artifacts = [{ id: 'artifact', title: 'Result', fileName: 'result.html', mimeType: 'text/html', size: 34, sha256: 'a'.repeat(64), dataURL: 'SECRET ARTIFACT BYTES', storagePath: '/sensitive/path', createdAt: '2026-01-01' }];
  const options = { workspace, dataDir, store, board: () => board, sessions: () => sessions, artifacts: () => artifacts };
  t.after(() => { try { store.close(); } catch { /* A restart test closes its initial connection itself. */ } rmSync(directory, { recursive: true, force: true }); });
  return { directory, workspace, dataDir, store, board, sessions, artifacts, options, context: new ContextAttachments(options) };
}

test('file attachments freeze the exact bounded file selection and revision', async t => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'sample.ts'), 'first\r\nsecond\r\nthird\r\n');
  const attachment = await f.context.add({ kind: 'file', path: './sample.ts', startLine: 2, endLine: 3 });
  assert.equal(attachment.label, 'sample.ts:2-3');
  assert.equal(attachment.path, 'sample.ts');
  assert.equal(attachment.text, 'second\nthird');
  assert.equal(attachment.startLine, 2);
  assert.equal(attachment.endLine, 3);
  assert.equal(attachment.revision, createHash('sha256').update('first\r\nsecond\r\nthird\r\n').digest('hex'));
  writeFileSync(join(f.workspace, 'sample.ts'), 'changed externally');
  assert.equal(f.context.get([attachment.id])[0].text, 'second\nthird');
  attachment.text = 'client mutation';
  assert.equal(f.context.get([attachment.id])[0].text, 'second\nthird');
  const formatted = f.context.format(f.context.get([attachment.id]));
  assert.match(formatted, /user-provided resource data/);
  assert.match(formatted, /second\\nthird/);
  assert.equal(f.context.format([]), '');
});

test('context paths enforce workspace containment including symlinks and line ranges', async t => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'safe.txt'), 'one\ntwo');
  writeFileSync(join(f.directory, 'outside.txt'), 'private');
  symlinkSync(join(f.directory, 'outside.txt'), join(f.workspace, 'escape'));
  symlinkSync(f.directory, join(f.workspace, 'outside-folder'));
  symlinkSync(join(f.workspace, 'safe.txt'), join(f.workspace, 'inside'));
  for (const path of ['../outside.txt', '/etc/passwd', 'C:\\outside.txt', '.git/config']) await assert.rejects(f.context.add({ kind: 'file', path }));
  await assert.rejects(f.context.add({ kind: 'file', path: 'escape' }), status(403));
  await assert.rejects(f.context.add({ kind: 'folder', path: 'outside-folder' }), status(403));
  assert.equal((await f.context.add({ kind: 'file', path: 'inside' })).text, 'one\ntwo');
  for (const [startLine, endLine] of [[0, 1], [-1, 2], [2, 1], [1, 3], [3, 3], [1.5, 2], [NaN, 2]]) {
    await assert.rejects(f.context.add({ kind: 'file', path: 'safe.txt', startLine, endLine }), status(400));
  }
});

test('folder attachments capture a bounded single-directory listing', async t => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, 'nested'));
  mkdirSync(join(f.workspace, '.git'));
  writeFileSync(join(f.workspace, '.git', 'config'), 'private');
  writeFileSync(join(f.workspace, 'nested', 'secret.txt'), 'not recursively read');
  for (let i = 0; i < 252; i++) writeFileSync(join(f.workspace, `file-${String(i).padStart(3, '0')}.txt`), 'file contents');
  const folder = await f.context.add({ kind: 'folder', path: '' });
  assert.equal(folder.label, './');
  assert.equal(folder.truncated, true);
  assert.equal(folder.text!.split('\n').length, 250);
  assert.match(folder.text!, /folder\tnested\//);
  assert.doesNotMatch(folder.text!, /not recursively read|secret.txt|\.git|file contents/);
  writeFileSync(join(f.workspace, 'later.txt'), 'new');
  assert.doesNotMatch(f.context.get([folder.id])[0].text!, /later.txt/);
});

test('conversation, canvas, and artifact attachments snapshot visible resource data', async t => {
  const f = fixture(t);
  const conversation = await f.context.add({ kind: 'conversation', sessionId: 'conversation' });
  assert.equal(conversation.text, 'user: Make it blue\n\nassistant: I changed the color.');
  assert.doesNotMatch(conversation.text!, /PRIVATE|NEVER RECURSE/);
  f.sessions[0].messages[0].text = 'Changed later';
  assert.match(f.context.get([conversation.id])[0].text!, /Make it blue/);
  const canvas = await f.context.add({ kind: 'canvas', elementIds: ['one', 'picture', 'one'] });
  assert.deepEqual(canvas.elementIds, ['one', 'picture']);
  assert.equal(canvas.revision, 3);
  assert.match(canvas.text!, /"x": 12/);
  assert.match(canvas.text!, /image\/png/);
  assert.doesNotMatch(canvas.text!, /dataURL|HUGE/);
  f.board.elements[0].x = 999;
  assert.match(f.context.get([canvas.id])[0].text!, /"x": 12/);
  const artifact = await f.context.add({ kind: 'artifact', artifactId: 'artifact' });
  assert.equal(artifact.label, 'Result');
  assert.match(artifact.text!, /result.html/);
  assert.doesNotMatch(artifact.text!, /SECRET|storagePath|sensitive/);
  await assert.rejects(f.context.add({ kind: 'conversation', sessionId: 'missing' }), status(404));
  await assert.rejects(f.context.add({ kind: 'artifact', artifactId: 'missing' }), status(404));
  await assert.rejects(f.context.add({ kind: 'canvas', elementIds: ['missing'] }), status(404));
  await assert.rejects(f.context.add({ kind: 'canvas', elementIds: [] }), status(400));
});

test('context truncates individual text snapshots and rejects aggregate overflow', async t => {
  const f = fixture(t);
  writeFileSync(join(f.workspace, 'long.txt'), 'x'.repeat(MAX_ATTACHMENT_TEXT + 100));
  const attachments = await Promise.all([1, 2, 3].map(() => f.context.add({ kind: 'file', path: 'long.txt' })));
  assert.equal(attachments[0].text!.length, MAX_ATTACHMENT_TEXT);
  assert.equal(attachments[0].truncated, true);
  assert.equal(f.context.get(attachments.slice(0, 2).map(a => a.id)).length, 2);
  assert.throws(() => f.context.get(attachments.map(a => a.id)), status(413));
  assert.throws(() => f.context.get(Array(13).fill(attachments[0].id)), status(400));
  assert.throws(() => f.context.get(['../../secret']), status(400));
  assert.throws(() => f.context.get(['ctx_00000000-0000-0000-0000-000000000000']), status(404));
});

test('images persist across restart, deduplicate bytes, and expose only managed IDs', async t => {
  const f = fixture(t);
  const first = await f.context.uploadImage({ name: '../../pasted.png', dataUrl: dataUrl() });
  const second = await f.context.uploadImage({ name: 'second.png', dataUrl: dataUrl() });
  assert.equal(first.label, 'pasted.png');
  assert.equal(first.width, 1);
  assert.equal(first.height, 1);
  assert.equal(first.mimeType, 'image/png');
  assert.equal(first.size, png.length);
  assert.equal(first.imageId, second.imageId);
  assert.notEqual(first.id, second.id);
  assert.equal(first.path, undefined);
  assert.doesNotMatch(JSON.stringify(first), /data:|chat-images|workspace/);
  assert.equal(readdirSync(join(f.dataDir, 'chat-images')).length, 1);
  f.store.close();
  const reopened = new Store(f.dataDir);
  try {
    const context = new ContextAttachments({ ...f.options, store: reopened });
    assert.deepEqual(context.get([first.id])[0], first);
    assert.deepEqual(context.image(first.id).bytes, png);
    assert.deepEqual(context.image(first.imageId!).bytes, png);
    assert.deepEqual(context.images(context.get([first.id])), [{ url: dataUrl(), mimeType: 'image/png', name: 'pasted.png' }]);
    const reused = await context.add({ kind: 'image', imageId: first.imageId! });
    assert.equal(reused.imageId, first.imageId);
  } finally { reopened.close(); }
});

test('saved contexts and images are scoped to the project', async t => {
  const f = fixture(t);
  const attachment = await f.context.uploadImage({ name: 'image.png', dataUrl: dataUrl() });
  const otherWorkspace = join(f.directory, 'other-workspace'); mkdirSync(otherWorkspace);
  const other = new ContextAttachments({ ...f.options, workspace: otherWorkspace });
  assert.throws(() => other.get([attachment.id]), status(404));
  assert.throws(() => other.image(attachment.imageId!), status(404));
  assert.throws(() => f.context.image('../../outside'), status(400));
  assert.throws(() => f.context.image('img_../../outside'), status(400));
});

test('workspace image mentions freeze managed image bytes and enforce source containment', async t => {
  const f = fixture(t);
  mkdirSync(join(f.workspace, 'images'));
  writeFileSync(join(f.workspace, 'images', 'design.png'), png);
  const attachment = await f.context.add({ kind: 'file', path: './images/design.png' });
  assert.equal(attachment.kind, 'image');
  assert.equal(attachment.path, 'images/design.png');
  assert.equal(attachment.label, 'images/design.png');
  assert.equal(attachment.revision, attachment.imageId!.slice(4));
  assert.equal(attachment.width, 1);
  writeFileSync(join(f.workspace, 'images', 'design.png'), 'later external change');
  assert.deepEqual(f.context.image(attachment.id).bytes, png);
  assert.equal(f.context.images(f.context.get([attachment.id]))[0].url, dataUrl());
  writeFileSync(join(f.directory, 'outside.png'), png);
  symlinkSync(join(f.directory, 'outside.png'), join(f.workspace, 'outside.png'));
  await assert.rejects(f.context.add({ kind: 'file', path: 'outside.png' }), status(403));
  writeFileSync(join(f.workspace, 'valid.png'), png);
  await assert.rejects(f.context.add({ kind: 'file', path: 'valid.png', startLine: 1 }), status(400));
  writeFileSync(join(f.workspace, 'bogus.png'), '<svg>not a PNG</svg>');
  await assert.rejects(f.context.add({ kind: 'file', path: 'bogus.png' }), status(415));
});

test('image validation rejects unsupported content, MIME spoofing, bad encoding, and oversized dimensions', async t => {
  const f = fixture(t);
  for (const value of [dataUrl(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml'), dataUrl(Buffer.from('plain text')), dataUrl(png, 'image/jpeg'), 'data:image/png;base64,!!!', 'https://example.com/image.png', 'data:image/png;base64,', dataUrl(png.subarray(0, 24))]) {
    await assert.rejects(f.context.uploadImage({ name: 'image.png', dataUrl: value }));
  }
  await assert.rejects(f.context.uploadImage({ name: 'image.png', dataUrl: dataUrl(Buffer.alloc(MAX_IMAGE_BYTES + 1)) }), status(413));
  const huge = Buffer.from(png); huge.writeUInt32BE(100_000, 16); huge.writeUInt32BE(100_000, 20);
  await assert.rejects(f.context.uploadImage({ name: 'huge.png', dataUrl: dataUrl(huge) }), status(413));
  assert.deepEqual(readdirSync(join(f.dataDir, 'chat-images')), []);
});

test('image reads detect corrupt bytes and refuse symlink replacement', async t => {
  const f = fixture(t);
  const image = await f.context.uploadImage({ name: 'image.png', dataUrl: dataUrl() });
  const path = join(f.dataDir, 'chat-images', image.imageId!.slice(4));
  const tampered = Buffer.from(png); tampered[40] ^= 1;
  writeFileSync(path, tampered);
  assert.throws(() => f.context.image(image.imageId!), status(409));
  assert.throws(() => f.context.images(f.context.get([image.id])), status(409));
  await assert.rejects(f.context.uploadImage({ name: 'again.png', dataUrl: dataUrl() }), status(409));
  unlinkSync(path);
  const outside = join(f.directory, 'outside.png'); writeFileSync(outside, png);
  symlinkSync(outside, path);
  assert.throws(() => f.context.image(image.imageId!), status(409));
  assert.deepEqual(readFileSync(outside), png);
});

test('image batches enforce both image count and total bytes', async t => {
  const f = fixture(t);
  const attachments: ContextAttachment[] = [];
  for (let i = 0; i < 7; i++) attachments.push(await f.context.uploadImage({ name: `image-${i}.png`, dataUrl: dataUrl() }));
  assert.equal(f.context.images(f.context.get(attachments.slice(0, 6).map(a => a.id))).length, 6);
  assert.throws(() => f.context.get(attachments.map(a => a.id)), status(413));
  // A legal large ancillary PNG chunk keeps the raster 1×1 while exercising byte limits.
  const extra = Buffer.alloc(7 * 1024 * 1024 + 12); extra.writeUInt32BE(extra.length - 12, 0); extra.write('tEXt', 4);
  const large = Buffer.concat([png.subarray(0, -12), extra, png.subarray(-12)]);
  const largeAttachments: ContextAttachment[] = [];
  for (let i = 0; i < 3; i++) largeAttachments.push(await f.context.uploadImage({ name: `large-${i}.png`, dataUrl: dataUrl(large) }));
  assert.throws(() => f.context.get(largeAttachments.map(a => a.id)), status(413));
});
