import { expect, test, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

type Project = { id: string; name: string; workspace: string };

async function projects(page: Page): Promise<Project[]> {
  return (await (await page.request.get('/api/projects')).json()).projects;
}

test.beforeEach(async ({ page }) => {
  for (const project of (await projects(page)).filter(entry => ['browser-workspace', 'second-workspace'].includes(entry.name))) {
    const base = `/projects/${project.id}/api`;
    expect((await page.request.get(`${base}/state`)).ok()).toBe(true);
    expect((await page.request.post(`${base}/editor/settings`, { data: { vimEnabled: false } })).ok()).toBe(true);
    expect(await (await page.request.get(`${base}/editor/settings`)).json()).toMatchObject({ vimEnabled: false });
  }
});

async function replaceEditor(page: Page, content: string) {
  const input = page.getByRole('textbox', { name: 'File contents', exact: true });
  await expect(input).toHaveJSProperty('readOnly', false);
  await input.focus();
  await input.press('ControlOrMeta+A');
  await page.keyboard.insertText(content);
}

async function expectEditor(page: Page, content: string) {
  await expect.poll(() => page.locator('.monaco-code-editor .view-lines .view-line').evaluateAll(lines => lines.sort((left, right) => parseFloat((left as HTMLElement).style.top || '0') - parseFloat((right as HTMLElement).style.top || '0')).map(line => (line.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '').trimEnd()).join('\n').trimEnd())).toBe(content.trimEnd());
}

async function openFile(page: Page, path: string) {
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  const parts = path.split('/');
  for (let index = 1; index < parts.length; index++) {
    const folder = parts.slice(0, index).join('/');
    const expand = page.getByRole('button', { name: `Expand folder: ${folder}`, exact: true });
    const collapse = page.getByRole('button', { name: `Collapse folder: ${folder}`, exact: true });
    await expect(expand.or(collapse)).toBeVisible();
    if (await expand.isVisible()) await expand.click();
  }
  await page.getByRole('button', { name: `Open file: ${path}`, exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'File contents', exact: true });
  await expect(editor).toBeVisible();
  return editor;
}

test('Files browses nested workspace files and saves editor changes to disk', async ({ page }) => {
  await page.goto('/');
  const project = (await projects(page)).find(entry => entry.name === 'browser-workspace')!;
  const readme = await openFile(page, 'README.md');
  await expectEditor(page, await readFile(join(project.workspace, 'README.md'), 'utf8'));
  const editor = await openFile(page, 'src/example.ts');
  await expectEditor(page, 'export const greeting = "Hello from browser-workspace";\n');
  const changed = 'export const greeting = "Saved from the file editor";\n';
  await replaceEditor(page, changed);
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await expect.poll(() => readFile(join(project.workspace, 'src', 'example.ts'), 'utf8')).toBe(changed);
  await page.reload();
  await openFile(page, 'src/example.ts');
  await expectEditor(page, changed);
});

test('dock tabs retain unsaved file edits while the browser opens a local page', async ({ page }) => {
  await page.goto('/');
  const project = (await projects(page)).find(entry => entry.name === 'browser-workspace')!;
  const editor = await openFile(page, 'notes/draft.txt');
  const changed = 'Keep this draft while viewing the canvas and browser.\n';
  await replaceEditor(page, changed);
  await page.getByRole('tab', { name: 'Canvas', exact: true }).click();
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  await page.getByRole('tab', { name: 'Browser', exact: true }).click();
  const previewUrl = new URL('/browser-fixture-preview', page.url()).href;
  await page.route(previewUrl, route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><h1>Local project preview</h1><p>The project browser rendered this page.</p></body></html>' }));
  await page.getByRole('textbox', { name: 'Browser address', exact: true }).fill(previewUrl.replace(/^http:\/\//, ''));
  await page.getByRole('button', { name: 'Go to address', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Browser address', exact: true })).toHaveValue(previewUrl);
  const preview = page.frameLocator('iframe[title="Project browser"]');
  await expect(preview.getByRole('heading', { name: 'Local project preview', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expectEditor(page, changed);
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await expect.poll(() => readFile(join(project.workspace, 'notes', 'draft.txt'), 'utf8')).toBe(changed);
  await page.getByRole('tab', { name: 'Browser', exact: true }).click();
  await expect(preview.getByRole('heading', { name: 'Local project preview', exact: true })).toBeVisible();
});

test('an external file change is preserved when an older editor buffer tries to save', async ({ page }) => {
  await page.goto('/');
  const project = (await projects(page)).find(entry => entry.name === 'browser-workspace')!;
  const editor = await openFile(page, 'notes/conflict.txt');
  const local = 'My unsaved editor change.\n';
  const external = 'A newer change written outside the editor.\n';
  await replaceEditor(page, local);
  await writeFile(join(project.workspace, 'notes', 'conflict.txt'), external);
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /changed|conflict|newer/i })).toBeVisible();
  await expectEditor(page, local);
  expect(await readFile(join(project.workspace, 'notes', 'conflict.txt'), 'utf8')).toBe(external);
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: 'Reload file', exact: true }).click();
  await expectEditor(page, external);
});

test('project navigation can cancel, save or discard dirty files and keeps workspace contents separate', async ({ page }) => {
  await page.goto('/');
  const known = await projects(page);
  const first = known.find(entry => entry.name === 'browser-workspace')!;
  const second = known.find(entry => entry.name === 'second-workspace')!;
  const secondOriginal = await readFile(join(second.workspace, 'notes', 'draft.txt'), 'utf8');
  const editor = await openFile(page, 'notes/draft.txt');
  const firstChanged = 'Saved only in the first workspace before switching.\n';
  await replaceEditor(page, firstChanged);
  await page.getByRole('button', { name: 'Open project: second-workspace', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Unsaved file changes', exact: true });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(new URL(`/projects/${first.id}/`, page.url()).href);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expectEditor(page, firstChanged);

  await page.getByRole('button', { name: 'Open project: second-workspace', exact: true }).click();
  await dialog.getByRole('button', { name: 'Save and switch', exact: true }).click();
  await expect(page).toHaveURL(new URL(`/projects/${second.id}/`, page.url()).href);
  expect(await readFile(join(first.workspace, 'notes', 'draft.txt'), 'utf8')).toBe(firstChanged);
  await openFile(page, 'notes/draft.txt');
  await expectEditor(page, secondOriginal);
  const secondChanged = 'Discard this second-workspace draft.\n';
  await replaceEditor(page, secondChanged);
  await page.getByRole('button', { name: 'Open project: browser-workspace', exact: true }).click();
  await dialog.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await expect(page).toHaveURL(new URL(`/projects/${first.id}/`, page.url()).href);
  expect(await readFile(join(second.workspace, 'notes', 'draft.txt'), 'utf8')).toBe(secondOriginal);
  await openFile(page, 'notes/draft.txt');
  await expectEditor(page, firstChanged);
});

test('image reload refreshes the raw preview without opening a text editor', async ({ page }) => {
  const rawRequests: string[] = [];
  const textRequests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.searchParams.get('path') !== 'pixel.png') return;
    if (url.pathname.endsWith('/api/files/raw')) rawRequests.push(request.url());
    if (url.pathname.endsWith('/api/files/content')) textRequests.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Open file: pixel.png', exact: true }).click();
  const preview = page.getByRole('img', { name: 'pixel.png', exact: true });
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBe(1);
  const originalSource = await preview.getAttribute('src');
  await expect(page.getByRole('textbox', { name: 'File contents', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reload file', exact: true }).click();
  await expect(preview).not.toHaveAttribute('src', originalSource!);
  await expect.poll(() => rawRequests.length).toBe(2);
  await expect.poll(() => preview.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth === 1)).toBe(true);
  expect(textRequests).toEqual([]);
});

test('a delayed file reload disables editing and preserves a newer draft after switching files', async ({ page }) => {
  await page.goto('/');
  const editor = await openFile(page, 'README.md');
  const reloadUrl = new URL('api/files/content?path=README.md', page.url()).href;
  const snapshot = await (await page.request.get(reloadUrl)).json();
  let release: (() => void) | undefined;
  await page.route(reloadUrl, async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) });
  });
  await page.getByRole('button', { name: 'Reload file', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  try {
    await expect(editor).toHaveJSProperty('readOnly', true);
    await openFile(page, 'src/example.ts');
    await page.getByRole('tab', { name: 'README.md', exact: true }).click();
    await expect(editor).toHaveJSProperty('readOnly', false);
    const draft = 'A newer draft typed while the old reload response was waiting.\n';
    await replaceEditor(page, draft);
    release!();
    await expect(page.getByRole('status').filter({ hasText: 'The file changed in the editor while reloading. Your edits were kept.' })).toBeVisible();
    await expectEditor(page, draft);
    await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeEnabled();
  } finally { release?.(); }
});

test('opening an existing file during another pending open keeps its draft and clears loading', async ({ page }) => {
  await page.goto('/');
  const editor = await openFile(page, 'README.md');
  await replaceEditor(page, 'Keep the already-open README draft.\n');
  const pendingUrl = new URL('api/files/content?path=src%2Fexample.ts', page.url()).href;
  const snapshot = await (await page.request.get(pendingUrl)).json();
  let release: (() => void) | undefined;
  await page.route(pendingUrl, async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(snapshot) });
  });
  await page.getByRole('button', { name: 'Expand folder: src', exact: true }).click();
  await page.getByRole('button', { name: 'Open file: src/example.ts', exact: true }).click();
  await expect.poll(() => !!release).toBe(true);
  try {
    await expect(page.getByRole('button', { name: 'Reload file', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Open file: README.md', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'README.md', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expectEditor(page, 'Keep the already-open README draft.\n');
    await expect(page.getByRole('button', { name: 'Reload file', exact: true })).toBeEnabled();
    const newestDraft = 'Keep typing in README while another file finishes opening.\n';
    await replaceEditor(page, newestDraft);
    release!();
    await expect(page.getByRole('tab', { name: 'example.ts', exact: true })).toHaveAttribute('aria-selected', 'false');
    await expect(page.getByRole('tab', { name: 'README.md', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Reload file', exact: true })).toBeEnabled();
    await expectEditor(page, newestDraft);
  } finally { release?.(); }
});

test('Monaco supports syntax, comments, undo across file tabs, save, find and TypeScript completion', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  const project = (await projects(page)).find(entry => entry.name === 'browser-workspace')!;
  const original = await readFile(join(project.workspace, 'src', 'example.ts'), 'utf8');
  const editor = await openFile(page, 'src/example.ts');
  await expectEditor(page, original);
  await expect.poll(() => page.locator('.monaco-code-editor .view-line span[class^="mtk"]').evaluateAll(tokens => new Set(tokens.map(token => token.className)).size)).toBeGreaterThan(1);
  await editor.focus();
  await editor.press('ControlOrMeta+/');
  const commented = `// ${original}`;
  await expectEditor(page, commented);
  await openFile(page, 'README.md');
  await page.getByRole('tab', { name: 'example.ts', exact: true }).click();
  await editor.focus();
  await editor.press('ControlOrMeta+z');
  await expectEditor(page, original);
  await editor.press('ControlOrMeta+Shift+z');
  await expectEditor(page, commented);
  await editor.press('ControlOrMeta+s');
  await expect.poll(() => readFile(join(project.workspace, 'src', 'example.ts'), 'utf8')).toBe(commented);
  await editor.press('ControlOrMeta+f');
  const find = page.getByRole('textbox', { name: 'Find', exact: true });
  await expect(find).toBeFocused();
  await find.fill('greeting');
  await expect(page.locator('.find-widget .matchesCount')).toContainText('1 of 1');
  await find.press('Escape');

  await editor.focus();
  await editor.press('ControlOrMeta+End');
  await page.keyboard.insertText('\nconst message = "hello";\nmessage.');
  await page.keyboard.type('toU');
  await expect(page.locator('.suggest-widget .monaco-list-row').filter({ hasText: 'toUpperCase' }).first()).toBeVisible();
  await editor.press('Escape');
  expect(errors).toEqual([]);
});

test('Quick Open and workspace search open files at the matched line', async ({ page }) => {
  await page.goto('/');
  const project = (await projects(page)).find(entry => entry.name === 'browser-workspace')!;
  await expect(page.getByRole('tab', { name: 'Files', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+p');
  const quickOpen = page.getByRole('dialog', { name: 'Quick Open', exact: true });
  const query = quickOpen.getByRole('textbox', { name: 'Search files by name', exact: true });
  await expect(query).toBeFocused();
  await query.fill('example.ts');
  await expect(quickOpen.getByRole('option').filter({ hasText: 'src/example.ts' })).toBeEnabled();
  const failedIndex = new URL('api/files/index?query=unavailable', page.url()).href;
  await page.route(failedIndex, route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Quick Open index unavailable.' }) }));
  await query.fill('unavailable');
  await expect(quickOpen.getByRole('alert')).toContainText('Quick Open index unavailable.');
  await expect(quickOpen.getByRole('option')).toHaveCount(0);
  await query.press('Enter');
  await expect(quickOpen).toBeVisible();
  await expect(page.getByRole('tab', { name: 'example.ts', exact: true })).toHaveCount(0);
  await page.unroute(failedIndex);
  await query.fill('example.ts');
  await expect(quickOpen.getByRole('option').filter({ hasText: 'src/example.ts' })).toBeEnabled();
  await query.press('Enter');
  await expect(quickOpen).not.toBeVisible();
  await expectEditor(page, await readFile(join(project.workspace, 'src', 'example.ts'), 'utf8'));
  await expect(page.getByRole('textbox', { name: 'File contents', exact: true })).toBeFocused();
  await page.keyboard.press('ControlOrMeta+Shift+f');
  await page.getByRole('textbox', { name: 'Search in files', exact: true }).fill('Files belong to');
  await page.getByRole('button', { name: 'Open search result: README.md:3:1', exact: true }).click();
  await expectEditor(page, await readFile(join(project.workspace, 'README.md'), 'utf8'));
  await expect(page.locator('.file-editor-footer')).toContainText('Ln 3, Col 1');
});
