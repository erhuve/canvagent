import { createHash, randomInt, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyBetween } from 'fractional-indexing';

/** Native editor fields are deliberately opaque here; the editor adapter owns their schema. */
export type CanvasElement = { id: string; type: string; isDeleted?: boolean; [key: string]: any };
export type ElementMetadata = { revision: number; actor: string };
export type CanvasFile = { id: string; mimeType: string; dataURL: string; created: number; [key: string]: any };
export type Board = {
  id: string;
  revision: number;
  elements: CanvasElement[];
  files: Record<string, CanvasFile>;
  metadata: Record<string, ElementMetadata>;
};
type SavedBoard = Omit<Board, 'files'>;
export type CanvasOperation =
  | { kind: 'create'; elementId: string; element: Record<string, any> }
  | { kind: 'update'; elementId: string; expectedRevision: number; patch: Record<string, any> }
  | { kind: 'restore'; elementId: string; expectedRevision: number; patch: Record<string, any> }
  | { kind: 'delete'; elementId: string; expectedRevision: number };
export type CanvasMutationCommand = {
  requestId: string;
  observedBoardRevision: number;
  operations: CanvasOperation[];
  boardId?: string;
  schemaVersion?: 1;
};
export type Conflict = {
  elementId: string;
  expectedRevision: number | null;
  currentRevision: number | null;
  currentElement: CanvasElement | null;
};
export type MutationResult =
  | { ok: true; boardRevision: number; mutationId: string; changedElements: CanvasElement[]; metadata: Record<string, ElementMetadata> }
  | { ok: false; boardRevision: number; code: 'CONFLICT' | 'VALIDATION_FAILED' | 'NOT_FOUND' | 'IDEMPOTENCY_KEY_REUSED'; message: string; conflicts?: Conflict[] };
type Mutation = {
  id: string;
  beforeImages: Record<string, CanvasElement | null>;
  afterRevisions: Record<string, number>;
  undoOf?: string;
};

const MAX_ELEMENTS = 10_000;
const MAX_OPERATIONS = 2_000;
const MAX_SCENE_BYTES = 30 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const forbiddenIds = new Set(['__proto__', 'prototype', 'constructor']);
const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !forbiddenIds.has(value);
const revision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().filter(key => (value as any)[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical((value as any)[key])}`).join(',')}}`;
}

/** Bump native bookkeeping only for semantic operations that did not supply editor versions. */
function nativeChange(current: CanvasElement, patch: Record<string, any>, forceNewVersion = false): CanvasElement {
  const result: CanvasElement = { ...current, ...patch, id: current.id };
  if (typeof current.version === 'number' && (forceNewVersion || patch.version === undefined)) {
    result.version = Math.max(current.version, typeof result.version === 'number' ? result.version : 0) + 1;
    result.versionNonce = randomInt(0, 2 ** 31);
    result.updated = Date.now();
  }
  return result;
}

function restoreNative(current: CanvasElement, snapshot: CanvasElement): CanvasElement {
  const restored = clone(snapshot);
  if (typeof current.version === 'number') {
    restored.version = Math.max(current.version, typeof restored.version === 'number' ? restored.version : 0) + 1;
    restored.versionNonce = randomInt(0, 2 ** 31);
    restored.updated = Date.now();
  }
  return restored;
}

function elementReferences(element: CanvasElement): string[] {
  const references = [element.containerId, element.frameId, element.startBinding?.elementId, element.endBinding?.elementId];
  if (Array.isArray(element.boundElements)) references.push(...element.boundElements.map((bound: any) => bound?.id));
  return references.filter((id): id is string => typeof id === 'string');
}

/** Native scene arrays and fractional indices must describe the same stacking order. */
function orderNativeElements(elements: CanvasElement[]): CanvasElement[] {
  const indexed = elements.every(element => {
    if (typeof element.index !== 'string' || !element.index.length) return false;
    try { generateKeyBetween(element.index, null); return true; } catch { return false; }
  });
  return indexed ? elements.toSorted((left, right) => left.index < right.index ? -1 : left.index > right.index ? 1 : 0) : elements;
}

