import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');

async function project(page: Page) {
  const registry = await (await page.request.get('/api/projects')).json();
  const workspace = join(dirname(registry.projects[0].workspace), `context-${randomUUID()}`);
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'src', 'greeting.ts'), 'export const greeting = "hello context";\nexport const second = 2;\n');
  await writeFile(join(workspace, 'notes.md'), 'Notes for our context test.\n');
  await writeFile(join(workspace, 'design.png'), pixel);
  const added = await page.request.post('/api/projects', { data: { workspace } });
  expect(added.ok()).toBe(true);
  const path = (await added.json()).path as string;
  await page.goto(path);
  await expect(page.getByRole('status', { name: 'Codex connected', exact: true })).toBeVisible();
  return { workspace, path, state: async () => (await page.request.get(`${path}api/state`)).json() };
}

function input(page: Page) { return page.getByRole('textbox', { name: 'Message Codex', exact: true }); }
function composerAttachments(page: Page) { return page.locator('.composer .context-attachments'); }
async function uploadImage(page: Page, name = 'reference.png') {
  await page.getByLabel('Choose images', { exact: true }).setInputFiles({ name, mimeType: 'image/png', buffer: pixel });
  await expect(composerAttachments(page).getByRole('button', { name: `Preview context: ${name}`, exact: true })).toBeVisible();
}
async function pasteImage(page: Page, name = 'pasted.png') {
  await input(page).evaluate((element, { bytes, fileName }) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(bytes)], fileName, { type: 'image/png' }));
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, { bytes: [...pixel], fileName: name });
}

test('mentions attach an explicit immutable file snapshot with keyboard navigation and preview', async ({ page }) => {
  const fixture = await project(page);
  await input(page).fill('[chat] Explain @greet');
  const options = page.getByRole('listbox', { name: 'Context suggestions' });
  await expect(options.getByRole('option').filter({ hasText: 'greeting.ts' }).first()).toBeVisible();
  await input(page).press('ArrowDown');
  await input(page).press('ArrowUp');
  await input(page).press('Enter');
  await expect(options).toHaveCount(0);
  const preview = composerAttachments(page).getByRole('button', { name: /Preview context: .*greeting\.ts/ });
  await expect(preview).toBeVisible();
  expect((await fixture.state()).sessions[0].messages).toHaveLength(0);
  await preview.click();
  await expect(page.getByText('What the agent receives', { exact: false })).toBeVisible();
  await expect(page.locator('.composer .context-preview pre')).toContainText('hello context');
  await writeFile(join(fixture.workspace, 'src', 'greeting.ts'), 'export const greeting = "changed after attaching";\n');
  await expect(page.locator('.composer .context-preview pre')).toContainText('hello context');
  await page.getByRole('button', { name: 'Send message to Codex', exact: true }).click();
  await expect(composerAttachments(page).getByRole('button', { name: /Preview context/ })).toHaveCount(0);
  await expect(page.locator('.message-user').getByRole('button', { name: /Preview context: .*greeting\.ts/ })).toBeVisible();
  const state = await fixture.state();
  const sent = state.sessions.find((session: any) => session.id === state.activeSessionId).messages.find((message: any) => message.role === 'user');
  expect(sent.attachments).toHaveLength(1);
  expect(sent.attachments[0]).toMatchObject({ kind: 'file', path: 'src/greeting.ts' });
  expect(sent.attachments[0].text).toContain('hello context');
  expect(sent.attachments[0].text).not.toContain('changed after attaching');
});

test('context picker supports search and removing context without altering the draft', async ({ page }) => {
  await project(page);
  await input(page).fill('Keep this text while attaching context.');
  await page.getByRole('button', { name: 'Add context', exact: true }).click();
  const search = page.getByRole('combobox', { name: 'Search context', exact: true });
  await search.fill('notes');
  await expect(page.getByRole('option').filter({ hasText: 'notes.md' })).toBeVisible();
  await search.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Attach context', exact: true })).toHaveCount(0);
  const attachment = composerAttachments(page).getByRole('button', { name: /Remove context: .*notes\.md/ });
  await expect(attachment).toBeVisible();
  await attachment.click();
  await expect(composerAttachments(page)).toHaveCount(0);
  await expect(input(page)).toHaveValue('Keep this text while attaching context.');
  await input(page).fill('@does-not-exist');
  await expect(page.getByText('No matching context. Try a file name or conversation title.')).toBeVisible();
  await input(page).press('Escape');
  await expect(page.getByRole('listbox', { name: 'Context suggestions' })).toHaveCount(0);
  await expect(input(page)).toHaveValue('@does-not-exist');
});

