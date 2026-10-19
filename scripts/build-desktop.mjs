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
  external: ['bufferutil', 'utf-8-validate'],
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; import { fileURLToPath as __fileURLToPath } from "node:url"; import { dirname as __pathDirname } from "node:path"; const require = __createRequire(import.meta.url); const __filename = __fileURLToPath(import.meta.url); const __dirname = __pathDirname(__filename);' },
});
await rm(join(resources, 'web'), { recursive: true, force: true });
await cp(join(root, 'dist'), join(resources, 'web'), { recursive: true, filter: path => !path.endsWith('.map') });
await cp(join(root, 'node_modules/@excalidraw/excalidraw/dist/prod'), join(resources, 'excalidraw'), { recursive: true });
console.log(`Desktop resources ready for ${triple}.`);
