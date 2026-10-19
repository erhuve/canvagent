import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ArtifactFiles } from '../src/server/artifacts.js';
import { CanvasTools, canvasToolSpecs } from '../src/server/canvas-tools.js';
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

test('arbitrary freehand strokes retain pressure, grouping, world geometry and retry identity', async t => {
  const { tools, store, makeTools, events } = await fixture(t);
  const points = [[10, -5], [-30, 25], [0, 80], [45, -10]];
  const request = { requestId: 'freehand', observedBoardRevision: 0, operations: [{ kind: 'create', elementId: 'stroke', shape: 'freedraw', x: 120, y: 200,
    points, pressures: [.2, .7, 1, .3], strokeColor: '#a04080', strokeWidth: 5, opacity: 80, groupIds: ['drawing'] }] };
  const result = await tools.call('apply_canvas_ops', request);
  assert.equal(result.success, true);
  const stroke = store.board().elements[0];
  assert.equal(stroke.type, 'freedraw');
  assert.equal(stroke.locked, false);
  assert.deepEqual(stroke.points.map(([x, y]: number[]) => [x + stroke.x, y + stroke.y]), points.map(([x, y]) => [x + 120, y + 200]));
  assert.deepEqual([stroke.x, stroke.y, stroke.width, stroke.height], [130, 195, 75, 90]);
  assert.deepEqual(stroke.pressures, [.2, .7, 1, .3]);
  assert.equal(stroke.simulatePressure, false);
  assert.equal(stroke.strokeWidth, 5);
  assert.equal(stroke.opacity, 80);
  assert.deepEqual(stroke.groupIds, ['drawing']);
  const read = body(await tools.call('read_canvas', { elementIds: ['stroke'] })).elements[0];
  assert.deepEqual(read.pressures, stroke.pressures);
  assert.equal(read.strokeWidth, 5);
  assert.deepEqual(read.groupIds, ['drawing']);
  assert.deepEqual(await makeTools().call('apply_canvas_ops', request), result);
  assert.equal(events.length, 1);
});

test('freehand point replacement resets pressure safely, resizing preserves its shape, and undo retains human edits', async t => {
  const { tools, store } = await fixture(t);
  assert.equal((await tools.call('apply_canvas_ops', { requestId: 'start-stroke', observedBoardRevision: 0, operations: [
    { kind: 'create', elementId: 'stroke', shape: 'freedraw', points: [[0, 0], [30, -20], [60, 40]], pressures: [.3, .8, .1] },
  ] })).success, true);
  const original = store.board().elements[0];
  const replaced = body(await tools.call('apply_canvas_ops', { requestId: 'replace-stroke', observedBoardRevision: 1, operations: [
    { kind: 'update', elementId: 'stroke', expectedRevision: 1, points: [[0, 0], [-10, -20], [20, 40], [30, 20]], strokeWidth: 4 },
  ] }));
  assert.equal(replaced.ok, true);
  let stroke = store.board().elements[0];
  assert.deepEqual(stroke.pressures, []);
  assert.equal(stroke.simulatePressure, true);
  const resized = body(await tools.call('apply_canvas_ops', { requestId: 'resize-stroke', observedBoardRevision: 2, operations: [
    { kind: 'update', elementId: 'stroke', expectedRevision: 2, width: 80, height: 120, x: 200, y: 250 },
  ] }));
  assert.equal(resized.ok, true);
  stroke = store.board().elements[0];
  assert.deepEqual(stroke.points, [[0, 0], [-20, -40], [40, 80], [60, 40]]);
  assert.deepEqual([stroke.x, stroke.y, stroke.width, stroke.height], [200, 250, 80, 120]);
  assert.equal(store.mutate({ requestId: 'human-colour', observedBoardRevision: 3, operations: [{ kind: 'update', elementId: 'stroke', expectedRevision: 3, patch: { strokeColor: '#225500' } }] }, 'human').ok, true);
  const before = store.board();
  const stale = body(await tools.call('apply_canvas_ops', { requestId: 'stale-stroke', observedBoardRevision: 3, operations: [{ kind: 'update', elementId: 'stroke', expectedRevision: 3, points: [[0, 0], [5, 5]] }] }));
  assert.equal(stale.code, 'CONFLICT');
  assert.equal(store.undo(resized.mutationId, 'undo-resize', 'human').ok, false);
  assert.deepEqual(store.board(), before);
  assert.notDeepEqual(stroke.points, original.points);
  assert.equal(store.mutate({ requestId: 'human-flatten', observedBoardRevision: 4, operations: [{ kind: 'update', elementId: 'stroke', expectedRevision: 4, patch: { points: [[0, 0], [0, 50]], width: 0, height: 50 } }] }, 'human').ok, true);
  const flattened = store.board();
  const retry = body(await tools.call('apply_canvas_ops', { requestId: 'resize-stroke', observedBoardRevision: 2, operations: [
    { kind: 'update', elementId: 'stroke', expectedRevision: 2, width: 80, height: 120, x: 200, y: 250 },
  ] }));
  assert.deepEqual(retry, resized, 'A retry returns its original receipt even after a user changes the geometry.');
  assert.deepEqual(store.board(), flattened);
});

