import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store, type CanvasElement, type MutationResult } from '../src/server/store.ts';

function fixture(t: { after: (callback: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), 'canvagent-store-'));
  const store = new Store(directory);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, directory };
}

const rectangle = (id: string, extra: Record<string, any> = {}): CanvasElement => ({ id, type: 'rectangle', x: 10, y: 20, width: 100, height: 80, isDeleted: false, version: 1, versionNonce: 11, index: 'a1', customData: { example: true }, ...extra });
function success(result: MutationResult) {
  if (!result.ok) throw new Error(result.message);
  return result;
}
function failure(result: MutationResult, code: string) {
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('Expected a failed mutation.');
  assert.equal(result.code, code);
  return result;
}
function create(store: Store, id: string, extra: Record<string, any> = {}) {
  return success(store.mutate({ requestId: `create-${id}`, observedBoardRevision: store.board().revision, operations: [{ kind: 'create', elementId: id, element: rectangle(id, extra) }] }, 'user'));
}

test('native elements, separate revisions, and generic state survive reopening', t => {
  const { store, directory } = fixture(t);
  const original = rectangle('box', { frameId: null, boundElements: [], version: 7, index: 'a9', unknownEditorField: { retained: ['yes'] } });
  success(store.mutate({ requestId: 'native', observedBoardRevision: 0, operations: [{ kind: 'create', elementId: 'box', element: original }] }, 'user'));
  store.set('session', { providerThreadId: 'thread-1', messages: ['hello'] });
  const reopened = new Store(directory);
  try {
    assert.deepEqual(reopened.board(), store.board());
    assert.deepEqual(reopened.board().elements[0], original);
    assert.deepEqual(reopened.board().metadata.box, { revision: 1, actor: 'user' });
    assert.deepEqual(reopened.get('session'), { providerThreadId: 'thread-1', messages: ['hello'] });
    assert.equal(reopened.get('missing'), undefined);
  } finally { reopened.close(); }
});

test('independent human/agent edits accept a stale overall board revision', t => {
  const { store } = fixture(t);
  create(store, 'user-box');
  create(store, 'agent-box');
  success(store.mutate({ requestId: 'human-move', observedBoardRevision: 2, operations: [{ kind: 'update', elementId: 'user-box', expectedRevision: 1, patch: { x: 40, version: 8, versionNonce: 99, index: 'b0' } }] }, 'user'));
  success(store.mutate({ requestId: 'agent-move', observedBoardRevision: 2, operations: [{ kind: 'update', elementId: 'agent-box', expectedRevision: 1, patch: { y: 70 } }] }, 'agent'));
  const board = store.board();
  assert.equal(board.revision, 4);
  assert.equal(board.elements.find(element => element.id === 'user-box')!.x, 40);
  assert.equal(board.elements.find(element => element.id === 'user-box')!.version, 8);
  assert.equal(board.elements.find(element => element.id === 'user-box')!.index, 'b0');
  assert.equal(board.elements.find(element => element.id === 'agent-box')!.y, 70);
  assert.equal(board.elements.find(element => element.id === 'agent-box')!.version, 2);
});

test('a same-object race rejects the entire batch and returns current affected content', t => {
  const { store } = fixture(t);
  create(store, 'box');
  success(store.mutate({ requestId: 'move', observedBoardRevision: 1, operations: [{ kind: 'update', elementId: 'box', expectedRevision: 1, patch: { x: 55 } }] }, 'user'));
  const before = store.board();
  const rejected = failure(store.mutate({ requestId: 'stale', observedBoardRevision: 1, operations: [
    { kind: 'create', elementId: 'note', element: rectangle('note') },
    { kind: 'update', elementId: 'box', expectedRevision: 1, patch: { x: 999 } },
  ] }, 'agent'), 'CONFLICT');
  assert.equal(rejected.conflicts![0].currentRevision, 2);
  assert.equal(rejected.conflicts![0].currentElement!.x, 55);
  assert.deepEqual(store.board(), before);
});

test('duplicate successes and failed request IDs are durable receipts', t => {
  const { store, directory } = fixture(t);
  const command = { requestId: 'once', observedBoardRevision: 0, operations: [{ kind: 'create' as const, elementId: 'box', element: rectangle('box') }] };
  const first = success(store.mutate(command, 'agent'));
  assert.deepEqual(store.mutate(command, 'agent'), first);
  assert.equal(store.board().revision, 1);
  failure(store.mutate({ ...command, observedBoardRevision: 1 }, 'agent'), 'IDEMPOTENCY_KEY_REUSED');
  const invalid = { requestId: 'failed-once', observedBoardRevision: 0, operations: [{ kind: 'update' as const, elementId: 'missing', expectedRevision: 1, patch: { x: 2 } }] };
  const failed = failure(store.mutate(invalid, 'agent'), 'CONFLICT');
  create(store, 'missing');
  assert.deepEqual(store.mutate(invalid, 'agent'), failed);
  const reopened = new Store(directory);
  try {
    assert.deepEqual(reopened.mutate(command, 'agent'), first);
    assert.deepEqual(reopened.mutate(invalid, 'agent'), failed);
    failure(reopened.mutate({ ...invalid, observedBoardRevision: reopened.board().revision }, 'agent'), 'IDEMPOTENCY_KEY_REUSED');
  } finally { reopened.close(); }
});

