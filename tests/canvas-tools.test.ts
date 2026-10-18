import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ArtifactFiles } from '../src/server/artifacts.js';
import { CanvasTools } from '../src/server/canvas-tools.js';
import { Store } from '../src/server/store.js';
import type { Artifact } from '../src/shared/types.js';

function body(response: Awaited<ReturnType<CanvasTools['call']>>) {
  assert.equal(response.contentItems[0]?.type, 'inputText');
  return JSON.parse(response.contentItems[0].text);
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'canvagent-tools-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const store = new Store(join(directory, 'data'));
  const artifactFiles = new ArtifactFiles(workspace, join(directory, 'artifacts'));
  const events: { result: any; actor: string }[] = [];
  let sessionId = 'session-1';
  const makeTools = (capture: ConstructorParameters<typeof CanvasTools>[0]['capture'] = async () => {
    throw new Error('No browser canvas is connected.');
  }) => new CanvasTools({
    store, artifactFiles, sessionId: () => sessionId,
    changed: (result, actor) => events.push({ result, actor }), capture,
  });
  t.after(() => { store.close(); return rm(directory, { recursive: true, force: true }); });
  return { store, artifactFiles, workspace, events, makeTools, tools: makeTools(), setSession: (value: string) => { sessionId = value; } };
}

test('agent drawing creates editable native elements and retries exactly once after tool recreation', async t => {
  const { tools, store, makeTools, events } = await fixture(t);
  const request = { requestId: 'draw-1', observedBoardRevision: 0, operations: [
    { kind: 'create', elementId: 'box', shape: 'rectangle', x: 10, y: 20, width: 200, height: 100 },
    { kind: 'create', elementId: 'label', shape: 'text', x: 20, y: 30, text: 'Editable note' },
    { kind: 'create', elementId: 'arrow', shape: 'arrow', x: 210, y: 70, width: 100 },
  ] };
  const first = await tools.call('apply_canvas_ops', request);
  assert.equal(first.success, true);
  const applied = body(first);
  assert.equal(applied.ok, true);
  const board = store.board();
  assert.equal(board.revision, 1);
  assert.deepEqual(board.elements.map(element => element.type), ['rectangle', 'text', 'arrow']);
  assert.equal(board.elements[1].text, 'Editable note');
  assert.equal(board.elements[1].originalText, 'Editable note');
  assert.equal(board.elements[1].locked, false);
  assert.deepEqual(board.elements[2].points, [[0, 0], [100, 0]]);
  assert.equal(board.metadata.label.actor, 'agent:session-1');
  assert.deepEqual(await makeTools().call('apply_canvas_ops', request), first);
  assert.deepEqual(store.board(), board);
  assert.equal(events.length, 1);
  const reused = body(await tools.call('apply_canvas_ops', { ...request, operations: [{ ...request.operations[0], x: 999 }] }));
  assert.equal(reused.ok, false);
  assert.equal(reused.code, 'IDEMPOTENCY_KEY_REUSED');
  assert.deepEqual(store.board(), board);
});

test('read returns service revisions and stale agent edits preserve newer human work', async t => {
  const { tools, store, events } = await fixture(t);
  body(await tools.call('apply_canvas_ops', { requestId: 'initial', observedBoardRevision: 0, operations: [{ kind: 'create', elementId: 'note', shape: 'text', text: 'Agent draft' }] }));
  const observed = body(await tools.call('read_canvas', { scope: 'elements', elementIds: ['note', 'missing'] }));
  assert.equal(observed.revision, 1);
  assert.equal(observed.elements[0].revision, 1);
  assert.deepEqual(observed.missingIds, ['missing']);
  const human = store.mutate({ requestId: 'human-edit', observedBoardRevision: 1, operations: [{ kind: 'update', elementId: 'note', expectedRevision: 1, patch: { text: 'User correction', originalText: 'User correction' } }] }, 'user');
  assert.equal(human.ok, true);
  const before = store.board();
  const attempted = body(await tools.call('apply_canvas_ops', { requestId: 'stale-edit', observedBoardRevision: observed.revision, operations: [{ kind: 'update', elementId: 'note', expectedRevision: observed.elements[0].revision, text: 'Outdated answer' }] }));
  assert.equal(attempted.ok, false);
  assert.equal(attempted.code, 'CONFLICT');
  assert.equal(attempted.conflicts[0].currentElement.text, 'User correction');
  assert.deepEqual(store.board(), before);
  assert.equal(events.length, 1);
});

