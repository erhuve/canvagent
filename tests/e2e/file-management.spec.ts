import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

async function fixture(page: Page) {
  const registry = await (await page.request.get('/api/projects')).json();
  const workspace = join(dirname(registry.projects[0].workspace), `file-management-${randomUUID()}`);
  await mkdir(join(workspace, 'notes', 'nested'), { recursive: true });
  await writeFile(join(workspace, 'existing.txt'), 'Keep this existing file.\n');
  await writeFile(join(workspace, 'notes', 'draft.txt'), 'Original draft.\n');
  await writeFile(join(workspace, 'notes', 'nested', 'other.txt'), 'Other nested file.\n');
  const added = await page.request.post('/api/projects', { data: { workspace } });
  expect(added.ok()).toBe(true);
  const project = await added.json();
  expect((await page.request.get(`${project.path}api/state`)).ok()).toBe(true);
  expect((await page.request.post(`${project.path}api/editor/settings`, { data: { vimEnabled: false } })).ok()).toBe(true);
  await page.goto(project.path);
  await expect(page.getByRole('textbox', { name: 'Message Codex', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open file: existing.txt', exact: true })).toBeVisible();
  return { workspace, path: project.path as string };
}

async function exists(path: string) {
  try { await access(path); return true; } catch { return false; }
}

async function openFile(page: Page, path: string) {
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

async function replaceEditor(page: Page, content: string) {
  const editor = page.getByRole('textbox', { name: 'File contents', exact: true });
  await expect(editor).toHaveJSProperty('readOnly', false);
  await editor.focus();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(content);
}

async function expectEditor(page: Page, path: string, content: string) {
  await expect(page.locator('.monaco-code-editor')).toHaveAttribute('data-file-path', path);
  await expect.poll(() => page.locator('.monaco-code-editor .view-lines .view-line').evaluateAll(lines => lines
    .sort((left, right) => parseFloat((left as HTMLElement).style.top || '0') - parseFloat((right as HTMLElement).style.top || '0'))
    .map(line => (line.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '').trimEnd()).join('\n').trimEnd())).toBe(content.trimEnd());
}

async function rowMenu(page: Page, path: string) {
  await page.getByRole('button', { name: `Actions for ${path}`, exact: true }).click();
  const menu = page.getByRole('menu', { name: `File actions: ${path}`, exact: true });
  await expect(menu).toBeVisible();
  return menu;
}

async function beginRename(page: Page, path: string, kind: 'file' | 'folder') {
  await (await rowMenu(page, path)).getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Rename ${kind}`, exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(path.split('/').at(-1)!);
  return dialog;
}

async function beginDelete(page: Page, path: string, kind: 'file' | 'folder') {
  await (await rowMenu(page, path)).getByRole('menuitem', { name: 'Delete…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: `Delete ${kind}`, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test('creates root and nested files and folders, opens new files, and saves their contents', async ({ page }) => {
  const f = await fixture(page);
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  const newFile = page.getByRole('dialog', { name: 'New file', exact: true });
  await newFile.getByRole('textbox', { name: 'Name', exact: true }).fill('fresh.txt');
  await newFile.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(newFile).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Open file: fresh.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'fresh.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expectEditor(page, 'fresh.txt', '');
  expect(await readFile(join(f.workspace, 'fresh.txt'), 'utf8')).toBe('');
  await replaceEditor(page, 'Written into the new file.\n');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await expect.poll(() => readFile(join(f.workspace, 'fresh.txt'), 'utf8')).toBe('Written into the new file.\n');

  await page.getByRole('button', { name: 'New folder', exact: true }).click();
  const newFolder = page.getByRole('dialog', { name: 'New folder', exact: true });
  await newFolder.getByRole('textbox', { name: 'Name', exact: true }).fill('created');
  await newFolder.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(newFolder).not.toBeVisible();
  expect((await stat(join(f.workspace, 'created'))).isDirectory()).toBe(true);
  await (await rowMenu(page, 'created')).getByRole('menuitem', { name: 'New folder…', exact: true }).click();
  await newFolder.getByRole('textbox', { name: 'Name', exact: true }).fill('nested');
  await newFolder.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(newFolder).not.toBeVisible();
  expect((await stat(join(f.workspace, 'created', 'nested'))).isDirectory()).toBe(true);
  await (await rowMenu(page, 'created/nested')).getByRole('menuitem', { name: 'New file…', exact: true }).click();
  await newFile.getByRole('textbox', { name: 'Name', exact: true }).fill('inside.md');
  await newFile.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(newFile).not.toBeVisible();
  await expectEditor(page, 'created/nested/inside.md', '');
  await replaceEditor(page, '# Nested creation\n');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await expect.poll(() => readFile(join(f.workspace, 'created', 'nested', 'inside.md'), 'utf8')).toBe('# Nested creation\n');
});

test('right-click replaces the native menu and file actions are keyboard accessible', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => document.addEventListener('contextmenu', event => {
    (window as unknown as { explorerContextEvent: Event }).explorerContextEvent = event;
  }, { capture: true }));
  const row = page.getByRole('button', { name: 'Open file: existing.txt', exact: true });
  await row.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'File actions: existing.txt', exact: true });
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { explorerContextEvent: Event }).explorerContextEvent.defaultPrevented)).toBe(true);
  await expect(menu.getByRole('menuitem', { name: 'Rename…', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Delete…', exact: true })).toBeVisible();
  if (process.env.CANVAGENT_FILE_ACTIONS_SCREENSHOT) await page.screenshot({ path: '/tmp/canvagent-file-actions.png' });
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await row.focus();
  await row.press('Shift+F10');
  await expect(menu).toBeVisible();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  await page.keyboard.press('Home');
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).not.toBeVisible();
  await expect(row).toBeFocused();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => { (window as unknown as { copiedRelativePath: string }).copiedRelativePath = value; } },
  }));
  await (await rowMenu(page, 'existing.txt')).getByRole('menuitem', { name: 'Copy relative path', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { copiedRelativePath: string }).copiedRelativePath)).toBe('existing.txt');
  await expect(page.getByRole('status').filter({ hasText: /Copied/ })).toBeVisible();
  await row.focus();
  await row.press('F2');
  const rename = page.getByRole('dialog', { name: 'Rename file', exact: true });
  await expect(rename).toBeVisible();
  await expect(rename.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('existing.txt');
  await rename.getByRole('button', { name: 'Cancel', exact: true }).click();
  await row.focus();
  await row.press('Delete');
  const deletion = page.getByRole('dialog', { name: 'Delete file', exact: true });
  await expect(deletion).toBeVisible();
  await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('.file-tree').click({ button: 'right', position: { x: 10, y: 300 } });
  await expect(page.getByRole('menu', { name: 'Project file actions', exact: true })).toBeVisible();
});

test('renaming a dirty file saves its draft and keeps the tab and future saves on the new path', async ({ page }) => {
  const f = await fixture(page);
  await openFile(page, 'existing.txt');
  await replaceEditor(page, 'Unsaved draft before rename.\n');
  let dialog = await beginRename(page, 'existing.txt', 'file');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('renamed.txt');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expectEditor(page, 'existing.txt', 'Unsaved draft before rename.\n');
  expect(await readFile(join(f.workspace, 'existing.txt'), 'utf8')).toBe('Keep this existing file.\n');
  dialog = await beginRename(page, 'existing.txt', 'file');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('renamed.txt');
  await dialog.getByRole('button', { name: 'Save and rename', exact: true }).click();
  await expect(dialog).toContainText(/Edits saved/);
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expectEditor(page, 'renamed.txt', 'Unsaved draft before rename.\n');
  await expect(page.getByRole('tab', { name: 'renamed.txt', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'existing.txt', exact: true })).toHaveCount(0);
  expect(await exists(join(f.workspace, 'existing.txt'))).toBe(false);
  expect(await readFile(join(f.workspace, 'renamed.txt'), 'utf8')).toBe('Unsaved draft before rename.\n');
  await replaceEditor(page, 'Saved after the rename.\n');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await expect.poll(() => readFile(join(f.workspace, 'renamed.txt'), 'utf8')).toBe('Saved after the rename.\n');
  expect(await exists(join(f.workspace, 'existing.txt'))).toBe(false);
});

test('renaming a folder updates every open descendant and preserves saved drafts', async ({ page }) => {
  const f = await fixture(page);
  await openFile(page, 'notes/draft.txt');
  await replaceEditor(page, 'Draft carried through folder rename.\n');
  await openFile(page, 'notes/nested/other.txt');
  const dialog = await beginRename(page, 'notes', 'folder');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('renamed-notes');
  await dialog.getByRole('button', { name: 'Save and rename', exact: true }).click();
  await expect(dialog).toContainText(/Edits saved/);
  await dialog.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expectEditor(page, 'renamed-notes/nested/other.txt', 'Other nested file.\n');
  await expect(page.getByRole('button', { name: 'Close file: renamed-notes/draft.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close file: renamed-notes/nested/other.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close file: notes/draft.txt', exact: true })).toHaveCount(0);
  await page.getByRole('tab', { name: 'draft.txt', exact: true }).click();
  await expectEditor(page, 'renamed-notes/draft.txt', 'Draft carried through folder rename.\n');
  expect(await readFile(join(f.workspace, 'renamed-notes', 'draft.txt'), 'utf8')).toBe('Draft carried through folder rename.\n');
  await replaceEditor(page, 'A later save uses the renamed folder.\n');
  await page.getByRole('button', { name: 'Save file', exact: true }).click();
  await expect.poll(() => readFile(join(f.workspace, 'renamed-notes', 'draft.txt'), 'utf8')).toBe('A later save uses the renamed folder.\n');
  expect(await exists(join(f.workspace, 'notes'))).toBe(false);
});

test('deleting a folder requires confirmation, closes only descendant tabs, and can be undone', async ({ page }) => {
  const f = await fixture(page);
  await openFile(page, 'existing.txt');
  await openFile(page, 'notes/draft.txt');
  await openFile(page, 'notes/nested/other.txt');
  let dialog = await beginDelete(page, 'notes', 'folder');
  await expect(dialog).toContainText('notes');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await exists(join(f.workspace, 'notes', 'nested', 'other.txt'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Close file: notes/draft.txt', exact: true })).toBeVisible();
  dialog = await beginDelete(page, 'notes', 'folder');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => exists(join(f.workspace, 'notes'))).toBe(false);
  await expect(page.getByRole('button', { name: 'Actions for notes', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Close file: notes/draft.txt', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Close file: notes/nested/other.txt', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'existing.txt', exact: true })).toBeVisible();
  expect(await readFile(join(f.workspace, 'existing.txt'), 'utf8')).toBe('Keep this existing file.\n');
  await page.getByRole('button', { name: 'Undo delete', exact: true }).click();
  await expect.poll(() => exists(join(f.workspace, 'notes', 'draft.txt'))).toBe(true);
  expect(await readFile(join(f.workspace, 'notes', 'draft.txt'), 'utf8')).toBe('Original draft.\n');
  expect(await readFile(join(f.workspace, 'notes', 'nested', 'other.txt'), 'utf8')).toBe('Other nested file.\n');
  await expect(page.getByRole('button', { name: 'Close file: notes/draft.txt', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close file: notes/nested/other.txt', exact: true })).toBeVisible();
});

test('canceling deletion keeps dirty editor contents and saving before trash preserves the latest draft', async ({ page }) => {
  const f = await fixture(page);
  await openFile(page, 'existing.txt');
  await replaceEditor(page, 'Save this draft before moving the file to trash.\n');
  let dialog = await beginDelete(page, 'existing.txt', 'file');
  await expect(dialog).toContainText(/unsaved/i);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expectEditor(page, 'existing.txt', 'Save this draft before moving the file to trash.\n');
  expect(await readFile(join(f.workspace, 'existing.txt'), 'utf8')).toBe('Keep this existing file.\n');
  const writes: Array<{ path: string; content: string }> = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/api/files/content')) writes.push(request.postDataJSON());
  });
  dialog = await beginDelete(page, 'existing.txt', 'file');
  await dialog.getByRole('button', { name: 'Save and delete', exact: true }).click();
  await expect(dialog).toContainText(/Edits saved/);
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(writes).toContainEqual(expect.objectContaining({ path: 'existing.txt', content: 'Save this draft before moving the file to trash.\n' }));
  await expect.poll(() => exists(join(f.workspace, 'existing.txt'))).toBe(false);
  await expect(page.getByRole('tab', { name: 'existing.txt', exact: true })).toHaveCount(0);
});

test('a failed save before deleting preserves the editor draft and newer disk contents', async ({ page }) => {
  const f = await fixture(page);
  await openFile(page, 'existing.txt');
  await replaceEditor(page, 'Keep my unsaved local draft.\n');
  const dialog = await beginDelete(page, 'existing.txt', 'file');
  await expect(dialog.getByRole('button', { name: 'Save and delete', exact: true })).toBeEnabled();
  await writeFile(join(f.workspace, 'existing.txt'), 'A newer external version.\n');
  await dialog.getByRole('button', { name: 'Save and delete', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(/changed|save|newer|conflict/i);
  expect(await readFile(join(f.workspace, 'existing.txt'), 'utf8')).toBe('A newer external version.\n');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expectEditor(page, 'existing.txt', 'Keep my unsaved local draft.\n');
});

test('a file changed after opening the deletion dialog cannot be removed by stale confirmation', async ({ page }) => {
  const f = await fixture(page);
  await openFile(page, 'existing.txt');
  const dialog = await beginDelete(page, 'existing.txt', 'file');
  await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
  await writeFile(join(f.workspace, 'existing.txt'), 'Newer contents while the delete dialog was open.\n');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(/changed on disk|newer|conflict/i);
  expect(await readFile(join(f.workspace, 'existing.txt'), 'utf8')).toBe('Newer contents while the delete dialog was open.\n');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open file: existing.txt', exact: true })).toBeVisible();
});

test('undo deletion never overwrites a newer file and recovery can be retried after resolving the collision', async ({ page }) => {
  const f = await fixture(page);
  await openFile(page, 'existing.txt');
  const dialog = await beginDelete(page, 'existing.txt', 'file');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => exists(join(f.workspace, 'existing.txt'))).toBe(false);
  await writeFile(join(f.workspace, 'existing.txt'), 'New file at the original path.\n');
  const undo = page.getByRole('button', { name: 'Undo delete', exact: true });
  await undo.click();
  await expect(page.getByRole('alert').filter({ hasText: /already exists|overwrite/i })).toBeVisible();
  expect(await readFile(join(f.workspace, 'existing.txt'), 'utf8')).toBe('New file at the original path.\n');
  await expect(undo).toBeEnabled();
  await unlink(join(f.workspace, 'existing.txt'));
  await undo.click();
  await expect.poll(() => exists(join(f.workspace, 'existing.txt'))).toBe(true);
  expect(await readFile(join(f.workspace, 'existing.txt'), 'utf8')).toBe('Keep this existing file.\n');
  await expectEditor(page, 'existing.txt', 'Keep this existing file.\n');
});

test('successful undo reports a temporary editor reopen failure without misclassifying the restored file', async ({ page }) => {
  const f = await fixture(page);
  await openFile(page, 'existing.txt');
  const dialog = await beginDelete(page, 'existing.txt', 'file');
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => exists(join(f.workspace, 'existing.txt'))).toBe(false);
  let failedReopen = false;
  const contentsUrl = new URL('api/files/content?path=existing.txt', page.url()).href;
  await page.route(contentsUrl, async route => {
    if (!failedReopen) {
      failedReopen = true;
      await route.fulfill({ status: 503, json: { error: 'The editor could not reopen this restored file just now.' } });
    } else await route.continue();
  });
  await page.getByRole('button', { name: 'Undo delete', exact: true }).click();
  await expect.poll(() => exists(join(f.workspace, 'existing.txt'))).toBe(true);
  expect(await readFile(join(f.workspace, 'existing.txt'), 'utf8')).toBe('Keep this existing file.\n');
  const restoredNotice = page.getByRole('status').filter({ hasText: /restored/i });
  await expect(restoredNotice).toContainText(/reopen|could not.*open|couldn't.*open/i);
  await expect(page.getByRole('button', { name: 'Undo delete', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'existing.txt', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Download file', exact: true })).toHaveCount(0);
  await openFile(page, 'existing.txt');
  await expectEditor(page, 'existing.txt', 'Keep this existing file.\n');
});

test('invalid and duplicate creation or rename names show inline errors without overwriting files', async ({ page }) => {
  const f = await fixture(page);
  await page.getByRole('button', { name: 'New file', exact: true }).click();
  const create = page.getByRole('dialog', { name: 'New file', exact: true });
  await create.getByRole('textbox', { name: 'Name', exact: true }).fill('../escape.txt');
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(create.getByRole('alert')).toContainText(/name|path|slash|separator|invalid/i);
  expect(await exists(join(dirname(f.workspace), 'escape.txt'))).toBe(false);
  await create.getByRole('textbox', { name: 'Name', exact: true }).fill('existing.txt');
  await create.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(create.getByRole('alert')).toContainText(/already exists/i);
  expect(await readFile(join(f.workspace, 'existing.txt'), 'utf8')).toBe('Keep this existing file.\n');
  await create.getByRole('button', { name: 'Cancel', exact: true }).click();
  await openFile(page, 'notes/draft.txt');
  const rename = await beginRename(page, 'notes/draft.txt', 'file');
  await rename.getByRole('textbox', { name: 'Name', exact: true }).fill('nested');
  await rename.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(rename.getByRole('alert')).toContainText(/already exists/i);
  expect(await readFile(join(f.workspace, 'notes', 'draft.txt'), 'utf8')).toBe('Original draft.\n');
  expect(await readFile(join(f.workspace, 'notes', 'nested', 'other.txt'), 'utf8')).toBe('Other nested file.\n');
  await rename.getByRole('button', { name: 'Cancel', exact: true }).click();
});
