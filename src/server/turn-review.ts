import { createHash, randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { mkdir, open, opendir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { devNull } from 'node:os';
import type { ReviewFile, TurnReview } from '../shared/context.js';
import type { Store } from './store.js';
import { WorkspaceFiles } from './workspace-files.js';

type Entry = { revision: string; blob?: string; size: number; binary: boolean; mode?: number };
export type ReviewSnapshot = { files: Record<string, Entry>; canvas: Record<string, string>; truncated: boolean };
type SavedReview = { before: ReviewSnapshot; after: ReviewSnapshot; restored: string[] };
const ignored = new Set(['.git', 'node_modules', '.canvagent', 'dist', 'build', 'target', '.next', 'coverage']);
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });
const outside = (root: string, path: string) => { const rel = relative(root, path); return rel === '..' || rel.startsWith('../') || isAbsolute(rel); };
const entryAt = (snapshot: ReviewSnapshot, path: string) => Object.hasOwn(snapshot.files, path) ? snapshot.files[path] : undefined;

/** Bounded before/after observations. Shared-checkout edits are deliberately not
 * attributed to one process; these are changes observed during the turn. */
export class TurnReviews {
  private root: string;
  private blobs: string;
  private restores = new Map<string, Promise<void>>();
  constructor(private options: { workspace: string; dataDir: string; store: Pick<Store, 'get' | 'set'>; board: () => any }) {
    this.root = realpathSync(options.workspace);
    this.blobs = join(options.dataDir, 'review-blobs');
  }
  async capture(): Promise<ReviewSnapshot> {
    const snapshot: ReviewSnapshot = { files: Object.create(null), canvas: Object.create(null), truncated: false };
    const deadline = Date.now() + 4000;
    let total = 0, count = 0, discovered = 0;
    await mkdir(this.blobs, { recursive: true, mode: 0o700 });
    const dataDir = resolve(this.options.dataDir);
    const walk = async (directory: string): Promise<void> => {
      if (await realpath(directory) !== directory || outside(this.root, directory)) { snapshot.truncated = true; return; }
      if (Date.now() > deadline || count >= 1500 || total >= 24 * 1024 * 1024 || discovered >= 15000) { snapshot.truncated = true; return; }
      const entries = await opendir(directory);
      for await (const entry of entries) {
        if (++discovered > 15000 || Date.now() > deadline || count >= 1500 || total >= 24 * 1024 * 1024) { snapshot.truncated = true; break; }
        if (ignored.has(entry.name.toLowerCase())) continue;
        if (sep !== '\\' && entry.name.includes('\\')) { snapshot.truncated = true; continue; }
        const target = join(directory, entry.name);
        if (target === dataDir || target.startsWith(`${dataDir}/`)) continue;
        if (entry.isDirectory()) { await walk(target).catch(() => { snapshot.truncated = true; }); continue; }
        if (!entry.isFile()) continue;
        let handle;
        try {
          if (await realpath(target) !== target) { snapshot.truncated = true; continue; }
          handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
          const before = await handle.stat();
          if (!before.isFile() || before.size > 512 * 1024 || total + before.size > 24 * 1024 * 1024) { snapshot.truncated = true; continue; }
          const bytes = Buffer.alloc(before.size + 1);
          const result = await handle.read(bytes, 0, bytes.length, 0);
          const after = await handle.stat();
          if (result.bytesRead !== before.size || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.size !== after.size || before.mode !== after.mode || await realpath(target) !== target) { snapshot.truncated = true; continue; }
          const value = bytes.subarray(0, result.bytesRead);
          const revision = hash(value);
          let binary = value.includes(0);
          if (!binary) try { new TextDecoder('utf-8', { fatal: true }).decode(value); } catch { binary = true; }
          if (!binary) await writeFile(join(this.blobs, revision), value, { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
          snapshot.files[relative(this.root, target).split(sep).join('/')] = { revision, size: value.length, binary, mode: before.mode & 0o777, ...(!binary ? { blob: revision } : {}) };
          total += value.length; count++;
        } catch { snapshot.truncated = true; }
        finally { await handle?.close(); }
      }
    };
    await walk(this.root);
    for (const element of this.options.board().elements ?? []) snapshot.canvas[element.id] = hash(JSON.stringify(element));
    return snapshot;
  }
  async finish(before: ReviewSnapshot, review: TurnReview): Promise<TurnReview> {
    const after = await this.capture();
    const files: ReviewFile[] = [];
    for (const path of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
      const left = entryAt(before, path), right = entryAt(after, path);
      if (left?.revision === right?.revision) continue;
      // A bounded scan cannot prove a missing file was deleted. Never offer a
      // restore for an unobserved side of an incomplete snapshot.
      if ((!left && before.truncated) || (!right && after.truncated)) continue;
      files.push({ path, beforeRevision: left?.revision, afterRevision: right?.revision, status: !left ? 'added' : !right ? 'deleted' : 'modified' });
    }
    const canvasElementIds = [...new Set([...Object.keys(before.canvas), ...Object.keys(after.canvas)])].filter(id => before.canvas[id] !== after.canvas[id]);
    this.options.store.set(`turn-review:${review.id}`, { before, after, restored: [] } satisfies SavedReview);
    return { ...review, files: files.sort((a, b) => a.path.localeCompare(b.path)), canvasElementIds, truncated: before.truncated || after.truncated, completedAt: new Date().toISOString() };
  }
  async diff(review: TurnReview, path: string) {
    if (!review.files.some(file => file.path === path)) throw failure('This file is not part of this turn review.', 404);
    const saved = this.saved(review.id), before = entryAt(saved.before, path), after = entryAt(saved.after, path);
    if (before?.binary || after?.binary) return { path, diff: '', binary: true, restored: saved.restored.includes(path) };
    const left = before ? await this.bytes(before) : Buffer.alloc(0), right = after ? await this.bytes(after) : Buffer.alloc(0);
    // Git compares only generated immutable blobs in a controlled empty folder.
    // The user's repository config, attributes and external programs are excluded.
    const diffDir = join(this.options.dataDir, 'review-diff');
    await mkdir(diffDir, { recursive: true, mode: 0o700 });
    const key = randomUUID(); const leftPath = join(diffDir, `${key}-before`), rightPath = join(diffDir, `${key}-after`);
    await Promise.all([writeFile(leftPath, left, { mode: 0o600 }), writeFile(rightPath, right, { mode: 0o600 })]);
    let truncated = false;
    try {
      const diff = await new Promise<string>((resolveResult, reject) => {
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
        const child = spawn('git', ['--no-pager', '-c', `core.attributesFile=${devNull}`, 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--no-color', '--', leftPath, rightPath], { cwd: diffDir, env: { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_CEILING_DIRECTORIES: diffDir }, stdio: ['ignore', 'pipe', 'ignore'] });
        let output = '', size = 0;
        const timer = setTimeout(() => { child.kill('SIGKILL'); reject(failure('Review diff timed out.', 504)); }, 5000);
        child.stdout.on('data', (bytes: Buffer) => { if (size < 512 * 1024) output += bytes.subarray(0, 512 * 1024 - size).toString('utf8'); size += bytes.length; if (size > 512 * 1024) { truncated = true; child.kill('SIGKILL'); } });
        child.on('error', () => { clearTimeout(timer); reject(failure('Git is required to display review diffs.', 503)); });
        child.on('close', code => {
          clearTimeout(timer);
          if (![0, 1].includes(code ?? -1) && size <= 512 * 1024) reject(failure('Could not produce the review diff.', 503));
          else {
            let inHunk = false;
            resolveResult(output.split('\n').map(line => {
              if (line.startsWith('@@')) inHunk = true;
              if (inHunk) return line;
              return line.startsWith('diff --git ') ? `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}` : line.startsWith('--- ') ? `--- ${JSON.stringify(`a/${path}`)}` : line.startsWith('+++ ') ? `+++ ${JSON.stringify(`b/${path}`)}` : line;
            }).join('\n'));
          }
        });
      });
      return { path, diff, restored: saved.restored.includes(path), truncated };
    } finally { await Promise.all([unlink(leftPath).catch(() => {}), unlink(rightPath).catch(() => {})]); }
  }
  async restore(review: TurnReview, path: string) {
    const previous = this.restores.get(review.id) ?? Promise.resolve();
    const restoring = previous.then(() => this.restoreFile(review, path));
    const settled = restoring.then(() => {}, () => {});
    this.restores.set(review.id, settled);
    try { return await restoring; }
    finally { if (this.restores.get(review.id) === settled) this.restores.delete(review.id); }
  }
  private async restoreFile(review: TurnReview, path: string) {
    if (!review.files.some(file => file.path === path)) throw failure('This file is not part of this turn review.', 404);
    const saved = this.saved(review.id);
    if (saved.restored.includes(path)) return { ok: true, alreadyRestored: true };
    const before = entryAt(saved.before, path), after = entryAt(saved.after, path);
    if (before?.binary || after?.binary) throw failure('Binary file restoration is not supported.');
    const beforeBytes = before ? await this.bytes(before) : undefined;
    const files = new WorkspaceFiles(this.root);
    if (after) {
      if (await realpath(join(this.root, path)).catch(() => '') !== resolve(this.root, path)) throw failure('The file location changed after the turn. Your newer edits were preserved.', 409);
      const current = await files.read(path).catch(() => { throw failure('This file changed after the turn. Reload and review it before restoring.', 409); });
      if (current.revision !== after.revision) throw failure('This file changed after the turn. Your newer edits were preserved.', 409);
      if (beforeBytes) await files.write(path, beforeBytes.toString('utf8'), after.revision);
      else {
        const target = await realpath(join(this.root, path));
        if (outside(this.root, target) || path.split('/').includes('.git')) throw failure('File is outside the project.', 403);
        if (hash(await readFile(target)) !== after.revision) throw failure('The file changed before restoration.', 409);
        await unlink(target);
      }
    } else if (before) {
      const target = resolve(this.root, path), parent = await realpath(dirname(target)).catch(() => { throw failure('The parent directory no longer exists. Recreate it before restoring this file.', 409); });
      if (outside(this.root, target) || outside(this.root, parent) || parent.split(/[\\/]/).some(part => part.toLowerCase() === '.git') || path.split('/').some(part => part.toLowerCase() === '.git')) throw failure('File is outside the project or points into Git internals.', 403);
      if (parent !== dirname(target)) throw failure('The file’s parent location changed after the turn.', 409);
      const handle = await open(target, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') throw failure('This file was recreated after the turn. Your newer edits were preserved.', 409); throw error; });
      try {
        await handle.writeFile(beforeBytes!);
        await handle.chmod(before.mode === undefined ? 0o600 : before.mode & 0o777);
      } finally { await handle.close(); }
    }
    saved.restored.push(path); this.options.store.set(`turn-review:${review.id}`, saved);
    return { ok: true };
  }
  private saved(id: string) { const value = this.options.store.get<SavedReview>(`turn-review:${id}`); if (!value) throw failure('This turn has no saved review snapshot.', 404); return value; }
  private async bytes(entry: Entry) { if (!entry.blob || !/^[a-f0-9]{64}$/.test(entry.blob)) throw failure('Review snapshot is unavailable.', 409); const bytes = await readFile(join(this.blobs, entry.blob)).catch(() => { throw failure('Review snapshot is unavailable.', 409); }); if (hash(bytes) !== entry.revision) throw failure('Review snapshot failed its integrity check.', 409); return bytes; }
}