test('a lost mutation response can be retried without redrawing or changing native random fields', async t => {
  const { tools, store, makeTools } = await fixture(t);
  const mutate = store.mutate.bind(store);
  let loseNextResponse = true;
  store.mutate = (command, actor) => {
    const result = mutate(command, actor);
    if (loseNextResponse) {
      loseNextResponse = false;
      throw new Error('Simulated lost response after durable commit.');
    }
    return result;
  };
  const request = { requestId: 'recover-drawing', observedBoardRevision: 0, operations: [{ kind: 'create', shape: 'rectangle', x: 120, y: 90 }] };
  const lost = await tools.call('apply_canvas_ops', request);
  assert.equal(lost.success, false);
  assert.match(body(lost).error, /lost response/);
  const committed = store.board();
  assert.equal(committed.elements.length, 1);
  const recovered = body(await makeTools().call('apply_canvas_ops', request));
  assert.equal(recovered.ok, true);
  assert.deepEqual(store.board(), committed);
});

test('agent text updates retain native originalText and advance the service revision', async t => {
  const { tools, store } = await fixture(t);
  await tools.call('apply_canvas_ops', { requestId: 'note-create', observedBoardRevision: 0, operations: [{ kind: 'create', elementId: 'note', shape: 'text', text: 'Short' }] });
  const updated = body(await tools.call('apply_canvas_ops', { requestId: 'note-edit', observedBoardRevision: 1, operations: [{ kind: 'update', elementId: 'note', expectedRevision: 1, text: 'Longer\neditable note' }] }));
  assert.equal(updated.ok, true);
  const note = store.board().elements[0];
  assert.equal(note.originalText, 'Longer\neditable note');
  assert.equal(note.height, 50);
  assert.equal(store.board().metadata.note.revision, 2);
});

test('capture fails honestly when no browser is connected', async t => {
  const { tools } = await fixture(t);
  const result = await tools.call('capture_region', {});
  assert.equal(result.success, false);
  assert.match(body(result).error, /No browser canvas is connected/);
  assert.equal(result.contentItems.some(item => item.type === 'inputImage'), false);
});

test('capture sends committed state and requested bounds and returns actual image content', async t => {
  const { makeTools, store } = await fixture(t);
  const region = { x: 10, y: 20, width: 300, height: 200 };
  const dataURL = 'data:image/png;base64,iVBORw0KGgo=';
  let calls = 0;
  const tools = makeTools(async (board, requested) => {
    calls++;
    assert.deepEqual(board, store.board());
    assert.deepEqual(requested, region);
    return { dataURL, bounds: region, revision: board.revision };
  });
  const result = await tools.call('capture_region', { region });
  assert.equal(result.success, true);
  assert.equal(calls, 1);
  assert.deepEqual(body(result), { revision: 0, bounds: region });
  assert.deepEqual(result.contentItems[1], { type: 'inputImage', imageUrl: dataURL });
});

