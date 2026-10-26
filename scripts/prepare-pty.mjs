import { chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// node-pty's published macOS helper can lose its executable bit in npm archives.
// Prepare only the installed package's own helper; packaged copies are prepared
// and signed separately by build-desktop.mjs.
if (process.platform !== 'win32') {
  for (const directory of [`prebuilds/${process.platform}-${process.arch}`, 'build/Release']) {
    const helper = fileURLToPath(new URL(`../node_modules/node-pty/${directory}/spawn-helper`, import.meta.url));
    if (existsSync(helper)) await chmod(helper, 0o755);
  }
}
