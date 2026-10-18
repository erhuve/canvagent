import { createHash, randomInt } from 'node:crypto';
import { z } from 'zod';
import { imageSize } from 'image-size';
import type { Store } from './store.js';
import type { ArtifactFiles } from './artifacts.js';
import type { Artifact } from '../shared/types.js';

const id = z.string().min(1).max(160);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const positive = z.number().finite().min(1).max(10000);
const regionSchema = z.object({ x: coordinate, y: coordinate, width: positive, height: positive });
export type Region = z.infer<typeof regionSchema>;
const fields = {
  x: coordinate.optional(), y: coordinate.optional(), width: positive.optional(), height: positive.optional(),
  text: z.string().max(10000).optional(), fontSize: z.number().min(12).max(120).optional(),
  strokeColor: z.string().max(50).optional(), backgroundColor: z.string().max(50).optional(),
};
const applySchema = z.object({
  requestId: id, observedBoardRevision: z.number().int().nonnegative(),
  operations: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('create'), elementId: id.optional(), shape: z.enum(['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line']), ...fields }),
    z.object({ kind: z.literal('update'), elementId: id, expectedRevision: z.number().int().nonnegative(), ...fields }),
    z.object({ kind: z.literal('delete'), elementId: id, expectedRevision: z.number().int().nonnegative() }),
  ])).min(1).max(100),
});
const readSchema = z.object({ scope: z.enum(['overview', 'elements', 'region', 'changes']).default('overview'), elementIds: z.array(id).max(200).optional(), region: regionSchema.optional(), sinceRevision: z.number().int().nonnegative().optional() });
const captureSchema = z.object({ region: regionSchema.optional(), elementIds: z.array(id).max(200).optional() });
const publishSchema = z.object({ requestId: id, sourcePath: z.string().min(1).max(4096), title: z.string().max(240) });
const attachSchema = z.object({ requestId: id, artifactId: id, x: coordinate, y: coordinate, width: positive.optional() });

export function nativeShape(shape: string, input: Record<string, any>, elementId: string): Record<string, any> {
  const base: Record<string, any> = {
    id: elementId, type: shape, x: input.x ?? 80, y: input.y ?? 80,
    width: input.width ?? 240, height: input.height ?? 100, angle: 0,
    strokeColor: input.strokeColor ?? '#334155', backgroundColor: input.backgroundColor ?? 'transparent',
    fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
    groupIds: [], frameId: null, roundness: shape === 'rectangle' ? { type: 3 } : null,
    seed: randomInt(1, 2 ** 30), version: 1, versionNonce: randomInt(1, 2 ** 30),
    isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
    customData: { canvagent: { author: 'agent' } },
  };
  if (shape === 'text') {
    const text = input.text ?? 'Note';
    const fontSize = input.fontSize ?? 20;
    Object.assign(base, {
      text, originalText: text, fontSize, fontFamily: 1, textAlign: 'left', verticalAlign: 'top',
      containerId: null, autoResize: true, lineHeight: 1.25,
      width: input.width ?? Math.max(30, Math.max(...text.split('\n').map((line: string) => line.length)) * fontSize * .62),
      height: input.height ?? Math.max(1, text.split('\n').length) * fontSize * 1.25,
    });
  }
  if (shape === 'line' || shape === 'arrow') Object.assign(base, {
    height: input.height ?? 0, points: [[0, 0], [base.width, input.height ?? 0]],
    startBinding: null, endBinding: null, startArrowhead: null,
    endArrowhead: shape === 'arrow' ? 'arrow' : null, lastCommittedPoint: null,
  });
  return base;
}

function toolSpec(name: string, description: string, schema: z.ZodType) {
  const inputSchema = z.toJSONSchema(schema) as Record<string, unknown>;
  delete inputSchema.$schema;
  return { name, description, inputSchema };
}
export const canvasToolSpecs = [
  toolSpec('read_canvas', 'Inspect the shared canvas. Returns current committed objects with IDs, coordinates, text and service revisions. Read before describing or updating the board. Scope overview returns a bounded overview; elements and region focus the result.', readSchema),
  toolSpec('capture_region', 'See a PNG of the current committed canvas or selected region. Use this for sketches, screenshots, handwriting and visual claims. Returns image content. Requires the browser canvas to be connected.', captureSchema),
  toolSpec('apply_canvas_ops', 'Draw directly on the shared canvas with editable text, shapes and unbound arrows. Use a unique requestId. Updates and deletes require the service expectedRevision returned by read_canvas. Batch related edits. Do not replace human content unnecessarily.', applySchema),
  toolSpec('publish_artifact', 'Publish a generated file from this project workspace into durable managed storage. Returns an artifactId for attach_artifact. Use a workspace-relative sourcePath and a unique requestId.', publishSchema),
  toolSpec('attach_artifact', 'Place a published artifact on the board at x,y. Raster images become editable native image previews; other files get a labeled download link. Use the artifactId from publish_artifact.', attachSchema),
];

