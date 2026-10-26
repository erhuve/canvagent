import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { access, link, lstat, mkdir, open, opendir, readlink, realpath, rename, rmdir, stat, unlink, type FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';

export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_DIRECTORY_ENTRIES = 1000;
export const MAX_INDEX_RESULTS = 200;
export const MAX_SEARCH_RESULTS = 500;
export const MAX_DISCOVERY_ENTRIES = 20_000;
export const SEARCH_DEADLINE_MS = 5000;
export const MAX_MANAGEMENT_ENTRIES = 2000;
export const MAX_MANAGEMENT_BYTES = 64 * 1024 * 1024;
export const MANAGEMENT_DEADLINE_MS = 5000;
type ManagementInfo = { path: string; name: string; kind: 'file' | 'directory'; revision: string; size: number; entries: number };
type WorkspaceFileOptions = { trashDirectory?: string; protectedDirectory?: string };
const trashManifest = z.object({ path: z.string(), kind: z.enum(['file', 'directory']), revision: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string() });
type IndexedFile = { path: string; name: string };
type SearchMatch = { path: string; line: number; column: number; text: string };
type FileSearchOptions = { query: string; caseSensitive?: boolean; regex?: boolean; wholeWord?: boolean };
const searchOptions = z.object({ query: z.string().min(1).max(1000), caseSensitive: z.boolean().optional(), regex: z.boolean().optional(), wholeWord: z.boolean().optional() });
type FileEntry = { name: string; path: string; kind: 'directory' | 'file'; size?: number };
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });
const isOutside = (root: string, target: string) => {
  const path = relative(root, target);
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
};
const unchanged = (before: Stats, after: Stats) => before.dev === after.dev && before.ino === after.ino
  && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;

function text(bytes: Buffer) {
  if (bytes.length > MAX_TEXT_FILE_BYTES) throw failure('Text files must be 2 MB or smaller.', 413);
  if (bytes.some(byte => (byte < 32 && ![9, 10, 12, 13].includes(byte)) || byte === 127)) throw failure('This file contains binary data. Download it to open it.', 415);
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw failure('This file is not valid UTF-8 text. Download it to open it.', 415); }
}

