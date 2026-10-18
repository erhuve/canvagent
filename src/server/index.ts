import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createApplication } from './app.js';

function option(name: string) {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? undefined : process.argv[index + 1];
}
const workspace = resolve(option('workspace') ?? process.env.CANVAGENT_WORKSPACE ?? process.cwd());
const key = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
const dataDir = resolve(option('data-dir') ?? process.env.CANVAGENT_DATA_DIR ?? join(homedir(), '.local', 'share', 'canvagent', key));
const port = Number(option('port') ?? process.env.CANVAGENT_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port.');
const application = createApplication({ workspace, dataDir, port });
application.server.listen(port, '127.0.0.1', () => {
  console.log(`Canvagent · http://127.0.0.1:${port}`);
  console.log(`Workspace: ${workspace}`);
  console.log(`Saved data: ${dataDir}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void application.close().then(() => process.exit(0));
});