test('custom line and arrow paths can form filled outlines and be edited without losing intermediate points', async t => {
  const { tools, store } = await fixture(t);
  const result = await tools.call('apply_canvas_ops', { requestId: 'paths', observedBoardRevision: 0, operations: [
    { kind: 'create', elementId: 'outline', shape: 'line', x: 10, y: 20, points: [[0, 0], [60, -30], [120, 40], [30, 80], [0, 0]], backgroundColor: '#ffcc99', fillStyle: 'hachure', roughness: 0 },
    { kind: 'create', elementId: 'bent-arrow', shape: 'arrow', points: [[0, 0], [25, 50], [100, 30]], strokeStyle: 'dashed' },
  ] });
  assert.equal(result.success, true);
  assert.equal(store.board().elements[0].fillStyle, 'hachure');
  assert.equal(store.board().elements[1].endArrowhead, 'arrow');
  assert.equal(store.board().elements[1].strokeStyle, 'dashed');
  assert.equal((await tools.call('apply_canvas_ops', { requestId: 'resize-path', observedBoardRevision: 1, operations: [{ kind: 'update', elementId: 'bent-arrow', expectedRevision: 1, width: 200, height: 100 }] })).success, true);
  assert.deepEqual(store.board().elements[1].points, [[0, 0], [50, 100], [200, 60]]);
});

test('invalid strokes reject the whole batch instead of leaving partial drawings', async t => {
  const { tools, store } = await fixture(t);
  const invalid = [
    { shape: 'freedraw' }, { shape: 'freedraw', points: [] }, { shape: 'freedraw', points: [[0, 0]] },
    { shape: 'freedraw', points: [[0, 0], [NaN, 2]] },
    { shape: 'freedraw', points: [[0, 0], [10001, 10]] },
    { shape: 'freedraw', points: [[0, 0], [10, 10]], width: 10 },
    { shape: 'freedraw', points: [[0, 0], [10, 10]], pressures: [.5] },
    { shape: 'freedraw', points: [[0, 0], [10, 10]], pressures: [.5, 2] },
    { shape: 'rectangle', points: [[0, 0], [10, 10]] },
    { shape: 'line', points: [[0, 0], [10, 10]], pressures: [.5, .5] },
    { shape: 'freedraw', points: Array.from({ length: 4097 }, (_, i) => [i, i]) },
  ];
  for (const [index, input] of invalid.entries()) {
    const result = await tools.call('apply_canvas_ops', { requestId: `invalid-stroke-${index}`, observedBoardRevision: 0, operations: [
      { kind: 'create', elementId: 'valid', shape: 'rectangle' }, { kind: 'create', ...input },
    ] });
    assert.equal(result.success, false, `Invalid stroke ${index} must fail`);
    assert.equal(store.board().revision, 0);
    assert.equal(store.board().elements.length, 0);
  }
});

