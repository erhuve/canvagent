import { existsSync, realpathSync } from 'node:fs';
import { resolve, join, delimiter } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const localToolchain = join(root, '.canvagent', 'toolchain');
const env = { ...process.env };
if (!env.RUSTUP_HOME && existsSync(join(localToolchain, 'rustup'))) {
  env.RUSTUP_HOME = join(localToolchain, 'rustup');
  env.CARGO_HOME = join(localToolchain, 'cargo');
  env.PATH = [join(env.CARGO_HOME, 'bin'), env.PATH].join(delimiter);
}
// Prefer the SDK selected by the installed Command Line Tools symlink. Some
// installations also contain a newer beta SDK their linker cannot consume.
if (process.platform === 'darwin' && !env.SDKROOT && !env.DEVELOPER_DIR) {
  const developer = execFileSync('xcode-select', ['-p'], { encoding: 'utf8' }).trim();
  const selected = join(developer, 'SDKs', 'MacOSX.sdk');
  if (existsSync(selected)) env.SDKROOT = realpathSync(selected);
}
const command = process.argv[2] ?? 'dev';
const args = process.argv.slice(3);
const check = command === 'check';
const child = spawn(check ? 'cargo' : process.execPath, check
  ? ['check', '--manifest-path', join(root, 'src-tauri', 'Cargo.toml'), ...args]
  : [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), command, ...args], {
  cwd: root, env, stdio: 'inherit',
});
child.on('error', error => { console.error(`Could not start desktop tooling: ${error.message}. Install Rust and the Tauri platform prerequisites.`); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