test('pasted images survive reload as references, send without text, and remain visible in history', async ({ page }) => {
  const fixture = await project(page);
  await pasteImage(page);
  const chip = composerAttachments(page).getByRole('button', { name: 'Preview context: pasted.png', exact: true });
  await expect(chip).toBeVisible();
  await expect(input(page)).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Send message to Codex', exact: true })).toBeEnabled();
  const browserStorage = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
  expect(browserStorage).toContain('pasted.png');
  expect(browserStorage).not.toContain('base64');
  expect(browserStorage).not.toContain('iVBOR');
  await page.reload();
  await expect(chip).toBeVisible();
  await chip.click();
  const image = page.locator('.composer .context-preview img');
  await expect(image).toBeVisible();
  expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(1);
  await input(page).press('Enter');
  await expect(page.locator('.message-user').getByRole('button', { name: 'Preview context: pasted.png', exact: true })).toBeVisible();
  await expect(composerAttachments(page).getByRole('button', { name: 'Preview context: pasted.png', exact: true })).toHaveCount(0);
  const state = await fixture.state();
  const sent = state.sessions.find((session: any) => session.id === state.activeSessionId).messages.find((message: any) => message.role === 'user');
  expect(sent.text).toBe('');
  expect(sent.attachments[0]).toMatchObject({ kind: 'image', label: 'pasted.png', mimeType: 'image/png' });
  expect(JSON.stringify(sent)).not.toContain('base64');
  await page.reload();
  await expect(page.locator('.message-user').getByRole('button', { name: 'Preview context: pasted.png', exact: true })).toBeVisible();
});

