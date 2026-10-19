import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { createApplication } from './app.js';

const { values } = parseArgs({ options: {
  workspace: { type: 'string' }, 'data-root': { type: 'string' }, resources: { type: 'string' },
} });
if (!values.workspace || !values['data-root'] || !values.resources) throw new Error('Desktop startup requires a workspace, data root, and resource directory.');
const workspace = realpathSync(values.workspace);
const key = createHash('sha256').update(workspace).digest('hex').slice(0, 16);
const resources = resolve(values.resources);

// Finder and other desktop launchers do not inherit a terminal's PATH.
const extraPaths = [join(homedir(), '.local', 'bin'), join(homedir(), '.volta', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
process.env.PATH = [...new Set([...(process.env.PATH ?? '').split(delimiter), ...extraPaths])].filter(Boolean).join(delimiter);
const executable = process.platform === 'win32' ? 'codex.exe' : 'codex';
const candidates = [
  process.env.CANVAGENT_CODEX_BIN,
  ...process.env.PATH.split(delimiter).map(path => join(path, executable)),
  ...(process.platform === 'darwin' ? [
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  ] : []),
].filter((path): path is string => !!path);
const runtimeCommand = candidates.find(path => {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
});
if (runtimeCommand) process.env.PATH = [dirname(runtimeCommand), process.env.PATH].join(delimiter);

// Reuse the normal CLI data location when present. Otherwise desktop data is
// kept in the OS application-data directory, outside the selected project.
const legacyData = join(homedir(), '.local', 'share', 'canvagent', key);
const dataDir = existsSync(join(legacyData, 'canvagent.sqlite')) ? legacyData : join(resolve(values['data-root']), 'workspaces', key);
const application = createApplication({
  workspace, dataDir, port: 0, desktop: true, runtimeCommand,
  distDir: join(resources, 'web'), assetsDir: join(resources, 'excalidraw'),
});
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await application.close();
  process.exit(0);
}
application.server.once('error', error => { console.error(error.message); void close(); });
application.server.listen(0, '127.0.0.1', () => {
  const address = application.server.address();
  if (!address || typeof address === 'string') throw new Error('The desktop service did not receive a local port.');
  console.log(JSON.stringify({ type: 'ready', url: `http://127.0.0.1:${address.port}` }));
});
const input = createInterface({ input: process.stdin });
input.on('line', line => { if (line === 'shutdown') void close(); });
// A closed control pipe means the native parent exited, even after a crash.
input.on('close', () => void close());
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