// Discovery and regular-expression execution run off the HTTP event loop.
// A parent deadline also stops a regex that cannot return control on its own.
const discoveryWorker = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const ignored = new Set(['.git', 'node_modules', '.canvagent', 'dist', 'build', 'target', '.next', 'coverage']);
const { root, mode, options, maxEntries, maxFiles, maxMatches, maxTextBytes } = workerData;
let scanned = 0, truncated = false;
const files = [], matches = [];
const relativePath = file => path.relative(root, file).split(path.sep).join('/');
const allowed = file => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)
    && !relative.split(path.sep).some(segment => ignored.has(segment.toLowerCase()));
};
async function* walk() {
  const queue = [root];
  const visited = new Set();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const directory = queue[cursor];
    let canonical;
    try { canonical = await fs.realpath(directory); } catch { continue; }
    if (!allowed(canonical) || visited.has(canonical)) continue;
    visited.add(canonical);
    let entries;
    try { entries = await fs.opendir(canonical); } catch { continue; }
    for await (const entry of entries) {
      if (scanned >= maxEntries) { truncated = true; return; }
      scanned++;
      if (ignored.has(entry.name.toLowerCase())) continue;
      const absolute = path.join(canonical, entry.name);
      if (entry.isDirectory()) { queue.push(absolute); continue; }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      try {
        const target = await fs.realpath(absolute);
        if (!allowed(target)) continue;
        const info = await fs.stat(target);
        // Directory symlinks are never followed, including links to ancestors.
        if (!info.isFile()) continue;
        yield { path: relativePath(absolute), target, info };
      } catch { /* Ignore inaccessible and dangling links. */ }
    }
  }
}
function fuzzy(value, query) {
  let cursor = 0, previous = -2, score = 0;
  for (const character of query) {
    const index = value.indexOf(character, cursor);
    if (index < 0) return null;
    score += index === previous + 1 ? 12 : 0;
    score += index === 0 || '/-_. '.includes(value[index - 1]) ? 20 : 0;
    score -= index - cursor;
    previous = index; cursor = index + 1;
  }
  if (value === query) score += 200;
  else if (value.startsWith(query)) score += 100;
  return score;
}
function ranked() {
  return [...files].sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, maxFiles).map(({ path, name }) => ({ path, name }));
}
function result(partial = false) {
  return mode === 'index' ? { files: ranked(), truncated: truncated || partial || files.length > maxFiles }
    : { matches: [...matches].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column), truncated: truncated || partial };
}
async function readText(file) {
  if (file.info.size > maxTextBytes) return null;
  let handle;
  try {
    handle = await fs.open(file.target, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxTextBytes || before.dev !== file.info.dev || before.ino !== file.info.ino) return null;
    const buffer = Buffer.alloc(Math.min(before.size + 1, maxTextBytes + 1));
    let length = 0;
    while (length < buffer.length) {
      const part = await handle.read(buffer, length, buffer.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    const after = await handle.stat();
    if (length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return null;
    const bytes = buffer.subarray(0, length);
    if (bytes.some(byte => (byte < 32 && ![9,10,12,13].includes(byte)) || byte === 127)) return null;
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { return null; }
  finally { if (handle) await handle.close(); }
}
(async () => {
  let expression;
  if (mode === 'search') {
    const source = options.regex ? options.query : options.query.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
    try { expression = new RegExp(source, options.caseSensitive ? 'g' : 'gi'); }
    catch { parentPort.postMessage({ error: 'Invalid regular expression.', status: 400 }); return; }
  }
  parentPort.postMessage({ progress: result(true) });
  let processed = 0;
  for await (const file of walk()) {
    processed++;
    if (mode === 'index') {
      const name = path.basename(file.path);
      const query = options.query.toLowerCase();
      const basenameScore = fuzzy(name.toLowerCase(), query);
      const pathScore = fuzzy(file.path.toLowerCase(), query);
      if (pathScore !== null) files.push({ path: file.path, name, score: (basenameScore === null ? pathScore : basenameScore + 1000) - file.path.length / 1000 });
      if (processed % 256 === 0) parentPort.postMessage({ progress: result(true) });
      continue;
    }
    const content = await readText(file);
    if (content === null) continue;
    const lines = content.split(/\r?\n/);
    const priorMatches = matches.length;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      expression.lastIndex = 0;
      let match;
      while ((match = expression.exec(line)) !== null) {
        const start = match.index, end = start + match[0].length;
        if (!options.wholeWord || (!/[A-Za-z0-9_]/.test(line[start - 1] || '') && !/[A-Za-z0-9_]/.test(line[end] || ''))) {
          if (matches.length >= maxMatches) { truncated = true; parentPort.postMessage({ done: result() }); return; }
          const snippetStart = Math.max(0, Math.min(start - 100, line.length - 300));
          matches.push({ path: file.path, line: index + 1, column: start + 1, text: line.slice(snippetStart, snippetStart + 300) });
        }
        if (!match[0].length) expression.lastIndex = start + 1;
      }
    }
    if (matches.length !== priorMatches) parentPort.postMessage({ progress: result(true) });
  }
  parentPort.postMessage({ done: result() });
})().catch(() => parentPort.postMessage({ done: result(true) }));
`;

function discover<T extends { truncated: boolean }>(root: string, mode: 'index' | 'search', options: { query: string } | FileSearchOptions, empty: T, signal?: AbortSignal): Promise<T> {
  return new Promise((resolveResult, reject) => {
    if (signal?.aborted) { resolveResult({ ...empty, truncated: true }); return; }
    let partial = empty;
    let finished = false;
    const worker = new Worker(discoveryWorker, { eval: true, execArgv: [], workerData: { root, mode, options,
      maxEntries: MAX_DISCOVERY_ENTRIES, maxFiles: MAX_INDEX_RESULTS, maxMatches: MAX_SEARCH_RESULTS, maxTextBytes: MAX_TEXT_FILE_BYTES }, resourceLimits: { maxOldGenerationSizeMb: 96 } });
    const finish = (result: T, error?: Error) => {
      if (finished) return; finished = true;
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      void worker.terminate();
      if (error) reject(error); else resolveResult(result);
    };
    const deadline = setTimeout(() => finish({ ...partial, truncated: true }), SEARCH_DEADLINE_MS);
    const abort = () => finish({ ...partial, truncated: true });
    signal?.addEventListener('abort', abort, { once: true });
    worker.on('message', message => {
      if (message.progress) partial = message.progress;
      else if (message.done) finish(message.done);
      else if (message.error) finish(partial, failure(message.error, message.status));
    });
    worker.on('error', () => finish({ ...partial, truncated: true }));
    worker.on('exit', () => finish({ ...partial, truncated: true }));
  });
}

/** Files remain rooted at the canonical project folder, including symlink targets. */
export class WorkspaceFiles {
  private writes = new Map<string, Promise<void>>();
  private mutationTail = Promise.resolve();
  constructor(private workspace: string, private options: WorkspaceFileOptions = {}) {}

  private async mutate<T>(job: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(job);
    this.mutationTail = result.then(() => {}, () => {});
    return result;
  }

  private path(value: unknown, allowRoot = false) {
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\0') || value.includes('\\') || isAbsolute(value) || win32.parse(value).root || (process.platform === 'win32' && value.includes(':'))) throw failure('Use a workspace-relative file path.');
    const segments = value.split('/');
    if (segments.some(segment => segment === '..')) throw failure('Parent paths are not allowed.');
    if (segments.some(segment => segment.toLowerCase() === '.git')) throw failure('Git internal files are not available in the file browser.', 403);
    const path = segments.filter(segment => segment && segment !== '.').join('/');
    if (!path && !allowRoot) throw failure('Choose a file inside the workspace.');
    return path;
  }
  private async target(path: string) {
    let target: string;
    try { target = await realpath(resolve(this.workspace, path)); }
    catch (error) { throw this.fileError(error); }
    if (isOutside(this.workspace, target)) throw failure('This path points outside the workspace.', 403);
    if (target.split(/[\\/]/).some(segment => segment.toLowerCase() === '.git')) throw failure('Git internal files are not available in the file browser.', 403);
    return target;
  }
  private fileError(error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (['ENOENT', 'ENOTDIR'].includes(code ?? '')) return failure('File or folder not found.', 404);
    if (['EACCES', 'EPERM', 'ELOOP'].includes(code ?? '')) return failure('This file or folder is not accessible.', 403);
    if (['EEXIST', 'ENOTEMPTY'].includes(code ?? '')) return failure('A file or folder already exists at that path.', 409);
    if (code === 'EXDEV') return failure('This operation cannot move files between different drives. The original item has been preserved.', 409);
    return error;
  }
  private async managedPath(path: string, parentOnly = false) {
    const root = await realpath(this.workspace);
    const absolute = resolve(root, path);
    const checked = parentOnly ? dirname(absolute) : absolute;
    let canonical: string;
    try { canonical = await realpath(checked); } catch (error) { throw this.fileError(error); }
    if (isOutside(root, canonical)) throw failure('This path points outside the workspace.', 403);
    if (canonical.split(/[\\/]/).some(segment => segment.toLowerCase() === '.git')) throw failure('Git internal files are not available in the file browser.', 403);
    // Reading a linked file is useful, but renaming or deleting through a link
    // is surprising. Management operations always address the visible item.
    if (canonical !== checked) throw failure('File management through symbolic links is not supported.', 403);
    for (const protectedPath of [this.options.protectedDirectory, this.options.trashDirectory].filter((value): value is string => Boolean(value))) {
      const protectedDirectory = resolve(protectedPath);
      if (!isOutside(protectedDirectory, absolute) || (!parentOnly && !isOutside(absolute, protectedDirectory))) throw failure('Application data and recovery storage cannot be changed from the file browser.', 403);
    }
    return absolute;
  }
  private async snapshot(absolute: string) {
    const hash = createHash('sha256');
    const deadline = Date.now() + MANAGEMENT_DEADLINE_MS;
    let entries = 0, size = 0;
    let rootKind: 'file' | 'directory' = 'file';
    const check = () => {
      if (entries > MAX_MANAGEMENT_ENTRIES || size > MAX_MANAGEMENT_BYTES || Date.now() > deadline) throw failure('This item is too large to safely manage here. Use your system file manager instead.', 413);
    };
    const visit = async (file: string, path: string): Promise<void> => {
      check();
      const before = await lstat(file);
      const kind = before.isSymbolicLink() ? 'link' : before.isDirectory() ? 'directory' : before.isFile() ? 'file' : 'unsupported';
      if (!path) {
        if (kind !== 'file' && kind !== 'directory') throw failure('Choose a regular file or folder. Symbolic links cannot be managed here.', 403);
        rootKind = kind;
      }
      if (kind === 'unsupported') throw failure('This folder contains a special filesystem item. Use your system file manager instead.', 403);
      // Renaming changes the root inode's ctime, so keep that one field out of
      // the reusable revision. Content, identity, mode and mtime remain guarded.
      hash.update(JSON.stringify([path, kind, before.dev, before.ino, before.mode, before.size, before.mtimeMs, path ? before.ctimeMs : null]));
      if (kind === 'file') {
        size += before.size; check();
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          if (!unchanged(before, await handle.stat())) throw failure('This item changed on disk. Refresh it and try again.', 409);
          const buffer = Buffer.alloc(256 * 1024);
          let offset = 0;
          while (offset <= before.size) {
            check();
            const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset + 1), offset);
            if (!result.bytesRead) break;
            offset += result.bytesRead;
            if (offset > before.size) throw failure('This item changed on disk. Refresh it and try again.', 409);
            hash.update(buffer.subarray(0, result.bytesRead));
          }
          if (offset !== before.size || !unchanged(before, await handle.stat())) throw failure('This item changed on disk. Refresh it and try again.', 409);
        } finally { await handle.close(); }
      } else if (kind === 'link') {
        hash.update(await readlink(file));
      } else {
        if (await realpath(file) !== file) throw failure('The item location changed. Refresh it and try again.', 409);
        const names: string[] = [];
        const directory = await opendir(file);
        for await (const entry of directory) {
          entries++; check();
          if (entry.name.toLowerCase() === '.git') throw failure('Folders containing Git internal files cannot be moved or removed here.', 403);
          names.push(entry.name);
        }
        for (const name of names.sort()) await visit(join(file, name), path ? `${path}/${name}` : name);
      }
      if (!unchanged(before, await lstat(file))) throw failure('This item changed on disk. Refresh it and try again.', 409);
    };
    try { await visit(absolute, ''); }
    catch (error) { throw this.fileError(error); }
    return { kind: rootKind, revision: hash.digest('hex'), size, entries };
  }
  async info(input: unknown): Promise<ManagementInfo> {
    const path = this.path(input);
    return { path, name: basename(path), ...await this.snapshot(await this.managedPath(path)) };
  }
  private async expected(path: string, revision: string) {
    if (!/^[a-f0-9]{64}$/.test(revision)) throw failure('A valid saved item revision is required.');
    const absolute = await this.managedPath(path);
    const info = await this.snapshot(absolute);
    if (info.revision !== revision) throw failure('This item changed on disk. Refresh it and try again.', 409);
    return { absolute, ...info };
  }
  private async vacant(absolute: string) {
    try { await lstat(absolute); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw this.fileError(error);
    }
    throw failure('A file or folder already exists at that path.', 409);
  }
  private async moveVacant(source: string, target: string, revision: string, checkLocations: () => Promise<void>) {
    const original = await lstat(source);
    const sameIdentity = (info: Stats) => info.dev === original.dev && info.ino === original.ino && info.isFile();
    await checkLocations();
    if (!original.isFile()) {
      if (!original.isDirectory()) throw failure('This item changed on disk. Refresh it and try again.', 409);
      if ((await this.snapshot(source)).revision !== revision) throw failure('This item changed on disk. Refresh it and try again.', 409);
      await checkLocations();
      await this.vacant(target);
      await rename(source, target);
      return;
    }
    // link() is an atomic no-clobber operation for regular files. Keep the old
    // name until both links still refer to the exact, reviewed file contents.
    let linked = false;
    try {
      await link(source, target); linked = true;
      if (!sameIdentity(await lstat(target)) || !sameIdentity(await lstat(source))) throw failure('This item changed on disk. Refresh it and try again.', 409);
      await checkLocations();
      if ((await this.snapshot(source)).revision !== revision || (await this.snapshot(target)).revision !== revision) throw failure('This item changed on disk. Refresh it and try again.', 409);
      if (!sameIdentity(await lstat(source)) || !sameIdentity(await lstat(target))) throw failure('This item changed on disk. Refresh it and try again.', 409);
      await unlink(source);
      linked = false;
    } finally {
      if (linked) {
        try { if (sameIdentity(await lstat(target))) await unlink(target); } catch { /* Preserve a replaced destination. */ }
      }
    }
  }
  async create(input: unknown, kind: 'file' | 'directory') {
    const path = this.path(input);
    if (kind !== 'file' && kind !== 'directory') throw failure('Choose a file or folder.');
    return this.mutate(async () => {
      const absolute = await this.managedPath(path, true);
      try {
        if (kind === 'directory') await mkdir(absolute);
        else { const handle = await open(absolute, 'wx'); await handle.close(); }
        return { path, kind };
      } catch (error) { throw this.fileError(error); }
    });
  }
  async move(input: unknown, destination: unknown, revision: string) {
    const path = this.path(input), newPath = this.path(destination);
    if (newPath.startsWith(`${path}/`)) throw failure('A folder cannot be moved inside itself.');
    return this.mutate(async () => {
      const source = await this.expected(path, revision);
      if (path === newPath) return { path, previousPath: path, kind: source.kind };
      const target = await this.managedPath(newPath, true);
      await this.vacant(target);
      try {
        // Mutations from this app are serialized. Recheck immediately before
        // rename so ordinary external changes never replace a known item.
        await this.moveVacant(source.absolute, target, revision, async () => {
          if (await this.managedPath(path) !== source.absolute || await this.managedPath(newPath, true) !== target) throw failure('The item location changed. Refresh it and try again.', 409);
        });
        return { path: newPath, previousPath: path, kind: source.kind };
      } catch (error) { throw this.fileError(error); }
    });
  }
  private async recoveryDirectory() {
    if (!this.options.trashDirectory) throw failure('Recovery storage is not configured for this workspace.', 503);
    try {
      await mkdir(this.options.trashDirectory, { recursive: true, mode: 0o700 });
      if ((await lstat(this.options.trashDirectory)).isSymbolicLink()) throw failure('Recovery storage must be a regular folder.', 403);
      return await realpath(this.options.trashDirectory);
    } catch (error) { throw this.fileError(error); }
  }
  async remove(input: unknown, revision: string) {
    const path = this.path(input);
    return this.mutate(async () => {
      const source = await this.expected(path, revision);
      const trash = await this.recoveryDirectory();
      const trashId = randomUUID(), directory = join(trash, trashId);
      await mkdir(directory, { mode: 0o700 });
      const manifestPath = join(directory, 'manifest.json');
      let moved = false;
      try {
        const manifest = await open(manifestPath, 'wx', 0o600);
        try { await manifest.writeFile(JSON.stringify({ path, kind: source.kind, revision, createdAt: new Date().toISOString() })); await manifest.sync(); }
        finally { await manifest.close(); }
        if ((await this.expected(path, revision)).absolute !== source.absolute) throw failure('The item location changed. Refresh it and try again.', 409);
        await rename(source.absolute, join(directory, 'item'));
        moved = true;
        return { path, deleted: true as const, trashed: true as const, trashId };
      } catch (error) { throw this.fileError(error); }
      finally {
        if (!moved) { await unlink(manifestPath).catch(() => {}); await rmdir(directory).catch(() => {}); }
      }
    });
  }
  async restore(trashId: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(trashId)) throw failure('Choose a valid recovery item.');
    return this.mutate(async () => {
      const trash = await this.recoveryDirectory();
      const directory = join(trash, trashId);
      try {
        if ((await realpath(directory)) !== directory) throw failure('Recovery items cannot be symbolic links.', 403);
        const handle = await open(join(directory, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
        let manifest: z.infer<typeof trashManifest>;
        try {
          const info = await handle.stat();
          if (!info.isFile() || info.size > 16 * 1024) throw failure('This recovery item is invalid.', 409);
          manifest = trashManifest.parse(JSON.parse(await handle.readFile('utf8')));
        } finally { await handle.close(); }
        const path = this.path(manifest.path);
        const target = await this.managedPath(path, true);
        await this.vacant(target);
        const source = join(directory, 'item');
        const snapshot = await this.snapshot(source);
        if (snapshot.revision !== manifest.revision || snapshot.kind !== manifest.kind) throw failure('This recovery item changed on disk. It has been preserved in recovery storage.', 409);
        await this.moveVacant(source, target, manifest.revision, async () => {
          if (await realpath(directory) !== directory || await this.managedPath(path, true) !== target) throw failure('The item location changed. Refresh it and try again.', 409);
        });
        await unlink(join(directory, 'manifest.json')).catch(() => {});
        await rmdir(directory).catch(() => {});
        return { path, kind: manifest.kind };
      } catch (error) { throw this.fileError(error); }
    });
  }
  private async opened(path: string) {
    const target = await this.target(path);
    let handle: FileHandle | undefined;
    try {
      const before = await stat(target);
      if (!before.isFile()) throw failure('Choose a regular file.', 400);
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || !unchanged(before, info) || await this.target(path) !== target) throw failure('The file changed while it was being opened. Try again.', 409);
      return { target, handle, info };
    } catch (error) { await handle?.close(); throw this.fileError(error); }
  }
  private async bytes(handle: FileHandle, info: Stats) {
    if (info.size > MAX_TEXT_FILE_BYTES) throw failure('Text files must be 2 MB or smaller.', 413);
    const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_TEXT_FILE_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (!unchanged(info, await handle.stat()) || length !== info.size) throw failure('The file changed while it was being read. Open it again.', 409);
    return buffer.subarray(0, length);
  }
  async list(input: unknown = '') {
    const path = this.path(input, true);
    const target = await this.target(path);
    const entries: FileEntry[] = [];
    let count = 0;
    let truncated = false;
    try {
      const directory = await opendir(target);
      for await (const entry of directory) {
        if (++count > MAX_DIRECTORY_ENTRIES) { truncated = true; break; }
        if (entry.name.toLowerCase() === '.git') continue;
        const entryPath = path ? `${path}/${entry.name}` : entry.name;
        try {
          const full = await this.target(entryPath);
          const info = await stat(full);
          if (info.isDirectory() || info.isFile()) entries.push({ name: entry.name, path: entryPath, kind: info.isDirectory() ? 'directory' : 'file', ...(info.isFile() ? { size: info.size } : {}) });
        } catch { /* Omit inaccessible, dangling, and out-of-workspace links. */ }
      }
    } catch (error) { throw this.fileError(error); }
    entries.sort((left, right) => Number(right.kind === 'directory') - Number(left.kind === 'directory') || left.name.localeCompare(right.name));
    return { path, entries, ...(truncated ? { truncated: true } : {}) };
  }
  async read(input: unknown) {
    const path = this.path(input);
    const { handle, info } = await this.opened(path);
    try {
      const bytes = await this.bytes(handle, info);
      return { path, content: text(bytes), revision: digest(bytes), size: bytes.length };
    } finally { await handle.close(); }
  }
  async index(query: unknown = '', signal?: AbortSignal) {
    const input = z.string().max(1000).parse(query);
    return discover(await this.target(''), 'index', { query: input }, { files: [] as IndexedFile[], truncated: false }, signal);
  }
  async search(input: FileSearchOptions, signal?: AbortSignal) {
    return discover(await this.target(''), 'search', searchOptions.parse(input), { matches: [] as SearchMatch[], truncated: false }, signal);
  }
  async write(input: unknown, content: string, revision: string) {
    return this.mutate(() => this.writeContent(input, content, revision));
  }
  private async writeContent(input: unknown, content: string, revision: string) {
    const path = this.path(input);
    const bytes = Buffer.from(content, 'utf8');
    if (text(bytes) !== content) throw failure('The new content must be valid UTF-8 text.', 415);
    if (!/^[a-f0-9]{64}$/.test(revision)) throw failure('A valid saved file revision is required.');
    const target = await this.target(path);
    const previous = this.writes.get(target) ?? Promise.resolve();
    const save = previous.then(async () => {
      const current = await this.opened(path);
      let temporary: string | undefined;
      try {
        if (current.target !== target) throw failure('The file location changed. Open it again.', 409);
        const original = await this.bytes(current.handle, current.info);
        text(original);
        if (digest(original) !== revision) throw failure('This file changed on disk. Reload it before saving your edits.', 409);
        await access(target, constants.W_OK);
        temporary = join(dirname(target), `.canvagent-save-${randomUUID()}.tmp`);
        const staged = await open(temporary, 'wx', current.info.mode & 0o7777);
        try { await staged.writeFile(bytes); await staged.chmod(current.info.mode & 0o7777); await staged.sync(); }
        finally { await staged.close(); }
        // Re-read immediately before the atomic replacement so an agent or
        // external editor's intervening change is preserved instead of lost.
        const latest = await this.opened(path);
        try {
          if (latest.target !== target || !unchanged(current.info, latest.info) || digest(await this.bytes(latest.handle, latest.info)) !== revision) throw failure('This file changed on disk. Reload it before saving your edits.', 409);
          if (!unchanged(latest.info, await stat(target)) || await this.target(path) !== target) throw failure('This file changed on disk. Reload it before saving your edits.', 409);
          await rename(temporary, target);
          temporary = undefined;
        } finally { await latest.handle.close(); }
        return { path, content, revision: digest(bytes), size: bytes.length };
      } catch (error) { throw this.fileError(error); }
      finally { await current.handle.close(); if (temporary) await unlink(temporary).catch(() => {}); }
    });
    const settled = save.then(() => {}, () => {});
    this.writes.set(target, settled);
    try { return await save; }
    finally { if (this.writes.get(target) === settled) this.writes.delete(target); }
  }
  async raw(input: unknown) {
    const path = this.path(input);
    const { handle, info } = await this.opened(path);
    const extension = extname(path).toLowerCase();
    const images: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon' };
    const image = images[extension];
    const plain = ['.txt', '.md', '.json', '.html', '.htm', '.svg', '.xml', '.js', '.jsx', '.ts', '.tsx', '.css', '.csv', '.yaml', '.yml', '.toml', '.log', '.sh', '.py', '.rs', '.go'].includes(extension);
    return { path, size: info.size, mimeType: image ?? (plain ? 'text/plain; charset=utf-8' : 'application/octet-stream'),
      disposition: `${image || plain ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(basename(path))}`, stream: handle.createReadStream() };
  }
}

export function createWorkspaceFileRouter(workspace: string, options: WorkspaceFileOptions = {}) {
  const files = new WorkspaceFiles(workspace, options);
  const router = express.Router();
  const discoveryResponse = async (res: express.Response, job: (signal: AbortSignal) => Promise<unknown>) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    try { const result = await job(controller.signal); if (!res.destroyed) res.json(result); }
    finally { res.off('close', abort); }
  };
  router.get('/', async (req, res) => res.json(await files.list(req.query.path ?? '')));
  router.get('/index', async (req, res) => discoveryResponse(res, signal => files.index(req.query.query ?? '', signal)));
  router.get('/search', async (req, res) => {
    const input = z.object({ query: z.string().min(1).max(1000), caseSensitive: z.enum(['true', 'false']).optional(), regex: z.enum(['true', 'false']).optional(), wholeWord: z.enum(['true', 'false']).optional() }).parse(req.query);
    await discoveryResponse(res, signal => files.search({ query: input.query, caseSensitive: input.caseSensitive === 'true', regex: input.regex === 'true', wholeWord: input.wholeWord === 'true' }, signal));
  });
  router.get('/content', async (req, res) => res.json(await files.read(req.query.path)));
  router.get('/info', async (req, res) => res.json(await files.info(req.query.path)));
  router.post('/create', async (req, res) => {
    const input = z.object({ path: z.string(), kind: z.enum(['file', 'directory']) }).strict().parse(req.body);
    res.json(await files.create(input.path, input.kind));
  });
  router.post('/rename', async (req, res) => {
    const input = z.object({ path: z.string(), newPath: z.string(), revision: z.string() }).strict().parse(req.body);
    res.json(await files.move(input.path, input.newPath, input.revision));
  });
  router.post('/delete', async (req, res) => {
    const input = z.object({ path: z.string(), revision: z.string() }).strict().parse(req.body);
    res.json(await files.remove(input.path, input.revision));
  });
  router.post('/restore', async (req, res) => {
    const input = z.object({ trashId: z.string() }).strict().parse(req.body);
    res.json(await files.restore(input.trashId));
  });
  router.post('/content', async (req, res) => {
    const input = z.object({ path: z.string(), content: z.string(), revision: z.string() }).parse(req.body);
    res.json(await files.write(input.path, input.content, input.revision));
  });
  router.get('/raw', async (req, res) => {
    const result = await files.raw(req.query.path);
    res.set({ 'Content-Type': result.mimeType, 'Content-Length': String(result.size), 'Content-Disposition': result.disposition, 'Content-Security-Policy': "sandbox; default-src 'none'", 'Cache-Control': 'no-store' });
    result.stream.on('error', error => res.destroy(error));
    res.on('close', () => result.stream.destroy());
    result.stream.pipe(res);
  });
  return router;
}