test('uploads block sends and remain with their source conversation after navigation', async ({ page }) => {
  const fixture = await project(page);
  await input(page).fill('[chat] Source conversation');
  await input(page).press('Enter');
  await expect.poll(async () => {
    const state = await fixture.state();
    return state.sessions.find((session: any) => session.id === state.activeSessionId).status;
  }).toBe('idle');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/context/images', async route => { await gate; await route.continue(); });
  await pasteImage(page, 'background.png');
  await expect(composerAttachments(page).getByRole('status')).toContainText('Attaching');
  await input(page).fill('Draft with a background attachment');
  await expect(page.getByRole('button', { name: 'Send message to Codex', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect(input(page)).toHaveValue('');
  release();
  await expect(composerAttachments(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Open conversation: [chat] Source conversation', exact: true }).click();
  await expect(composerAttachments(page).getByRole('button', { name: 'Preview context: background.png', exact: true })).toBeVisible();
  await expect(input(page)).toHaveValue('Draft with a background attachment');
});

test('a rejected send preserves attachments and draft; accepted send preserves text typed meanwhile', async ({ page }) => {
  await project(page);
  await uploadImage(page);
  await input(page).fill('[chat] Original draft');
  await page.route('**/api/sessions/*/messages', route => route.fulfill({ status: 503, json: { error: 'Fixture send rejected' } }), { times: 1 });
  await input(page).press('Enter');
  await expect(page.getByText('Fixture send rejected', { exact: true })).toBeVisible();
  await expect(input(page)).toHaveValue('[chat] Original draft');
  await expect(composerAttachments(page).getByRole('button', { name: 'Preview context: reference.png', exact: true })).toBeVisible();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/sessions/*/messages', async route => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  }, { times: 1 });
  await page.getByRole('button', { name: 'Send message to Codex', exact: true }).click();
  await expect(page.locator('.message-user').getByRole('button', { name: 'Preview context: reference.png', exact: true })).toBeVisible();
  await input(page).fill('A newer draft typed while the request finishes.');
  await uploadImage(page, 'newer.png');
  release();
  await expect(composerAttachments(page).getByRole('button', { name: 'Preview context: reference.png', exact: true })).toHaveCount(0);
  await expect(input(page)).toHaveValue('A newer draft typed while the request finishes.');
  await expect(composerAttachments(page).getByRole('button', { name: 'Preview context: newer.png', exact: true })).toBeVisible();
  await page.reload();
  await expect(input(page)).toHaveValue('A newer draft typed while the request finishes.');
  await expect(composerAttachments(page).getByRole('button', { name: 'Preview context: newer.png', exact: true })).toBeVisible();
});

test('removing restoring context prevents a late restore failure from replacing a newer attachment', async ({ page }) => {
  await project(page);
  await uploadImage(page, 'old.png');
  await uploadImage(page, 'second-old.png');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/context/attachments?ids=*', async route => {
    await gate;
    await route.fulfill({ status: 503, json: { error: 'Restore request failed late' } });
  }, { times: 1 });
  await page.reload();
  await expect(composerAttachments(page).getByRole('status')).toHaveCount(2);
  await composerAttachments(page).getByRole('button', { name: 'Remove context: old.png', exact: true }).click();
  const saved = await page.evaluate(() => JSON.stringify({ ...sessionStorage }));
  expect(saved).not.toContain('\\"label\\":\\"old.png\\"');
  expect(saved).toContain('second-old.png');
  await composerAttachments(page).getByRole('button', { name: 'Remove context: second-old.png', exact: true }).click();
  await uploadImage(page, 'replacement.png');
  const response = page.waitForResponse(response => response.url().includes('/api/context/attachments?ids=') && response.status() === 503);
  release();
  await response;
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await expect(composerAttachments(page).getByRole('button', { name: 'Preview context: replacement.png', exact: true })).toBeVisible();
  await expect(composerAttachments(page).getByRole('button', { name: 'Remove context: old.png', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message to Codex', exact: true })).toBeEnabled();
});

test('sending a restored draft without editing clears its text and context after acceptance', async ({ page }) => {
  await project(page);
  await uploadImage(page, 'restored.png');
  await input(page).fill('[chat] Send this restored draft once.');
  await page.reload();
  await expect(input(page)).toHaveValue('[chat] Send this restored draft once.');
  await expect(composerAttachments(page).getByRole('button', { name: 'Preview context: restored.png', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message to Codex', exact: true })).toBeEnabled();
  await input(page).press('Enter');
  await expect(input(page)).toHaveValue('');
  await expect(composerAttachments(page)).toHaveCount(0);
  await expect(page.locator('.message-user')).toHaveCount(1);
});

test('editor selection events attach source lines and reject references from another project', async ({ page }) => {
  const fixture = await project(page);
  await input(page).fill('Keep my draft.');
  await page.evaluate(workspace => window.dispatchEvent(new CustomEvent('canvagent:attach-context', { detail: { reference: { kind: 'file', path: 'src/greeting.ts', startLine: 2, endLine: 2 }, projectWorkspace: workspace } })), fixture.workspace);
  const preview = composerAttachments(page).getByRole('button', { name: /Preview context: .*greeting\.ts/ });
  await expect(preview).toBeVisible();
  await preview.click();
  await expect(page.locator('.composer .context-preview pre')).toContainText('second = 2');
  await expect(page.locator('.composer .context-preview pre')).not.toContainText('hello context');
  await expect(input(page)).toHaveValue('Keep my draft.');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('canvagent:attach-context', { detail: { reference: { kind: 'file', path: 'notes.md' }, projectWorkspace: '/another/workspace' } })));
  await expect(composerAttachments(page).getByRole('button', { name: /Preview context: .*notes\.md/ })).toHaveCount(0);
});

test('agents without image input show a clear error on paste and disable image attachment', async ({ page }) => {
  const fixture = await project(page);
  const snapshot = await fixture.state();
  snapshot.runtime.capabilities = { ...snapshot.runtime.capabilities, imageInput: false };
  await page.route('**/api/state', route => route.fulfill({ json: snapshot }));
  await page.routeWebSocket('**/api/events', route => route.send(JSON.stringify({ type: 'state', state: snapshot })));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Attach images', exact: true })).toBeDisabled();
  await pasteImage(page);
  await expect(page.getByRole('alert').filter({ hasText: 'This agent does not accept images' })).toBeVisible();
  await expect(composerAttachments(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message to Codex', exact: true })).toBeDisabled();
  await input(page).fill('@design');
  await expect(page.getByRole('option').filter({ hasText: 'design.png' })).toBeVisible();
  await input(page).press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: 'This agent does not accept images' })).toBeVisible();
  await expect(composerAttachments(page)).toHaveCount(0);
});

test('dropping images attaches them, while unsupported files and oversize images report errors', async ({ page }) => {
  await project(page);
  const droppedImage = await readFile(join(process.cwd(), 'public', 'brand', 'app-icon.png'));
  await input(page).evaluate((element, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([Uint8Array.from(bytes)], 'dropped.png', { type: 'image/png' }));
    element.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, [...droppedImage]);
  await expect(composerAttachments(page).getByRole('button', { name: 'Preview context: dropped.png', exact: true })).toBeVisible();
  await input(page).fill('Help me refine this mark using the attached project notes.');
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('canvagent:attach-context', { detail: { reference: { kind: 'file', path: 'notes.md' } } })));
  await expect(composerAttachments(page).getByRole('button', { name: 'Preview context: notes.md', exact: true })).toBeVisible();
  await composerAttachments(page).getByRole('button', { name: 'Preview context: dropped.png', exact: true }).click();
  await expect(page.locator('.composer .context-preview img')).toBeVisible();
  await page.locator('.conversation-pane').screenshot({ path: '/tmp/canvagent-context.png' });
  await page.getByLabel('Choose images', { exact: true }).setInputFiles({ name: 'document.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
  await expect(page.getByRole('alert').filter({ hasText: 'Use a PNG, JPEG, WebP, or GIF image.' })).toBeVisible();
  await page.getByLabel('Choose images', { exact: true }).setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
  await expect(page.getByRole('alert').filter({ hasText: 'must be between 1 byte and 10 MB' })).toBeVisible();
});
