import { spawn } from 'node:child_process';
import { isUtf8 } from 'node:buffer';
import { lstat, realpath } from 'node:fs/promises';
import { devNull } from 'node:os';
import { dirname, isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import express from 'express';

export const MAX_GIT_DIFF_BYTES = 512 * 1024;
const MAX_STATUS_BYTES = 2 * 1024 * 1024;
const GIT_DEADLINE_MS = 8000;
export type GitFile = { path: string; status: string; staged: boolean; unstaged: boolean; untracked: boolean; originalPath?: string };
export type GitStatus = { available: boolean; branch?: string; files: GitFile[] };
export type GitDiff = { path: string; diff: string; binary?: boolean; truncated?: boolean };
type GitResult = { code: number | null; stdout: string; stderr: string; truncated: boolean; utf8: boolean };
type Repository = { root: string; prefix: string; config: string[] };
const failure = (message: string, status = 400) => Object.assign(new Error(message), { status });
const outside = (path: string) => path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
const gitInternal = (path: string) => path.split(/[\\/]/).some(part => part.toLowerCase() === '.git');

/** No shell, pager, external diff/textconv, fsmonitor hooks or optional index writes. */
function git(cwd: string, args: string[], limit = MAX_STATUS_BYTES, signal?: AbortSignal, config: string[] = []): Promise<GitResult> {
  return new Promise((done, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
    const child = spawn('git', ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false', '-c', 'color.ui=false', '-c', 'diff.submodule=short', ...config, ...args], {
      cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0, stderr = '', truncated = false, timedOut = false;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { child.kill(); forceKill ??= setTimeout(() => child.kill('SIGKILL'), 1000); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, GIT_DEADLINE_MS);
    const abort = () => stop();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout.on('data', (chunk: Buffer) => {
      const remaining = limit - size;
      if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); size += Math.min(chunk.length, remaining); }
      if (chunk.length > remaining) { truncated = true; stop(); }
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString('utf8').slice(0, 16_384 - stderr.length); });
    child.once('error', error => { clearTimeout(timer); clearTimeout(forceKill); signal?.removeEventListener('abort', abort); reject(error); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(forceKill); signal?.removeEventListener('abort', abort);
      if (signal?.aborted) { reject(failure('Git review request cancelled.', 499)); return; }
      if (timedOut) { reject(failure('Git took too long to inspect this project. Try refreshing.', 504)); return; }
      const output = Buffer.concat(chunks);
      done({ code, stdout: output.toString('utf8'), stderr, truncated, utf8: isUtf8(output) });
    });
  });
}

export class WorkspaceGit {
  constructor(private readonly workspace: string) {}

  private path(input: unknown) {
    if (typeof input !== 'string' || !input || input.length > 4096 || input.includes('\0') || isAbsolute(input) || win32.isAbsolute(input)) throw failure('Choose a workspace-relative file path.');
    if (Buffer.from(input, 'utf8').toString('utf8') !== input) throw failure('The file path must use valid Unicode text.');
    if (input.split('/').some(part => part === '..') || (process.platform === 'win32' && input.split('\\').some(part => part === '..'))) throw failure('Parent paths are not allowed.');
    if (gitInternal(input)) throw failure('Git internal files are not available in Changes.', 403);
    const value = input.split('/').filter(part => part && part !== '.').join('/');
    if (!value) throw failure('Choose a file inside the workspace.');
    return value;
  }

  /** Deleted files are valid; resolve the nearest remaining ancestor as well. */
  private async safePath(root: string, path: string) {
    let candidate = resolve(root, path);
    if (outside(relative(root, candidate))) throw failure('This path points outside the workspace.', 403);
    for (;;) {
      try {
        await lstat(candidate);
        const target = await realpath(candidate).catch(() => { throw failure('This path is not accessible.', 403); });
        const local = relative(root, target);
        if (outside(local)) throw failure('This path points outside the workspace.', 403);
        if (gitInternal(local)) throw failure('Git internal files are not available in Changes.', 403);
        return;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        const parent = dirname(candidate);
        if (parent === candidate) throw failure('This path is not accessible.', 403);
        candidate = parent;
      }
    }
  }

