import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

type Project = { id: string; name: string; workspace: string; activeSessionId: string; sessions: { id: string; title: string; status: string }[] };

async function projects(page: Page): Promise<Project[]> {
  return (await (await page.request.get('/api/projects')).json()).projects;
}

async function state(page: Page, project?: Project) {
  const url = project ? new URL(`/projects/${project.id}/api/state`, page.url()).href : new URL('api/state', page.url()).href;
  return (await (await page.request.get(url)).json());
}

async function openProject(page: Page, name: string) {
  const project = (await projects(page)).find(entry => entry.name === name);
  if (!project) throw new Error(`Missing fixture project: ${name}`);
  await page.getByRole('button', { name: `Open project: ${name}`, exact: true }).click();
  await expect(page).toHaveURL(new URL(`/projects/${project.id}/`, page.url()).href);
  await expect(page.getByRole('textbox', { name: 'Message Codex' })).toBeEnabled();
  return project;
}

async function newConversation(page: Page) {
  const previous = (await state(page)).activeSessionId;
  await page.getByRole('button', { name: 'New conversation', exact: true }).click();
  await expect.poll(async () => (await state(page)).activeSessionId).not.toBe(previous);
  await expect(page.getByRole('heading', { name: 'What are we working on?' })).toBeVisible();
  return (await state(page)).activeSessionId;
}

async function connect(page: Page) {
  const button = page.getByRole('button', { name: 'Connect Codex', exact: true });
  if (await button.isVisible()) await button.click();
  await expect(page.getByRole('button', { name: 'Codex connected', exact: true })).toBeVisible();
}

async function drawLocalRectangle(page: Page, offsetY: number) {
  const surface = page.locator('.excalidraw canvas.interactive').first();
  await expect(surface).toBeVisible();
  const bounds = await surface.boundingBox();
  if (!bounds) throw new Error('Missing drawing surface.');
  await page.mouse.click(bounds.x + 230, bounds.y + offsetY - 30);
  await page.keyboard.press('r');
  await page.mouse.move(bounds.x + 260, bounds.y + offsetY);
  await page.mouse.down();
  await page.mouse.move(bounds.x + 395, bounds.y + offsetY + 85, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('v');
}

async function drawRectangle(page: Page, offsetY: number) {
  const existingIds = (await state(page)).board.elements.map((element: any) => element.id);
  await drawLocalRectangle(page, offsetY);
  await expect.poll(async () => (await state(page)).board.elements.some((element: any) => !element.isDeleted && element.type === 'rectangle' && !existingIds.includes(element.id))).toBe(true);
  return (await state(page)).board.elements.find((element: any) => !element.isDeleted && element.type === 'rectangle' && !existingIds.includes(element.id)).id;
}

test('projects share a sidebar and retain their own canvas, conversations and unsent drafts', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Open project: browser-workspace', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open project: second-workspace', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add project', exact: true })).toBeVisible();

  const firstSessionId = await newConversation(page);
  const firstRectangleId = await drawRectangle(page, 210);
  await connect(page);
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  const firstTitle = '[chat] First project conversation.';
  await input.fill(firstTitle);
  await input.press('Enter');
  await expect.poll(async () => (await state(page)).sessions.find((session: any) => session.id === firstSessionId).status).toBe('idle');
  await input.fill('Unsent first-project draft');

  await openProject(page, 'second-workspace');
  await expect(input).toHaveValue('');
  expect((await state(page)).board.elements.some((element: any) => element.id === firstRectangleId)).toBe(false);
  const secondSessionId = await newConversation(page);
  const secondRectangleId = await drawRectangle(page, 350);
  await connect(page);
  const secondTitle = '[chat] Second project conversation.';
  await input.fill(secondTitle);
  await input.press('Enter');
  await expect.poll(async () => (await state(page)).sessions.find((session: any) => session.id === secondSessionId).status).toBe('idle');
  await input.fill('Unsent second-project draft');

  await openProject(page, 'browser-workspace');
  await expect(input).toHaveValue('Unsent first-project draft');
  await expect(page.locator('.message-user').getByText(firstTitle, { exact: true })).toBeVisible();
  await expect(page.locator('.message-user').getByText(secondTitle, { exact: true })).toHaveCount(0);
  const restored = await state(page);
  expect(restored.activeSessionId).toBe(firstSessionId);
  expect(restored.board.elements.some((element: any) => element.id === firstRectangleId && !element.isDeleted)).toBe(true);
  expect(restored.board.elements.some((element: any) => element.id === secondRectangleId)).toBe(false);
  await page.reload();
  await expect(input).toHaveValue('Unsent first-project draft');

  await openProject(page, 'second-workspace');
  await expect(input).toHaveValue('Unsent second-project draft');
  await expect(page.locator('.message-user').getByText(secondTitle, { exact: true })).toBeVisible();
  expect((await state(page)).activeSessionId).toBe(secondSessionId);
  expect((await state(page)).board.elements.some((element: any) => element.id === secondRectangleId && !element.isDeleted)).toBe(true);
  expect(errors).toEqual([]);
});