test('publication and attachment preserve bytes, link the board, and return the same retry response', async t => {
  const { tools, store, artifactFiles, workspace, events } = await fixture(t);
  const bytes = Buffer.from('# A generated report\nActual downloadable output.\n');
  await writeFile(join(workspace, 'report.md'), bytes);
  const publish = { requestId: 'publish-report', sourcePath: 'report.md', title: 'Design report' };
  const published = await tools.call('publish_artifact', publish);
  assert.equal(published.success, true);
  const artifact = body(published) as Artifact;
  assert.deepEqual(await tools.call('publish_artifact', publish), published);
  assert.equal(store.get<Artifact[]>('artifacts')!.length, 1);
  await rm(join(workspace, 'report.md'));
  assert.deepEqual(await artifactFiles.bytes(artifact), bytes);
  const attach = { requestId: 'attach-report', artifactId: artifact.id, x: 350, y: 400 };
  const attached = await tools.call('attach_artifact', attach);
  assert.equal(body(attached).ok, true);
  assert.equal(body(attached).artifactId, artifact.id);
  const element = store.board().elements[0];
  assert.equal(element.type, 'text');
  assert.match(element.text, /Design report/);
  assert.equal(element.link, `/api/artifacts/${artifact.id}`);
  assert.equal(element.customData.canvagent.artifactId, artifact.id);
  assert.deepEqual(await tools.call('attach_artifact', attach), attached);
  assert.equal(store.board().elements.length, 1);
  assert.equal(store.board().revision, 1);
  assert.equal(events.length, 1);
});

test('published raster bytes become a native image referencing retained file data', async t => {
  const { tools, store, workspace } = await fixture(t);
  // A complete 1x1 PNG, rather than a fabricated reference to nonexistent bytes.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(workspace, 'pixel.png'), png);
  const artifact = body(await tools.call('publish_artifact', { requestId: 'publish-png', sourcePath: 'pixel.png', title: 'Preview' }));
  const attached = body(await tools.call('attach_artifact', { requestId: 'attach-png', artifactId: artifact.id, x: 10, y: 20, width: 120 }));
  assert.equal(attached.ok, true);
  const board = store.board();
  const image = board.elements[0];
  assert.equal(image.type, 'image');
  assert.equal(image.width, 120);
  assert.equal(image.height, 120, 'The square image retains its source aspect ratio.');
  assert.equal(image.customData.canvagent.artifactId, artifact.id);
  assert.equal(image.fileId, artifact.sha256);
  assert.equal(board.files[image.fileId].mimeType, 'image/png');
  assert.equal(board.files[image.fileId].dataURL, `data:image/png;base64,${png.toString('base64')}`);
});

test('resizing an agent arrow updates its editable point geometry', async t => {
  const { tools, store } = await fixture(t);
  const created = body(await tools.call('apply_canvas_ops', { requestId: 'arrow-create', observedBoardRevision: 0, operations: [{ kind: 'create', elementId: 'arrow', shape: 'arrow', width: 100, height: 50 }] }));
  assert.equal(created.ok, true);
  const updated = body(await tools.call('apply_canvas_ops', { requestId: 'arrow-resize', observedBoardRevision: 1, operations: [{ kind: 'update', elementId: 'arrow', expectedRevision: 1, width: 300, height: 150 }] }));
  assert.equal(updated.ok, true);
  const arrow = store.board().elements[0];
  assert.equal(arrow.width, 300);
  assert.equal(arrow.height, 150);
  assert.deepEqual(arrow.points, [[0, 0], [300, 150]]);
});

test('independent sessions can reuse a request ID without sharing mutation receipts', async t => {
  const { tools, store, setSession } = await fixture(t);
  const operations = [{ kind: 'create', shape: 'rectangle', x: 10, y: 20 }];
  const first = body(await tools.call('apply_canvas_ops', { requestId: 'first-drawing', observedBoardRevision: 0, operations }));
  assert.equal(first.ok, true);
  setSession('session-2');
  const second = body(await tools.call('apply_canvas_ops', { requestId: 'first-drawing', observedBoardRevision: 1, operations }));
  assert.equal(second.ok, true);
  assert.equal(store.board().elements.length, 2);
  assert.notEqual(second.changedElements[0].id, first.changedElements[0].id);
});

test('concurrent retries of a publication create one durable artifact', async t => {
  const { tools, store, workspace } = await fixture(t);
  await writeFile(join(workspace, 'report.txt'), 'Actual output');
  const input = { requestId: 'concurrent-publication', sourcePath: 'report.txt', title: 'Report' };
  const [first, second] = await Promise.all([tools.call('publish_artifact', input), tools.call('publish_artifact', input)]);
  assert.equal(first.success, true);
  assert.deepEqual(second, first);
  assert.equal(store.get<Artifact[]>('artifacts')!.length, 1);
});
