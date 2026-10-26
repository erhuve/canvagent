import { spawn } from 'node:child_process';
import { constants, realpathSync } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { z } from 'zod';
import { WorkspaceFiles } from './workspace-files.js';
import type { CanvasTool, ToolResult } from './runtime.js';

const pathSchema = z.string().min(1).max(4096);
const contentSchema = z.string().max(500_000);
const schemas = {
  workspace_list: z.object({ path: z.string().max(4096).default('') }).strict(),
  workspace_read: z.object({ path: pathSchema }).strict(),
  workspace_search: z.object({ query: z.string().min(1).max(1000), caseSensitive: z.boolean().optional(), regex: z.boolean().optional(), wholeWord: z.boolean().optional() }).strict(),
  workspace_write: z.object({ path: pathSchema, content: contentSchema, revision: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  workspace_create: z.object({ path: pathSchema, content: contentSchema }).strict(),
  workspace_command: z.object({ executable: z.string().min(1).max(4096), args: z.array(z.string().max(16000)).max(100).default([]) }).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  workspace_list: 'List files and directories inside the project. Paths are relative to the project root.',
  workspace_read: 'Read a UTF-8 project file and its revision. Read before editing. Files are limited to 2 MB.',
  workspace_search: 'Search text in project files. Generated directories and Git internals are excluded. Results are bounded.',
  workspace_write: 'Replace an existing UTF-8 project file after explicit user approval. Requires the revision returned by workspace_read; conflicting disk edits are preserved.',
  workspace_create: 'Create a new UTF-8 file after explicit user approval. The parent directory must exist. Fails if any file already exists at that path.',
  workspace_command: 'Run an executable with an argument array in the project directory after explicit user approval. No shell expansion. Commands run with the local user’s authority, for up to 30 seconds, with bounded output.',
};
export const workspaceToolSpecs: CanvasTool[] = Object.entries(schemas).map(([name, schema]) => ({ name, description: descriptions[name as keyof typeof schemas], inputSchema: z.toJSONSchema(schema, { target: 'draft-7' }) }));

export class AgentWorkspaceTools {
  private files: WorkspaceFiles;
  constructor(private workspace: string) { this.workspace = realpathSync(workspace); this.files = new WorkspaceFiles(this.workspace); }
  async call(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    try {
      if (signal?.aborted) throw new Error('Tool call cancelled.');
      let result: any;
      switch (name) {
        case 'workspace_list': result = await this.files.list(schemas.workspace_list.parse(input).path); break;
        case 'workspace_read': result = await this.files.read(schemas.workspace_read.parse(input).path); break;
        case 'workspace_search': result = await this.files.search(schemas.workspace_search.parse(input), signal); break;
        case 'workspace_write': {
          const args = schemas.workspace_write.parse(input);
          result = await this.files.write(args.path, args.content, args.revision); break;
        }
        case 'workspace_create': result = await this.create(schemas.workspace_create.parse(input), signal); break;
        case 'workspace_command': result = await this.command(schemas.workspace_command.parse(input), signal); break;
        default: throw new Error('Unknown workspace tool.');
      }
      const output = JSON.stringify(result);
      return { success: true, contentItems: [{ type: 'inputText', text: output.length > 600_000 ? JSON.stringify({ truncated: true, preview: output.slice(0, 600_000) }) : output }] };
    } catch (error) {
      return { success: false, contentItems: [{ type: 'inputText', text: error instanceof z.ZodError ? 'Invalid workspace tool arguments.' : error instanceof Error ? error.message : 'Workspace tool failed.' }] };
    }
  }
  private async create(args: { path: string; content: string }, signal?: AbortSignal) {
    const parts = args.path.split('/');
    if (isAbsolute(args.path) || win32.isAbsolute(args.path) || args.path.includes('\\') || args.path.includes('\0') || parts.some(part => part === '..' || part.toLowerCase() === '.git')) throw new Error('Use a project-relative path outside Git internals.');
    const target = resolve(this.workspace, args.path);
    const parent = await realpath(dirname(target));
    const rel = relative(this.workspace, parent);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel) || parent.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) throw new Error('This file points outside the project or into Git internals.');
    if (signal?.aborted) throw new Error('Tool call cancelled.');
    const handle = await open(join(parent, basename(target)), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    try { await handle.writeFile(args.content, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    return this.files.read(args.path);
  }
  private async command(args: { executable: string; args: string[] }, signal?: AbortSignal) {
    if (args.executable.includes('\0') || args.args.some(arg => arg.includes('\0'))) throw new Error('Command arguments cannot contain null bytes.');
    return new Promise<{ exitCode: number | null; output: string; truncated: boolean; timedOut: boolean; cancelled: boolean }>((resolveResult, reject) => {
      const child = spawn(args.executable, args.args, { cwd: this.workspace, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', bytes = 0, truncated = false, timedOut = false, cancelled = false;
      let force: ReturnType<typeof setTimeout> | undefined;
      const kill = () => {
        if (force) return;
        try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGTERM'); else child.kill('SIGTERM'); } catch {}
        force = setTimeout(() => { try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch {} }, 1000);
        force.unref();
      };
      const timeout = setTimeout(() => { timedOut = true; kill(); }, 30_000);
      const abort = () => { cancelled = true; kill(); };
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const append = (chunk: Buffer) => {
        const remaining = Math.max(0, 1_000_000 - bytes);
        if (chunk.length > remaining) truncated = true;
        if (remaining) { output += chunk.subarray(0, remaining).toString('utf8'); bytes += Math.min(chunk.length, remaining); }
      };
      child.stdout.on('data', append); child.stderr.on('data', append);
      const cleanup = () => {
        clearTimeout(timeout);
        // A parent can exit on SIGTERM while a descendant ignores it. Preserve
        // the pending process-group SIGKILL even after its pipes close.
        if (force && !cancelled && !timedOut) clearTimeout(force);
        signal?.removeEventListener('abort', abort);
      };
      child.on('error', () => { cleanup(); reject(new Error('Could not start the executable. Check its installation and argument list.')); });
      child.on('close', exitCode => { cleanup(); resolveResult({ exitCode, output, truncated, timedOut, cancelled }); });
    });
  }
}
