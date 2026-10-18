import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve, relative, isAbsolute, join, extname, basename } from 'node:path';
import type { Artifact } from '../shared/types.js';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
const media: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain',
  '.md': 'text/markdown', '.json': 'application/json', '.html': 'text/html',
};
export class ArtifactFiles {
  constructor(private workspace: string, private directory: string) {}

  async publish(sourcePath: string, title: string, sessionId?: string): Promise<Artifact> {
    const workspace = await realpath(this.workspace);
    const source = await realpath(resolve(workspace, sourcePath));
    const rel = relative(workspace, source);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Artifact must be a file inside the project workspace.');
    const info = await stat(source);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Artifact must be a regular file smaller than 20 MB.');
    const bytes = await readFile(source);
    if (bytes.length > MAX_FILE_BYTES) throw new Error('Artifact exceeds 20 MB.');
    const id = randomUUID();
    await mkdir(this.directory, { recursive: true });
    const temporary = join(this.directory, `${id}.tmp`);
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path(id));
    } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    return {
      id, fileName: basename(source), title: title || basename(source),
      mimeType: media[extname(source).toLowerCase()] || 'application/octet-stream',
      size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'),
      sessionId, createdAt: new Date().toISOString(),
    };
  }
  path(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid artifact ID.');
    return join(this.directory, id);
  }
  async bytes(artifact: Artifact): Promise<Buffer> {
    const bytes = await readFile(this.path(artifact.id));
    if (createHash('sha256').update(bytes).digest('hex') !== artifact.sha256) throw new Error('Artifact bytes are unavailable or corrupt.');
    return bytes;
  }
}