  private async repository(signal?: AbortSignal): Promise<Repository | undefined> {
    const root = await realpath(this.workspace);
    let result: GitResult;
    try { result = await git(root, ['rev-parse', '--show-toplevel'], MAX_STATUS_BYTES, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    if (result.code !== 0) {
      if (/not a git repository|must be run in a work tree/i.test(result.stderr)) return;
      throw failure('Git could not inspect this project. Check repository access and try again.', 503);
    }
    // rev-parse ends with a single newline; preserve legal spaces in directory names.
    const repository = await realpath(result.stdout.replace(/\r?\n$/, ''));
    const prefix = relative(repository, root);
    if (outside(prefix)) throw failure('Git returned a repository outside this project.', 403);
    // Status/diff can invoke clean filters while comparing files. Disable every
    // configured driver as well as external diff/textconv; review never runs it.
    const filters = await git(root, ['config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|smudge|required)$'], 64 * 1024, signal);
    if (filters.truncated || ![0, 1].includes(filters.code ?? -1)) throw failure('Git filter configuration could not be inspected.', 503);
    const names = filters.stdout.split('\0').filter(Boolean);
    const config = names.flatMap(name => ['-c', `${name}=${name.endsWith('.required') ? 'false' : ''}`]);
    return { root, prefix: prefix ? prefix.split(sep).join('/') + '/' : '', config };
  }

  private async changed(repository: Repository, signal?: AbortSignal) {
    const result = await git(repository.root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all', '--', '.'], MAX_STATUS_BYTES, signal, repository.config);
    if (result.truncated) throw failure('This project has too many changes to display. Narrow the workspace and refresh.', 413);
    if (result.code !== 0) throw failure('Git could not read changed files. Try refreshing.', 503);
    if (!result.utf8) throw failure('A changed filename is not valid UTF-8. Rename that file to review this project.', 415);
    const records = result.stdout.split('\0');
    const files: GitFile[] = [];
    const localPath = (value: string) => repository.prefix ? value.startsWith(repository.prefix) ? value.slice(repository.prefix.length) : undefined : value;
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (!record) continue;
      if (record.length < 4 || record[2] !== ' ') throw failure('Git returned an invalid status response.', 503);
      const status = record.slice(0, 2);
      const path = localPath(record.slice(3));
      // In porcelain -z, rename/copy destination comes first, followed by source.
      const originalPath = /[RC]/.test(status) ? localPath(records[++index] ?? '') : undefined;
      if (!path) continue;
      try {
        this.path(path); await this.safePath(repository.root, path);
      } catch (error) {
        if ([400, 403].includes((error as { status?: number }).status ?? 0)) continue;
        throw error;
      }
      const file: GitFile = { path, status, staged: status[0] !== ' ' && status !== '??', unstaged: status[1] !== ' ' && status !== '??', untracked: status === '??' };
      if (originalPath) {
        try { this.path(originalPath); await this.safePath(repository.root, originalPath); file.originalPath = originalPath; }
        catch { /* A rename source outside this workspace is not exposed. */ }
      }
      files.push(file);
    }
    return files;
  }

  async status(signal?: AbortSignal): Promise<GitStatus> {
    const repository = await this.repository(signal);
    if (!repository) return { available: false, files: [] };
    const [files, branch] = await Promise.all([
      this.changed(repository, signal),
      git(repository.root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], 4096, signal),
    ]);
    let label = branch.code === 0 ? branch.stdout.replace(/\r?\n$/, '') : '';
    if (!label) {
      const head = await git(repository.root, ['rev-parse', '--short', 'HEAD'], 4096, signal);
      if (head.code === 0) label = `Detached at ${head.stdout.trim()}`;
    }
    return { available: true, ...(label ? { branch: label } : {}), files };
  }

  async diff(input: unknown, staged: boolean, signal?: AbortSignal): Promise<GitDiff> {
    const path = this.path(input);
    const repository = await this.repository(signal);
    if (!repository) throw failure('This project is not a Git working tree.', 404);
    await this.safePath(repository.root, path);
    const file = (await this.changed(repository, signal)).find(file => file.path === path);
    if (!file) throw failure('This file has no changes in the workspace. Refresh the list.', 404);
    if (staged && !file.staged || !staged && !file.unstaged && !file.untracked) return { path, diff: '' };
    const options = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/'];
    const result = file.untracked
      ? await git(repository.root, [...options, '--no-index', '--', devNull, path], MAX_GIT_DIFF_BYTES, signal, repository.config)
      : await git(repository.root, [...options, ...(staged ? ['--cached'] : []), '--', path, ...(file.originalPath ? [file.originalPath] : [])], MAX_GIT_DIFF_BYTES, signal, repository.config);
    if (!result.truncated && result.code !== 0 && !(file.untracked && result.code === 1)) throw failure('Git could not read this diff. Refresh the list and try again.', 503);
    return { path, diff: result.stdout, binary: /^Binary files .* differ$/m.test(result.stdout), ...(result.truncated ? { truncated: true } : {}) };
  }
}

export function createGitRouter(workspace: string): express.Router {
  const router = express.Router();
  const files = new WorkspaceGit(workspace);
  const respond = async (res: express.Response, job: (signal: AbortSignal) => Promise<unknown>) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    try { const result = await job(controller.signal); if (!res.destroyed) res.json(result); }
    finally { res.off('close', abort); }
  };
  router.get('/status', (_req, res) => respond(res, signal => files.status(signal)));
  router.get('/diff', (req, res) => {
    if (req.query.staged !== undefined && !['true', 'false'].includes(req.query.staged as string)) throw failure('Choose staged=true or staged=false.');
    return respond(res, signal => files.diff(req.query.path, req.query.staged === 'true', signal));
  });
  return router;
}