test('canonical request hashing ignores object key order and request IDs are actor-scoped', t => {
  const { store } = fixture(t);
  const element = rectangle('box');
  const first = store.mutate({ requestId: 'shared', observedBoardRevision: 0, operations: [{ kind: 'create', elementId: 'box', element }] }, 'user');
  assert.deepEqual(store.mutate({ operations: [{ element, elementId: 'box', kind: 'create' }], observedBoardRevision: 0, requestId: 'shared' }, 'user'), first);
  success(store.mutate({ requestId: 'shared', observedBoardRevision: 1, operations: [{ kind: 'create', elementId: 'other', element: rectangle('other') }] }, 'agent'));
});

test('undo restores exact prior fields without lowering native versions or duplicating on retry', t => {
  const { store } = fixture(t);
  create(store, 'box');
  const changed = success(store.mutate({ requestId: 'change', observedBoardRevision: 1, operations: [{ kind: 'update', elementId: 'box', expectedRevision: 1, patch: { x: 99, introducedByEdit: 'remove me' } }] }, 'agent'));
  const undone = success(store.undo(changed.mutationId, 'undo-change', 'user'));
  const element = store.board().elements[0];
  assert.equal(element.x, 10);
  assert.equal(Object.hasOwn(element, 'introducedByEdit'), false);
  assert.equal(element.version, 3);
  assert.equal(element.index, 'a1');
  assert.deepEqual(store.undo(changed.mutationId, 'undo-change', 'user'), undone);
  assert.equal(store.board().revision, 3);
  failure(store.undo(changed.mutationId, 'undo-again', 'user'), 'CONFLICT');
});

test('undo conflicts preserve later human edits while unrelated later edits survive', t => {
  const { store } = fixture(t);
  const box = create(store, 'box');
  create(store, 'other');
  success(store.undo(box.mutationId, 'undo-box', 'user'));
  assert.equal(store.board().elements.find(element => element.id === 'box')!.isDeleted, true);
  assert.equal(store.board().elements.find(element => element.id === 'other')!.isDeleted, false);
  const moved = success(store.mutate({ requestId: 'move-other', observedBoardRevision: 3, operations: [{ kind: 'update', elementId: 'other', expectedRevision: 1, patch: { x: 80 } }] }, 'agent'));
  success(store.mutate({ requestId: 'later-human', observedBoardRevision: 4, operations: [{ kind: 'update', elementId: 'other', expectedRevision: 2, patch: { x: 90 } }] }, 'user'));
  const before = store.board();
  failure(store.undo(moved.mutationId, 'stale-undo', 'user'), 'CONFLICT');
  assert.deepEqual(store.board(), before);
});

test('deleted native elements retain tombstones and ordinary create cannot reuse their identity', t => {
  const { store } = fixture(t);
  create(store, 'box');
  const deleted = success(store.mutate({ requestId: 'delete', observedBoardRevision: 1, operations: [{ kind: 'delete', elementId: 'box', expectedRevision: 1 }] }, 'agent'));
  assert.equal(store.board().elements[0].isDeleted, true);
  failure(store.mutate({ requestId: 'reuse', observedBoardRevision: 2, operations: [{ kind: 'create', elementId: 'box', element: rectangle('box') }] }, 'user'), 'CONFLICT');
  success(store.undo(deleted.mutationId, 'restore', 'user'));
  assert.equal(store.board().elements[0].isDeleted, false);
  assert.equal(store.board().metadata.box.revision, 3);
});

test('native human undo can restore the same tombstone; agent and stale restores cannot', t => {
  const { store } = fixture(t);
  create(store, 'box');
  success(store.mutate({ requestId: 'delete-box', observedBoardRevision: 1, operations: [{ kind: 'delete', elementId: 'box', expectedRevision: 1 }] }, 'human'));
  const restore = { requestId: 'native-restore', observedBoardRevision: 2, operations: [{ kind: 'restore' as const, elementId: 'box', expectedRevision: 2, patch: rectangle('box', { version: 3 }) }] };
  failure(store.mutate(restore, 'agent'), 'VALIDATION_FAILED');
  failure(store.mutate({ requestId: 'agent-update', observedBoardRevision: 2, operations: [{ kind: 'update', elementId: 'box', expectedRevision: 2, patch: { isDeleted: false } }] }, 'agent'), 'CONFLICT');
  failure(store.mutate({ ...restore, requestId: 'different-type', operations: [{ ...restore.operations[0], patch: { isDeleted: false, type: 'text' } }] }, 'human'), 'VALIDATION_FAILED');
  const revived = success(store.mutate(restore, 'human'));
  assert.equal(store.board().elements[0].isDeleted, false);
  assert.equal(store.board().elements[0].type, 'rectangle');
  assert.equal(store.board().metadata.box.revision, 3);
  assert.ok(store.board().elements[0].version > 2);
  assert.deepEqual(store.mutate(restore, 'human'), revived);
  success(store.mutate({ requestId: 'delete-again', observedBoardRevision: 3, operations: [{ kind: 'delete', elementId: 'box', expectedRevision: 3 }] }, 'human'));
  failure(store.mutate({ ...restore, requestId: 'stale-restore' }, 'human'), 'CONFLICT');
  assert.equal(store.board().elements[0].isDeleted, true);
});

