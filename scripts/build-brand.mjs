import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const brand = join(root, 'public', 'brand');
const mark = await readFile(join(brand, 'mark.svg'), 'utf8');
const artwork = mark.slice(mark.indexOf('>') + 1, mark.lastIndexOf('</svg>')).trim();
const light = '#fcfcfa';
const dark = '#252b2a';
const cream = '#f6f3e9';
const icon = (background, paths) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="80" y="80" width="864" height="864" rx="195" fill="${background}"/>
  <g transform="translate(192 192) scale(1.25)">
${paths}
  </g>
</svg>
`;

await mkdir(join(root, 'desktop'), { recursive: true });
await writeFile(join(brand, 'mark-dark.svg'), mark.replaceAll('#254b36', cream));
await writeFile(join(brand, 'favicon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="112" fill="${light}"/>
${artwork}
</svg>
`);
await writeFile(join(brand, 'app-icon.svg'), icon(light, artwork));
await writeFile(join(brand, 'app-icon-dark.svg'), icon(dark, artwork.replaceAll('#254b36', cream)));
await copyFile(join(brand, 'mark.svg'), join(root, 'desktop', 'mark.svg'));
await copyFile(join(brand, 'app-icon.svg'), join(root, 'desktop', 'icon.svg'));

// Tauri supplies the platform encoders. Keep only the desktop formats we ship,
// rather than adding its generated mobile and Windows Store asset trees.
const temporary = await mkdtemp(join(tmpdir(), 'canvagent-brand-'));
try {
  execFileSync(process.execPath, [join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js'), 'icon', join(brand, 'app-icon.svg'), '--output', temporary], { cwd: root, stdio: 'pipe' });
  const icons = join(root, 'src-tauri', 'icons');
  await mkdir(icons, { recursive: true });
  for (const name of ['32x32.png', '64x64.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.icns', 'icon.ico']) {
    await copyFile(join(temporary, name), join(icons, name));
  }
  await copyFile(join(temporary, 'icon.png'), join(brand, 'app-icon.png'));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
console.log('Brand assets and desktop icons regenerated from public/brand/mark.svg.');
