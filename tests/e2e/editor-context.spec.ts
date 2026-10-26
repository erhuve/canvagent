import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

async function fixture(page: Page) {
  const registry = await (await page.request.get('/api/projects')).json();
  const workspace = join(dirname(registry.projects[0].workspace), `editor-context-${randomUUID()}`);
  await mkdir(workspace);
  await writeFile(join(workspace, 'selection.txt'), 'first line\nsecond line\nthird line\n');
  const added = await page.request.post('/api/projects', { data: { workspace } });
  expect(added.ok()).toBe(true);
  const project = await added.json();
  expect((await page.request.get(`${project.path}api/state`)).ok()).toBe(true);
  expect((await page.request.post(`${project.path}api/editor/settings`, { data: { vimEnabled: false } })).ok()).toBe(true);
  await page.goto(project.path);
  await expect(page.getByRole('textbox', { name: 'Message Codex', exact: true })).toBeVisible();
  return { workspace, path: project.path as string };
}

async function openEditor(page: Page) {
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByRole('button', { name: 'Open file: selection.txt', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'File contents', exact: true });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveJSProperty('readOnly', false);
  return editor;
}

test('editor attaches selected lines, saves their latest contents, and preserves the chat draft', async ({ page }) => {
  const f = await fixture(page);
  const draft = page.getByRole('textbox', { name: 'Message Codex', exact: true });
  await draft.fill('Please explain this selection without losing my draft.');
  const editor = await openEditor(page);
  const changed = 'first line\nupdated second line\nthird line\n';
  await editor.focus();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText(changed);
  await editor.press(process.platform === 'darwin' ? 'Meta+ArrowUp' : 'Control+Home');
  await editor.press('ArrowDown');
  await editor.press('Shift+ArrowDown');
  const attach = page.getByRole('button', { name: 'Attach to chat', exact: true });
  await expect(attach).toHaveAttribute('title', /Save and attach lines 2–2/);
  await attach.click();
  await expect.poll(() => readFile(join(f.workspace, 'selection.txt'), 'utf8')).toBe(changed);
  await expect(draft).toHaveValue('Please explain this selection without losing my draft.');
  await expect(draft).toBeFocused();
  await page.getByRole('button', { name: 'Preview context: selection.txt:2-2', exact: true }).click();
  const preview = page.getByRole('region', { name: 'Context preview: selection.txt:2-2', exact: true });
  await expect(preview.locator('pre')).toHaveText('updated second line');
  await writeFile(join(f.workspace, 'selection.txt'), 'new external edit\n');
  await expect(preview.locator('pre')).toHaveText('updated second line');
});

test('editor shortcut and context menu can attach file context', async ({ page }) => {
  await fixture(page);
  const editor = await openEditor(page);
  await editor.focus();
  await editor.press('ControlOrMeta+Shift+A');
  await expect(page.getByRole('button', { name: 'Preview context: selection.txt', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove context: selection.txt', exact: true }).click();
  await editor.focus();
  await page.locator('.monaco-code-editor .view-line').first().click({ button: 'right' });
  // Monaco intentionally ignores menu mouse-up events for its first 100 ms.
  await page.getByRole('menuitem', { name: /Add selection to chat/ }).click({ delay: 150 });
  await page.getByRole('button', { name: 'Preview context: selection.txt', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Context preview: selection.txt', exact: true }).locator('pre')).toHaveText('first line\nsecond line\nthird line\n');
});

test('failed save blocks attaching stale editor context and preserves both versions', async ({ page }) => {
  const f = await fixture(page);
  const editor = await openEditor(page);
  await editor.focus();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText('unsaved local version\n');
  await writeFile(join(f.workspace, 'selection.txt'), 'newer external version\n');
  await page.getByRole('button', { name: 'Attach to chat', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: /changed on disk/ })).toBeVisible();
  expect(await readFile(join(f.workspace, 'selection.txt'), 'utf8')).toBe('newer external version\n');
  await expect(page.locator('.monaco-code-editor .view-line').first()).toContainText('unsaved local version');
  await expect(page.getByRole('button', { name: /^Preview context:/ })).toHaveCount(0);
});

test('switching conversations during save keeps editor context out of the new draft', async ({ page }) => {
  const f = await fixture(page);
  const editor = await openEditor(page);
  await editor.focus();
  await editor.press('ControlOrMeta+A');
  await page.keyboard.insertText('saved for the original conversation\n');
  let releaseSave: (() => void) | undefined;
  let saveStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { saveStarted = resolve; });
  await page.route('**/api/files/content', async route => {
    if (route.request().method() === 'POST') {
      const released = new Promise<void>(resolve => { releaseSave = resolve; });
      saveStarted?.(); await released;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Attach to chat', exact: true }).click();
  await started;
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'What are we working on?', exact: true })).toBeVisible();
  releaseSave?.();
  await expect.poll(() => readFile(join(f.workspace, 'selection.txt'), 'utf8')).toBe('saved for the original conversation\n');
  await expect(page.getByRole('status').filter({ hasText: 'Return to the original conversation to attach this selection.' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Preview context:/ })).toHaveCount(0);
});