test('a background project finishes its running turn while another project works independently', async ({ page }) => {
  await page.goto('/');
  const first = (await projects(page)).find(project => project.name === 'browser-workspace')!;
  const firstSessionId = await newConversation(page);
  await connect(page);
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  const firstTitle = '[chat] [project-background] Finish the first project task.';
  await input.fill(firstTitle);
  await input.press('Enter');
  await expect(page.locator('.message-assistant strong').getByText('streamed', { exact: true })).toBeVisible();
  const originalTurnId = (await state(page)).sessions.find((session: any) => session.id === firstSessionId).turnId;
  await input.fill('An update for the first project');

  await openProject(page, 'second-workspace');
  expect((await state(page, first)).sessions.find((session: any) => session.id === firstSessionId).status).toBe('running');
  const secondSessionId = await newConversation(page);
  await connect(page);
  await input.fill('[chat] Keep working on the second project task.');
  await input.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop agent', exact: true })).toBeVisible();
  await input.fill('Second project is still working');

  await expect.poll(async () => (await state(page, first)).sessions.find((session: any) => session.id === firstSessionId).status).toBe('idle');
  const completed = (await state(page, first)).sessions.find((session: any) => session.id === firstSessionId);
  expect(completed.messages.some((message: any) => message.turnId === originalTurnId && message.text.includes('Background project reply finished.'))).toBe(true);
  expect((await state(page)).sessions.find((session: any) => session.id === secondSessionId).status).toBe('running');
  await expect(input).toHaveValue('Second project is still working');

  await openProject(page, 'browser-workspace');
  await expect(input).toHaveValue('An update for the first project');
  await expect(page.locator('.message-assistant').getByText('Background project reply finished.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop agent', exact: true })).toHaveCount(0);
  await openProject(page, 'second-workspace');
  await expect(input).toHaveValue('Second project is still working');
  await page.getByRole('button', { name: 'Stop agent', exact: true }).click();
  await expect.poll(async () => (await state(page)).sessions.find((session: any) => session.id === secondSessionId).status).toBe('idle');
});

test('adding a project validates its folder and reuses an already registered workspace', async ({ page }) => {
  await page.goto('/');
  const initial = (await projects(page)).find(project => project.name === 'browser-workspace')!;
  const workspace = join(dirname(initial.workspace), 'added-workspace');
  await mkdir(workspace, { recursive: true });
  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const folder = dialog.getByRole('textbox', { name: 'Project folder', exact: true });
  await folder.fill(join(workspace, 'missing-folder'));
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Choose an existing workspace folder.');
  await expect(folder).toBeEnabled();
  await folder.fill(workspace);
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open project: added-workspace', exact: true })).toHaveAttribute('aria-current', 'page');
  const added = (await projects(page)).find(project => project.workspace === workspace)!;
  await expect(page).toHaveURL(new URL(`/projects/${added.id}/`, page.url()).href);
  const count = (await projects(page)).length;

  await page.getByRole('button', { name: 'Add project', exact: true }).click();
  await folder.fill(workspace);
  await dialog.getByRole('button', { name: 'Add project', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect((await projects(page)).filter(project => project.workspace === workspace)).toHaveLength(1);
  expect((await projects(page)).length).toBe(count);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Open project: added-workspace', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('a failed canvas save keeps the current project and its local drawing until retry succeeds', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  const initialUrl = page.url();
  const existingIds = (await state(page)).board.elements.map((element: any) => element.id);
  await page.route('**/api/board/mutate', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Project canvas save unavailable.' }) }));
  await drawLocalRectangle(page, 270);
  await page.getByRole('button', { name: 'Open project: second-workspace', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Resolve the canvas save before changing projects. Your edits are still here.' })).toBeVisible();
  await expect(page).toHaveURL(initialUrl);
  await expect(page.locator('.save-error-banner')).toContainText('Project canvas save unavailable.');
  expect((await state(page)).board.elements.some((element: any) => !existingIds.includes(element.id))).toBe(false);

  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const scene = JSON.parse(await readFile((await (await downloaded).path())!, 'utf8'));
  const localRectangle = scene.elements.find((element: any) => element.type === 'rectangle' && !element.isDeleted && !existingIds.includes(element.id));
  expect(localRectangle).toBeDefined();
  await page.unroute('**/api/board/mutate');
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect.poll(async () => (await state(page)).board.elements.some((element: any) => element.id === localRectangle.id && !element.isDeleted)).toBe(true);
  await expect(page.getByText('All changes saved', { exact: true })).toBeVisible();
  await openProject(page, 'second-workspace');
  await openProject(page, 'browser-workspace');
  expect((await state(page)).board.elements.some((element: any) => element.id === localRectangle.id && !element.isDeleted)).toBe(true);
});

test('a nested conversation in another project opens that exact saved conversation', async ({ page }) => {
  await page.goto('/');
  const first = (await projects(page)).find(project => project.name === 'browser-workspace')!;
  const targetId = await newConversation(page);
  await connect(page);
  const input = page.getByRole('textbox', { name: 'Message Codex' });
  const targetTitle = '[chat] Open this exact nested conversation.';
  await input.fill(targetTitle);
  await input.press('Enter');
  await expect.poll(async () => (await state(page)).sessions.find((session: any) => session.id === targetId).status).toBe('idle');
  const latestId = await newConversation(page);
  await input.fill('[chat] A different latest conversation.');
  await input.press('Enter');
  await expect.poll(async () => (await state(page)).sessions.find((session: any) => session.id === latestId).status).toBe('idle');
  await openProject(page, 'second-workspace');

  await page.getByRole('button', { name: `Open conversation: ${targetTitle}`, exact: true }).click();
  await expect(page.locator('.message-user').getByText(targetTitle, { exact: true })).toBeVisible();
  await expect.poll(async () => (await state(page)).activeSessionId).toBe(targetId);
  await expect(page).toHaveURL(new URL(`/projects/${first.id}/`, page.url()).href);
  await expect(page.locator('.message-user').getByText('[chat] A different latest conversation.', { exact: true })).toHaveCount(0);
});
