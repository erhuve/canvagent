import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

async function freshProject(page: Page) {
  const registry = await (await page.request.get('/api/projects')).json();
  const workspace = join(dirname(registry.projects[0].workspace), `vim-${randomUUID()}`);
  await mkdir(workspace);
  await writeFile(join(workspace, 'vim.txt'), 'first line\nsecond line\nthird line\n');
  const added = await page.request.post('/api/projects', { data: { workspace } });
  expect(added.ok()).toBe(true);
  const project = await added.json();
  expect((await page.request.get(`${project.path}api/state`)).ok()).toBe(true);
  return { path: project.path as string, workspace };
}
async function openEditor(page: Page) {
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Open file: vim.txt', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'File contents', exact: true });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveJSProperty('readOnly', false);
  return editor;
}
async function editorText(page: Page) {
  // Monaco reuses line nodes after undo; DOM insertion order need not match
  // their rendered line order. The workflow also checks saved bytes below.
  return page.locator('.monaco-code-editor .view-lines .view-line').evaluateAll(lines => [...lines]
    .sort((left, right) => parseFloat((left as HTMLElement).style.top) - parseFloat((right as HTMLElement).style.top))
    .map(line => (line.textContent ?? '').replace(/\u00a0/g, ' ').replace(/\u200b/g, '').trimEnd()).join('\n').trimEnd());
}
async function expectEditor(page: Page, content: string) { await expect.poll(() => editorText(page)).toBe(content.trimEnd()); }

test('Vim starts in NORMAL, supports insert, motions, deletion, undo, and writes with :w', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const project = await freshProject(page);
  expect(await (await page.request.get(`${project.path}api/editor/settings`)).json()).toMatchObject({ vimEnabled: true });
  await page.goto(project.path);
  const editor = await openEditor(page);
  const status = page.locator('[aria-label="Vim status"]');
  await expect(page.getByRole('button', { name: 'Vim key bindings', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(status).toContainText('NORMAL');
  await editor.focus();
  await editor.press('i');
  await expect(status).toContainText('INSERT');
  await page.keyboard.type('edited ');
  await page.keyboard.press('Escape');
  await expect(status).toContainText('NORMAL');
  const edited = 'edited first line\nsecond line\nthird line\n';
  await expectEditor(page, edited);
  await page.keyboard.type('ggdd');
  await expectEditor(page, 'second line\nthird line\n');
  await page.keyboard.type('u');
  await page.keyboard.type(':w');
  await page.keyboard.press('Enter');
  await expect.poll(() => readFile(join(project.workspace, 'vim.txt'), 'utf8')).toBe(edited);
  await expectEditor(page, edited);
  await page.keyboard.type('gg>>');
  await expect.poll(() => editorText(page)).toMatch(/^ +edited first line\nsecond line\nthird line$/);
  await page.keyboard.type('<<');
  await expectEditor(page, edited);
  await page.keyboard.type(':w');
  await page.keyboard.press('Enter');
  await expect.poll(() => readFile(join(project.workspace, 'vim.txt'), 'utf8')).toBe(edited);
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeDisabled();
  await expect(status).toContainText('NORMAL');
  await editor.focus();
  await page.keyboard.type('ggA');
  await page.keyboard.type(' saved with shortcut');
  await page.keyboard.press('Escape');
  const shortcutSaved = 'edited first line saved with shortcut\nsecond line\nthird line\n';
  await expectEditor(page, shortcutSaved);
  await editor.press('ControlOrMeta+s');
  await expect.poll(() => readFile(join(project.workspace, 'vim.txt'), 'utf8')).toBe(shortcutSaved);
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeDisabled();
  if (process.platform === 'darwin') {
    await editor.focus();
    await editor.press('Control+f');
    await expect(page.getByRole('textbox', { name: 'Find', exact: true })).toBeHidden();
    await editor.press('Control+p');
    await expect(page.getByRole('dialog', { name: 'Quick Open', exact: true })).toBeHidden();
    await expect(page.getByRole('textbox', { name: 'Find', exact: true })).toBeHidden();
  }
  expect(errors).toEqual([]);
});

test('disabling Vim restores ordinary typing and persists in the project after reload', async ({ page }) => {
  const project = await freshProject(page);
  await page.goto(project.path);
  let editor = await openEditor(page);
  const toggle = page.getByRole('button', { name: 'Vim key bindings', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toBeEnabled();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(async () => (await (await page.request.get(`${project.path}api/editor/settings`)).json()).vimEnabled).toBe(false);
  await expect(page.locator('[aria-label="Vim status"]')).toBeHidden();
  await editor.focus();
  await editor.press('ControlOrMeta+A');
  const ordinary = 'Ordinary typing without insert mode.\n';
  await page.keyboard.type(ordinary);
  await expectEditor(page, ordinary);
  await editor.press('ControlOrMeta+s');
  await expect.poll(() => readFile(join(project.workspace, 'vim.txt'), 'utf8')).toBe(ordinary);
  await expect(page.getByRole('button', { name: 'Save file', exact: true })).toBeDisabled();
  await page.reload();
  editor = await openEditor(page);
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[aria-label="Vim status"]')).toBeHidden();
  await expectEditor(page, ordinary);
  await editor.focus();
  await editor.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.type('Still ordinary after reload.');
  await expectEditor(page, `${ordinary}Still ordinary after reload.`);
  await editor.press('ControlOrMeta+s');
  await expect.poll(() => readFile(join(project.workspace, 'vim.txt'), 'utf8')).toBe(`${ordinary}Still ordinary after reload.`);
  const other = await freshProject(page);
  expect(await (await page.request.get(`${other.path}api/editor/settings`)).json()).toMatchObject({ vimEnabled: true });
  expect(await (await page.request.get(`${project.path}api/editor/settings`)).json()).toMatchObject({ vimEnabled: false });
});
