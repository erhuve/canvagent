import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const resources = join(root, 'src-tauri', 'resources');
const binaries = join(root, 'src-tauri', 'binaries');
const cache = join(root, '.canvagent', 'desktop-cache');
const manifest = JSON.parse(await readFile(join(root, 'scripts', 'node-runtime.json'), 'utf8'));
const nodePlatform = process.platform === 'win32' ? 'win' : process.platform;
const platformKey = `${nodePlatform}-${process.arch}`;
const triples = {
  'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu', 'linux-x64': 'x86_64-unknown-linux-gnu',
  'win-arm64': 'aarch64-pc-windows-msvc', 'win-x64': 'x86_64-pc-windows-msvc',
};
const triple = triples[platformKey];
if (!triple || !manifest.archives[platformKey]) throw new Error(`No desktop Node runtime is configured for ${platformKey}.`);
for (const directory of [resources, binaries, cache]) await mkdir(directory, { recursive: true });
const archiveName = `node-v${manifest.version}-${platformKey}.${nodePlatform === 'win' ? 'zip' : 'tar.gz'}`;
const archive = join(cache, archiveName);
if (!existsSync(archive)) {
  console.log(`Downloading the official Node ${manifest.version} runtime (${platformKey})…`);
  const response = await fetch(`https://nodejs.org/dist/v${manifest.version}/${archiveName}`);
  if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== manifest.archives[platformKey]) throw new Error('Node archive checksum did not match the pinned official checksum.');
  await writeFile(archive, bytes);
}
const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
if (hash !== manifest.archives[platformKey]) throw new Error('Cached Node archive checksum did not match. Remove it and retry.');
execFileSync('tar', ['-xf', archive, '-C', cache]);
const extracted = join(cache, `node-v${manifest.version}-${platformKey}`);
const nodeFile = nodePlatform === 'win' ? 'node.exe' : 'bin/node';
const target = join(binaries, `canvagent-node-${triple}${nodePlatform === 'win' ? '.exe' : ''}`);
await copyFile(join(extracted, nodeFile), target);
if (nodePlatform !== 'win') await chmod(target, 0o755);
await copyFile(join(extracted, 'LICENSE'), join(resources, 'NODE-LICENSE.txt'));
await build({
  entryPoints: [join(root, 'src/server/desktop.ts')], outfile: join(resources, 'server.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  external: ['bufferutil', 'utf-8-validate', 'node-pty'],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __pathDirname } from "node:path"; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __pathDirname(__filename);' },
});
// Native PTY bindings must remain an external Node package so their relative
// .node library and spawn-helper paths also work outside the source checkout.
const ptySource = join(root, 'node_modules', 'node-pty');
const ptyTarget = join(resources, 'node_modules', 'node-pty');
await rm(ptyTarget, { recursive: true, force: true });
await mkdir(ptyTarget, { recursive: true });
for (const file of ['package.json', 'LICENSE', 'lib']) await cp(join(ptySource, file), join(ptyTarget, file), { recursive: true });
const ptyNativeDir = existsSync(join(ptySource, 'build/Release/pty.node')) ? 'build/Release' : `prebuilds/${platformKey}`;
if (!existsSync(join(ptySource, ptyNativeDir))) throw new Error(`Build node-pty for ${platformKey} before packaging the desktop app.`);
await cp(join(ptySource, ptyNativeDir), join(ptyTarget, ptyNativeDir), { recursive: true });
const ptyHelper = join(ptyTarget, ptyNativeDir, 'spawn-helper');
if (existsSync(ptyHelper) && nodePlatform !== 'win') await chmod(ptyHelper, 0o755);
if (nodePlatform === 'darwin') {
  for (const file of ['pty.node', 'spawn-helper']) {
    const binary = join(ptyTarget, ptyNativeDir, file);
    if (existsSync(binary)) execFileSync('codesign', ['--force', '--sign', '-', binary], { stdio: 'pipe' });
  }
}
const editorTerminalLicenses = [
  ['Monaco Editor', 'monaco-editor/LICENSE'],
  ['monaco-vim', 'monaco-vim/LICENSE'],
  ['CodeMirror Vim bindings', 'monaco-vim/LICENSE.codemirror.txt'],
  ['xterm.js', '@xterm/xterm/LICENSE'],
  ['xterm.js Fit Addon', '@xterm/addon-fit/LICENSE'],
  ['node-pty', 'node-pty/LICENSE'],
];
await writeFile(join(resources, 'EDITOR-TERMINAL-LICENSES.txt'), (await Promise.all(editorTerminalLicenses.map(async ([name, file]) => `${name}\n\n${await readFile(join(root, 'node_modules', file), 'utf8')}`))).join('\n\n---\n\n'));
await rm(join(resources, 'web'), { recursive: true, force: true });
await cp(join(root, 'dist'), join(resources, 'web'), { recursive: true, filter: path => !path.endsWith('.map') });
await cp(join(root, 'node_modules/@excalidraw/excalidraw/dist/prod'), join(resources, 'excalidraw'), { recursive: true });
console.log(`Desktop resources ready for ${triple}.`);
