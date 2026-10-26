import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createWorkspaceHost } from './workspaces.js';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  workspace: { type: 'string' }, 'data-dir': { type: 'string' },
  port: { type: 'string' }, help: { type: 'boolean', short: 'h' },
} });
if (values.help) {
  console.log('Usage: npm start -- [--workspace /path/to/project] [--data-dir /path/to/data] [--port 4317]');
  console.log('Uses your existing Codex CLI login. Open the printed local URL for chat and the shared canvas.');
  process.exit(0);
}
const workspace = resolve(values.workspace ?? process.env.CANVAGENT_WORKSPACE ?? process.cwd());
const configuredDataDir = values['data-dir'] ?? process.env.CANVAGENT_DATA_DIR;
const dataDir = configuredDataDir ? resolve(configuredDataDir) : undefined;
const port = Number(values.port ?? process.env.CANVAGENT_PORT ?? 4317);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid local port.');
const application = createWorkspaceHost({ workspace, dataDir, dataRoot: join(homedir(), '.local', 'share', 'canvagent'), port, reuseLegacyData: true });
application.server.listen(port, '127.0.0.1', () => {
  console.log(`Canvagent · http://127.0.0.1:${port}`);
  console.log(`Workspace: ${workspace}`);
  console.log(`Saved data: ${application.applications.get(application.initialProjectId)!.store.dataDir}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  void application.close().then(() => process.exit(0));
});