export class CanvasTools {
  private tail: Promise<void> = Promise.resolve();
  constructor(private options: {
    store: Store;
    artifactFiles: ArtifactFiles;
    sessionId: () => string | undefined;
    changed: (result: any, actor: string) => void;
    capture: (board: any, region?: Region) => Promise<{ dataURL: string; bounds: Region; revision: number }>;
  }) {}

  call(name: string, raw: unknown): Promise<{ contentItems: any[]; success: boolean }> {
    const call = this.tail.then(() => this.execute(name, raw));
    this.tail = call.then(() => {}, () => {});
    return call;
  }
  private async execute(name: string, raw: unknown): Promise<{ contentItems: any[]; success: boolean }> {
    const { store } = this.options;
    try {
      if (name === 'capture_region') {
        const args = captureSchema.parse(raw);
        const board = store.board();
        const elements = board.elements.filter((e: any) => !e.isDeleted && (!args.elementIds?.length || args.elementIds.includes(e.id)));
        const region = args.region ?? boundsOf(elements);
        const capture = await this.options.capture(board, region);
        return { success: true, contentItems: [
          { type: 'inputText', text: JSON.stringify({ revision: capture.revision, bounds: capture.bounds }) },
          { type: 'inputImage', imageUrl: capture.dataURL },
        ] };
      }
      if (name === 'read_canvas') {
        const args = readSchema.parse(raw);
        const board = store.board();
        let elements = board.elements.filter((e: any) => !e.isDeleted);
        if (args.elementIds?.length) elements = elements.filter((e: any) => args.elementIds!.includes(e.id));
        if (args.region) {
          const r = args.region;
          elements = elements.filter((e: any) => e.x <= r.x + r.width && e.x + e.width >= r.x && e.y <= r.y + r.height && e.y + e.height >= r.y);
        }
        const missingIds = args.elementIds?.filter(elementId => !elements.some((e: any) => e.id === elementId)) ?? [];
        return this.text({ boardId: board.id, revision: board.revision,
          elements: elements.slice(0, 200).map((e: any) => ({
            id: e.id, type: e.type, revision: board.metadata[e.id]?.revision ?? 0,
            x: e.x, y: e.y, width: e.width, height: e.height, text: e.text,
            strokeColor: e.strokeColor, backgroundColor: e.backgroundColor, points: e.points,
            fileId: e.fileId, link: e.link, customData: e.customData,
          })), missingIds, truncated: elements.length > 200,
          requiresRead: args.scope === 'changes' && args.sinceRevision !== board.revision,
          note: args.scope === 'changes' ? 'Returns current objects; detailed historical deltas are not retained. Deleted selected IDs appear in missingIds.' : undefined,
        });
      }
      if (name === 'apply_canvas_ops') {
        const args = applySchema.parse(raw);
        const board = store.board();
        const operations = args.operations.map((op, index) => {
          if (op.kind === 'create') {
            const elementId = op.elementId ?? createHash('sha256').update(`${this.options.sessionId()}:${args.requestId}:${index}`).digest('hex').slice(0, 24);
            return { kind: 'create', elementId, element: nativeShape(op.shape, op, elementId) };
          }
          if (op.kind === 'delete') return op;
          const { kind, elementId, expectedRevision, ...patch } = op;
          const current = board.elements.find((e: any) => e.id === elementId);
          if (patch.text !== undefined && current?.type === 'text') {
            const size = patch.fontSize ?? current.fontSize ?? 20;
            Object.assign(patch, { originalText: patch.text, width: Math.max(30, Math.max(...patch.text.split('\n').map(line => line.length)) * size * .62), height: patch.text.split('\n').length * size * 1.25 });
          }
          if (current && ['line', 'arrow'].includes(current.type) && (patch.width !== undefined || patch.height !== undefined)) {
            Object.assign(patch, { points: current.points.map((point: number[]) => [
              current.width ? point[0] * (patch.width ?? current.width) / current.width : point[0],
              current.height ? point[1] * (patch.height ?? current.height) / current.height : point[1],
            ]) });
          }
          return { kind, elementId, expectedRevision, patch };
        });
        // Native random seeds are generated only on first handling, so cache the
        // semantic request before regenerating it for a retry.
        const key = `tool:${this.options.sessionId() ?? 'session'}:${args.requestId}`;
        const previous = store.get<any>(key);
        const hash = JSON.stringify(args);
        if (previous && previous.hash !== hash) return this.text({ ok: false, code: 'IDEMPOTENCY_KEY_REUSED', message: 'Use a new requestId for different edits.' });
        if (previous?.result) return this.text(previous.result);
        const command = previous?.command ?? { ...args, operations };
        store.set(key, { hash, command });
        const result = store.mutate(command as any, `agent:${this.options.sessionId() ?? 'session'}`);
        store.set(key, { hash, command, result });
        if (result.ok) this.options.changed(result, 'agent');
        return this.text(result);
      }
      if (name === 'publish_artifact') {
        const args = publishSchema.parse(raw);
        const key = `publish:${this.options.sessionId()}:${args.requestId}`;
        const previous = store.get<any>(key);
        if (previous) {
          if (previous.input !== JSON.stringify(args)) throw new Error('Request ID already used for another publication.');
          return this.text(previous.artifact);
        }
        const artifact = await this.options.artifactFiles.publish(args.sourcePath, args.title, this.options.sessionId());
        const artifacts = store.get<Artifact[]>('artifacts') ?? [];
        store.set('artifacts', [...artifacts, artifact]);
        store.set(key, { input: JSON.stringify(args), artifact });
        return this.text(artifact);
      }
      if (name === 'attach_artifact') {
        const args = attachSchema.parse(raw);
        const key = `attach:${this.options.sessionId()}:${args.requestId}`;
        const previous = store.get<any>(key);
        if (previous) {
          if (previous.input !== JSON.stringify(args)) throw new Error('Request ID already used for another attachment.');
          return this.text(previous.result);
        }
        const artifact = (store.get<Artifact[]>('artifacts') ?? []).find(a => a.id === args.artifactId);
        if (!artifact) throw new Error('Publish the file first, then use its artifactId.');
        const bytes = await this.options.artifactFiles.bytes(artifact);
        const elementId = createHash('sha256').update(`artifact:${this.options.sessionId()}:${args.requestId}`).digest('hex').slice(0, 24);
        const element = nativeShape('text', { text: `↗ ${artifact.title}`, x: args.x, y: args.y }, elementId);
        if (['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(artifact.mimeType)) {
          const fileId = artifact.sha256;
          store.saveFiles({ [fileId]: { id: fileId, mimeType: artifact.mimeType, dataURL: `data:${artifact.mimeType};base64,${bytes.toString('base64')}`, created: Date.now() } });
          const dimensions = imageSize(bytes);
          const width = args.width ?? Math.min(dimensions.width, 640);
          Object.assign(element, { type: 'image', fileId, width, height: width * dimensions.height / dimensions.width, scale: [1, 1], status: 'saved', crop: null, roundness: null });
        }
        element.link = `/api/artifacts/${artifact.id}`;
        element.customData = { canvagent: { artifactId: artifact.id, author: 'agent' } };
        const pending = store.get<any>(`${key}:command`);
        const command = pending ?? { requestId: args.requestId, observedBoardRevision: store.board().revision, operations: [{ kind: 'create', elementId, element }] };
        store.set(`${key}:command`, command);
        const result = store.mutate(command, `agent:${this.options.sessionId() ?? 'session'}`);
        const response = { ...result, artifactId: artifact.id };
        store.set(key, { input: JSON.stringify(args), result: response });
        if (result.ok) this.options.changed(result, 'agent');
        return this.text(response);
      }
      throw new Error(`Unknown canvas tool: ${name}`);
    } catch (error) {
      return { success: false, contentItems: [{ type: 'inputText', text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }] };
    }
  }
  private text(value: unknown) { return { success: (value as any)?.ok !== false, contentItems: [{ type: 'inputText', text: JSON.stringify(value) }] }; }
}

export function boundsOf(elements: any[]): Region {
  if (!elements.length) return { x: 0, y: 0, width: 1000, height: 700 };
  const x = Math.min(...elements.map(e => e.x)) - 32;
  const y = Math.min(...elements.map(e => e.y)) - 32;
  const width = Math.max(...elements.map(e => e.x + e.width)) - x + 32;
  const height = Math.max(...elements.map(e => e.y + e.height)) - y + 32;
  if (width > 10000 || height > 10000) throw new Error('Canvas region is too large. Select a smaller region or provide bounds.');
  return { x, y, width: Math.max(width, 1), height: Math.max(height, 1) };
}