test('captures and region reads include negative path offsets, rotation and thick strokes', async t => {
  const f = await fixture(t);
  const captureBounds: any[] = [];
  const tools = f.makeTools(async (board, region) => { captureBounds.push(region); return { revision: board.revision, bounds: region!, dataURL: 'data:image/png;base64,aW1hZ2U=' }; });
  assert.equal((await tools.call('apply_canvas_ops', { requestId: 'negative-path', observedBoardRevision: 0, operations: [
    { kind: 'create', elementId: 'stroke', shape: 'freedraw', x: 100, y: 100, points: [[0, 0], [-80, -50], [-50, 20]], strokeWidth: 20 },
  ] })).success, true);
  const read = body(await tools.call('read_canvas', { region: { x: 18, y: 48, width: 5, height: 5 } }));
  assert.equal(read.elements[0].id, 'stroke');
  assert.equal((await tools.call('capture_region', { elementIds: ['stroke'] })).success, true);
  assert.deepEqual(captureBounds[0], { x: -20, y: 10, width: 160, height: 150 });
  assert.equal((await tools.call('apply_canvas_ops', { requestId: 'rotate-path', observedBoardRevision: 1, operations: [{ kind: 'update', elementId: 'stroke', expectedRevision: 1, angle: Math.PI / 2 }] })).success, true);
  await tools.call('capture_region', { elementIds: ['stroke'] });
  assert.equal(captureBounds[1].width, 150);
  assert.equal(captureBounds[1].height, 160);
});

test('horizontal and vertical freehand strokes keep zero dimensions without invented geometry', async t => {
  const { tools, store } = await fixture(t);
  assert.equal((await tools.call('apply_canvas_ops', { requestId: 'flat-strokes', observedBoardRevision: 0, operations: [
    { kind: 'create', shape: 'freedraw', elementId: 'horizontal', points: [[0, 0], [-50, 0], [100, 0]] },
    { kind: 'create', shape: 'freedraw', elementId: 'vertical', points: [[0, 0], [0, -50], [0, 100]] },
  ] })).success, true);
  assert.equal(store.board().elements[0].height, 0);
  assert.equal(store.board().elements[1].width, 0);
  assert.equal((await tools.call('apply_canvas_ops', { requestId: 'expand-flat-stroke', observedBoardRevision: 1, operations: [{ kind: 'update', elementId: 'vertical', expectedRevision: 1, width: 100 }] })).success, false);
  const schema = canvasToolSpecs.find(tool => tool.name === 'apply_canvas_ops')!.inputSchema as any;
  const create = schema.properties.operations.items.oneOf.find((entry: any) => entry.properties.kind.const === 'create');
  assert.ok(create.properties.shape.enum.includes('freedraw'));
  assert.ok(create.properties.points.description.includes('offsets'));
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

test('queued canvas requests keep their session attribution and cannot run after the originating turn ends', async t => {
  const f = await fixture(t);
  let release!: () => void;
  let started!: () => void;
  const startedCapture = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const tools = f.makeTools(async board => { started(); await held; return { revision: board.revision, bounds: { x: 0, y: 0, width: 100, height: 100 }, dataURL: 'data:image/png;base64,aW1hZ2U=' }; });
  const capture = tools.call('capture_region', {});
  await startedCapture;
  let active = true;
  const late = tools.call('apply_canvas_ops', { requestId: 'late-stroke', observedBoardRevision: 0, operations: [
    { kind: 'create', shape: 'freedraw', points: [[0, 0], [20, 10]] },
  ] }, { sessionId: 'original-session', isCurrent: () => active });
  active = false; f.setSession('different-session'); release();
  await capture;
  const result = await late;
  assert.equal(result.success, false);
  assert.equal(f.store.board().revision, 0);
});