test('native index edits persist the matching stacking order, including after undo and reopen', t => {
  const { store, directory } = fixture(t);
  create(store, 'bottom', { index: 'a0' });
  create(store, 'middle', { index: 'a1' });
  create(store, 'top', { index: 'a2' });
  const reordered = success(store.mutate({ requestId: 'bring-to-front', observedBoardRevision: 3, operations: [{ kind: 'update', elementId: 'bottom', expectedRevision: 1, patch: { index: 'a3', version: 4, customData: { opaque: 'preserved' } } }] }, 'human'));
  assert.deepEqual(store.board().elements.map(element => element.id), ['middle', 'top', 'bottom']);
  assert.deepEqual(store.board().elements[2].customData, { opaque: 'preserved' });
  const reopened = new Store(directory);
  try { assert.deepEqual(reopened.board().elements.map(element => element.id), ['middle', 'top', 'bottom']); } finally { reopened.close(); }
  success(store.undo(reordered.mutationId, 'undo-reorder', 'human'));
  assert.deepEqual(store.board().elements.map(element => element.id), ['bottom', 'middle', 'top']);
});

test('equal native indices keep stable order; incomplete legacy indices do not invent ordering', t => {
  const { store } = fixture(t);
  create(store, 'first', { index: 'a1' });
  create(store, 'second', { index: 'a1' });
  create(store, 'legacy', { index: undefined });
  assert.deepEqual(store.board().elements.map(element => element.id), ['first', 'second', 'legacy']);
});

test('dependent references are validated atomically and prevent destructive undo', t => {
  const { store } = fixture(t);
  const frame = create(store, 'frame', { type: 'frame' });
  create(store, 'inside', { frameId: 'frame' });
  failure(store.undo(frame.mutationId, 'undo-frame', 'user'), 'CONFLICT');
  const before = store.board();
  failure(store.mutate({ requestId: 'delete-frame', observedBoardRevision: 2, operations: [{ kind: 'delete', elementId: 'frame', expectedRevision: 1 }] }, 'agent'), 'VALIDATION_FAILED');
  assert.deepEqual(store.board(), before);
  success(store.mutate({ requestId: 'delete-both', observedBoardRevision: 2, operations: [
    { kind: 'delete', elementId: 'frame', expectedRevision: 1 },
    { kind: 'delete', elementId: 'inside', expectedRevision: 1 },
  ] }, 'agent'));
});

test('images retain exact managed bytes and metadata after reopening; IDs cannot replace bytes', t => {
  const { store, directory } = fixture(t);
  const bytes = Buffer.from('source image bytes');
  const file = { id: 'image-file', mimeType: 'image/png', created: 123, lastRetrieved: 456, dataURL: `data:image/png;base64,${bytes.toString('base64')}` };
  store.saveFiles({ 'image-file': file });
  assert.deepEqual(store.board().files['image-file'], file);
  create(store, 'image-element', { type: 'image', fileId: 'image-file' });
  const assetNames = readdirSync(join(directory, 'assets'));
  assert.equal(assetNames.length, 1);
  assert.match(assetNames[0], /^[a-f0-9]{64}$/);
  assert.deepEqual(readFileSync(join(directory, 'assets', assetNames[0])), bytes);
  const reopened = new Store(directory);
  try { assert.deepEqual(reopened.board(), store.board()); } finally { reopened.close(); }
  assert.throws(() => store.saveFiles({ 'image-file': { ...file, dataURL: `data:image/png;base64,${Buffer.from('replacement').toString('base64')}` } }), /different bytes/);
  assert.deepEqual(store.board().files['image-file'], file);
  failure(store.mutate({ requestId: 'missing-image', observedBoardRevision: 1, operations: [{ kind: 'create', elementId: 'missing-image', element: rectangle('missing-image', { type: 'image', fileId: 'not-imported' }) }] }, 'agent'), 'VALIDATION_FAILED');
});

test('invalid batches cannot partially commit native scene changes', t => {
  const { store } = fixture(t);
  create(store, 'box');
  const before = store.board();
  failure(store.mutate({ requestId: 'invalid-batch', observedBoardRevision: 1, operations: [
    { kind: 'update', elementId: 'box', expectedRevision: 1, patch: { x: 99 } },
    { kind: 'create', elementId: 'new-box', element: rectangle('wrong-id') },
  ] }, 'agent'), 'VALIDATION_FAILED');
  assert.deepEqual(store.board(), before);
});