/** One synchronous transaction owns scene, per-element revisions, mutation history, and retry receipts. */
export class Store {
  readonly dataDir: string;
  private readonly db: DatabaseSync;
  private readonly assetDir: string;

  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    this.assetDir = join(this.dataDir, 'assets');
    mkdirSync(this.assetDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(this.dataDir, 'canvagent.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (
        actor TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
        result TEXT NOT NULL, PRIMARY KEY (actor, request_id)
      );
      CREATE TABLE IF NOT EXISTS mutations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, metadata TEXT NOT NULL, storage_name TEXT NOT NULL, sha256 TEXT NOT NULL
      );
    `);
    const initial: SavedBoard = { id: randomUUID(), revision: 0, elements: [], metadata: {} };
    this.db.prepare('INSERT OR IGNORE INTO state (key, value) VALUES (?, ?)').run('board', JSON.stringify(initial));
  }

  close(): void { this.db.close(); }

  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }

  set<T>(key: string, value: T): void {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new Error('Cannot persist undefined; use a JSON value.');
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, encoded);
  }

  board(): Board {
    const files: Record<string, CanvasFile> = {};
    for (const row of this.db.prepare('SELECT id, metadata, storage_name, sha256 FROM files').all() as { id: string; metadata: string; storage_name: string; sha256: string }[]) {
      const metadata = JSON.parse(row.metadata);
      const bytes = readFileSync(join(this.assetDir, row.storage_name));
      if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) throw new Error(`Image bytes are corrupt: ${row.id}`);
      files[row.id] = { ...metadata, dataURL: `data:${metadata.mimeType};base64,${bytes.toString('base64')}` };
    }
    return { ...this.savedBoard(), files };
  }

  /** Store file bytes before a subsequent scene mutation is allowed to refer to them. */
  saveFiles(files: Record<string, CanvasFile>): void {
    if (!object(files) || Object.keys(files).length > 1_000) throw new Error('Invalid image file map.');
    const prepared = Object.entries(files).map(([id, file]) => {
      if (!validId(id) || !object(file) || file.id !== id || typeof file.mimeType !== 'string' || !file.mimeType.startsWith('image/')) throw new Error('Invalid image file.');
      if (typeof file.dataURL !== 'string') throw new Error(`Image ${id} is missing its data URL.`);
      const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(file.dataURL);
      if (!match || match[1] !== file.mimeType || match[2].length > Math.ceil(MAX_FILE_BYTES / 3) * 4) throw new Error(`Invalid or oversized image ${id}.`);
      const bytes = Buffer.from(match[2], 'base64');
      if (!bytes.length || bytes.length > MAX_FILE_BYTES || bytes.toString('base64') !== match[2]) throw new Error(`Invalid image encoding: ${id}.`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const { dataURL: _dataURL, ...metadata } = file;
      return { id, bytes, sha256, metadata, storageName: sha256 };
    });

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const file of prepared) {
        const current = this.db.prepare('SELECT sha256, metadata FROM files WHERE id = ?').get(file.id) as { sha256: string; metadata: string } | undefined;
        if (current && (current.sha256 !== file.sha256 || JSON.parse(current.metadata).mimeType !== file.metadata.mimeType)) throw new Error(`Image ID ${file.id} already refers to different bytes.`);
      }
      for (const file of prepared) {
        const destination = join(this.assetDir, file.storageName);
        if (!existsSync(destination) || createHash('sha256').update(readFileSync(destination)).digest('hex') !== file.sha256) {
          const temporary = join(this.assetDir, `${file.storageName}.${randomUUID()}.tmp`);
          const descriptor = openSync(temporary, 'wx', 0o600);
          try { writeFileSync(descriptor, file.bytes); fsyncSync(descriptor); } finally { closeSync(descriptor); }
          try { renameSync(temporary, destination); } finally { rmSync(temporary, { force: true }); }
        }
        this.db.prepare('INSERT INTO files (id, metadata, storage_name, sha256) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET metadata = excluded.metadata').run(file.id, JSON.stringify(file.metadata), file.storageName, file.sha256);
      }
      if (prepared.length) {
        const directory = openSync(this.assetDir, 'r');
        try { fsyncSync(directory); } finally { closeSync(directory); }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  mutate(command: CanvasMutationCommand, actor: string): MutationResult {
    return this.receipted(command?.requestId, actor, { kind: 'mutate', command }, () => {
      const board = this.savedBoard();
      const fail = (message: string): MutationResult => ({ ok: false, code: 'VALIDATION_FAILED', boardRevision: board.revision, message });
      if (!object(command) || (command.schemaVersion !== undefined && command.schemaVersion !== 1)) return fail('Unsupported mutation schema.');
      if (command.boardId !== undefined && command.boardId !== board.id) return { ok: false, code: 'NOT_FOUND', boardRevision: board.revision, message: 'Board not found.' };
      if (!revision(command.observedBoardRevision) || command.observedBoardRevision > board.revision) return fail('observedBoardRevision must be a committed board revision.');
      if (!Array.isArray(command.operations) || !command.operations.length || command.operations.length > MAX_OPERATIONS) return fail('A mutation needs 1–2000 operations.');
      const seen = new Set<string>();
      const current = new Map(board.elements.map(element => [element.id, element]));
      const conflicts: Conflict[] = [];
      for (const operation of command.operations) {
        if (!object(operation) || !validId(operation.elementId) || seen.has(operation.elementId)) return fail('Every operation must name one distinct valid element ID.');
        seen.add(operation.elementId);
        const existing = current.get(operation.elementId);
        if (operation.kind === 'create') {
          if (!object(operation.element) || operation.element.id !== operation.elementId || typeof operation.element.type !== 'string' || operation.element.isDeleted) return fail('A create needs a live native element with the matching ID and type.');
          if (existing || Object.hasOwn(board.metadata, operation.elementId)) conflicts.push({ elementId: operation.elementId, expectedRevision: null, currentRevision: board.metadata[operation.elementId]?.revision ?? null, currentElement: existing ?? null });
        } else if (operation.kind === 'update' || operation.kind === 'delete' || operation.kind === 'restore') {
          if (!revision(operation.expectedRevision)) return fail('Updates and deletes need a valid expectedRevision.');
          const restoring = operation.kind === 'restore';
          if (restoring && actor !== 'human') return fail('Restore is reserved for human editor history; agent updates cannot revive a deleted object.');
          if (!existing || (restoring ? !existing.isDeleted : existing.isDeleted) || board.metadata[operation.elementId]?.revision !== operation.expectedRevision) conflicts.push({ elementId: operation.elementId, expectedRevision: operation.expectedRevision, currentRevision: board.metadata[operation.elementId]?.revision ?? null, currentElement: existing ?? null });
          if ((operation.kind === 'update' || restoring) && (!object(operation.patch) || (operation.patch.id !== undefined && operation.patch.id !== operation.elementId) || (existing && operation.patch.type !== undefined && operation.patch.type !== existing.type))) return fail('A patch cannot replace the element ID or type.');
          if (restoring && operation.patch.isDeleted !== false) return fail('Restore must explicitly revive the same deleted object.');
        } else return fail('Unknown canvas operation.');
      }
      if (conflicts.length) return { ok: false, code: 'CONFLICT', message: 'Affected elements changed; read and rebase this edit.', boardRevision: board.revision, conflicts };

      const beforeImages: Mutation['beforeImages'] = {};
      const afterRevisions: Mutation['afterRevisions'] = {};
      for (const operation of command.operations) {
        const existing = current.get(operation.elementId);
        beforeImages[operation.elementId] = existing ? clone(existing) : null;
        if (operation.kind === 'create') current.set(operation.elementId, clone(operation.element) as CanvasElement);
        else if (operation.kind === 'update') current.set(operation.elementId, nativeChange(existing!, clone(operation.patch)));
        else if (operation.kind === 'restore') current.set(operation.elementId, nativeChange(existing!, clone(operation.patch), true));
        else current.set(operation.elementId, nativeChange(existing!, { isDeleted: true }));
        afterRevisions[operation.elementId] = (board.metadata[operation.elementId]?.revision ?? 0) + 1;
      }
      const elements = [...current.values()];
      const invalid = this.validateScene(elements);
      if (invalid) return fail(invalid);
      return this.commitMutation(board, elements, { id: randomUUID(), beforeImages, afterRevisions }, actor);
    });
  }

  undo(mutationId: string, requestId: string, actor: string): MutationResult {
    return this.receipted(requestId, actor, { kind: 'undo', mutationId }, () => {
      const board = this.savedBoard();
      const row = this.db.prepare('SELECT data FROM mutations WHERE id = ?').get(mutationId) as { data: string } | undefined;
      if (!row) return { ok: false, code: 'NOT_FOUND', boardRevision: board.revision, message: 'Mutation not found.' };
      const original: Mutation = JSON.parse(row.data);
      const current = new Map(board.elements.map(element => [element.id, element]));
      const conflicts: Conflict[] = [];
      for (const [elementId, expectedRevision] of Object.entries(original.afterRevisions)) {
        if (board.metadata[elementId]?.revision !== expectedRevision) conflicts.push({ elementId, expectedRevision, currentRevision: board.metadata[elementId]?.revision ?? null, currentElement: current.get(elementId) ?? null });
      }
      if (conflicts.length) return { ok: false, code: 'CONFLICT', message: 'A later edit changed this mutation’s elements; undo left the board unchanged.', boardRevision: board.revision, conflicts };
      const beforeImages: Mutation['beforeImages'] = {};
      const afterRevisions: Mutation['afterRevisions'] = {};
      for (const [elementId, originalBefore] of Object.entries(original.beforeImages)) {
        const existing = current.get(elementId)!;
        beforeImages[elementId] = clone(existing);
        current.set(elementId, originalBefore ? restoreNative(existing, originalBefore) : nativeChange(existing, { isDeleted: true }, true));
        afterRevisions[elementId] = board.metadata[elementId].revision + 1;
      }
      const elements = [...current.values()];
      const invalid = this.validateScene(elements);
      if (invalid) return { ok: false, code: 'CONFLICT', boardRevision: board.revision, message: `Undo conflicts with a dependent object: ${invalid}` };
      return this.commitMutation(board, elements, { id: randomUUID(), beforeImages, afterRevisions, undoOf: mutationId }, actor);
    });
  }

  private savedBoard(): SavedBoard {
    return JSON.parse((this.db.prepare('SELECT value FROM state WHERE key = ?').get('board') as { value: string }).value);
  }

  private validateScene(elements: CanvasElement[]): string | null {
    if (elements.length > MAX_ELEMENTS || Buffer.byteLength(JSON.stringify(elements)) > MAX_SCENE_BYTES) return 'Board exceeds the local scene limit.';
    const live = new Map(elements.filter(element => !element.isDeleted).map(element => [element.id, element]));
    for (const element of live.values()) {
      for (const id of elementReferences(element)) if (!live.has(id)) return `${element.id} references unavailable element ${id}; include dependent changes in the batch.`;
      if (element.type === 'image' && element.fileId && !this.db.prepare('SELECT id FROM files WHERE id = ?').get(element.fileId)) return `Image ${element.id} references an unavailable managed file.`;
    }
    return null;
  }

  private commitMutation(board: SavedBoard, elements: CanvasElement[], mutation: Mutation, actor: string): MutationResult {
    elements = orderNativeElements(elements);
    const metadata = { ...board.metadata };
    const changedMetadata: Record<string, ElementMetadata> = {};
    for (const [id, nextRevision] of Object.entries(mutation.afterRevisions)) {
      metadata[id] = { revision: nextRevision, actor };
      changedMetadata[id] = metadata[id];
    }
    const next = { ...board, revision: board.revision + 1, elements, metadata };
    this.db.prepare('UPDATE state SET value = ? WHERE key = ?').run(JSON.stringify(next), 'board');
    this.db.prepare('INSERT INTO mutations (id, data) VALUES (?, ?)').run(mutation.id, JSON.stringify(mutation));
    return { ok: true, boardRevision: next.revision, mutationId: mutation.id, changedElements: elements.filter(element => Object.hasOwn(mutation.afterRevisions, element.id)), metadata: changedMetadata };
  }

  private receipted(requestId: string, actor: string, input: unknown, work: () => MutationResult): MutationResult {
    if (!validId(requestId) || !validId(actor)) return { ok: false, code: 'VALIDATION_FAILED', boardRevision: this.savedBoard().revision, message: 'A valid request ID and trusted actor are required.' };
    const hash = createHash('sha256').update(canonical(input)).digest('hex');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const receipt = this.db.prepare('SELECT request_hash, result FROM receipts WHERE actor = ? AND request_id = ?').get(actor, requestId) as { request_hash: string; result: string } | undefined;
      let result: MutationResult;
      if (receipt) {
        result = receipt.request_hash === hash ? JSON.parse(receipt.result) : { ok: false, code: 'IDEMPOTENCY_KEY_REUSED', boardRevision: this.savedBoard().revision, message: 'This request ID already names different input; use a new ID.' };
      } else {
        result = work();
        this.db.prepare('INSERT INTO receipts (actor, request_id, request_hash, result) VALUES (?, ?, ?, ?)').run(actor, requestId, hash, JSON.stringify(result));
      }
      this.db.exec('COMMIT');
      return clone(result);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
