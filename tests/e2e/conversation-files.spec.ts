import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Artifact } from '../../src/shared/types';
import { ArtifactFiles } from '../../src/server/artifacts.ts';
import { Store } from '../../src/server/store.ts';

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

async function conversationFiles(page: Page) {
  const registry = await (await page.request.get('/api/projects')).json();
  const workspace = join(dirname(registry.projects[0].workspace), `conversation-files-${randomUUID()}`);
  await mkdir(workspace);
  const added = await page.request.post('/api/projects', { data: { workspace } });
  expect(added.ok()).toBe(true);
  const path = (await added.json()).path as string;
  const snapshot = await (await page.request.get(`${path}api/state`)).json();
  const firstSession = snapshot.activeSessionId as string;
  const secondSession = randomUUID();
  snapshot.sessions.push({ ...structuredClone(snapshot.sessions[0]), id: secondSession, title: 'Other fixture conversation' });
  snapshot.runtime = { ...snapshot.runtime, connected: true, authenticated: true };
  const artifact = (sessionId: string, index: number): Artifact => ({
    id: `${sessionId}-file ${index}%`, sessionId,
    title: `Fixture document ${index}`, fileName: `fixture-document-${index}.txt`,
    mimeType: 'text/plain', size: 28, sha256: 'fixture-only', createdAt: '2026-10-23T12:00:00.000Z',
  });
  const firstFiles = Array.from({ length: 12 }, (_, index) => artifact(firstSession, index + 1));
  const secondFiles = [artifact(secondSession, 101), artifact(secondSession, 102)];
  // Keep downloads on the real HTTP route: Chromium can cancel attachment
  // downloads synthesized by route.fulfill. This is a fresh fixture project.
  const projectId = path.split('/')[2];
  const savedRegistry = JSON.parse(await readFile(join(dirname(workspace), 'data', 'projects.json'), 'utf8'));
  const registered = savedRegistry.projects.find((project: { id: string }) => project.id === projectId);
  expect(registered.workspace).toBe(workspace);
  await writeFile(join(workspace, firstFiles[0].fileName), `Downloaded ${firstFiles[0].fileName}\n`);
  firstFiles[0] = await new ArtifactFiles(workspace, join(registered.dataDir, 'artifacts'))
    .publish(firstFiles[0].fileName, firstFiles[0].title, firstSession);
  const store = new Store(registered.dataDir);
  try { store.set('artifacts', [firstFiles[0]]); }
  finally { store.close(); }
  snapshot.artifacts = [...firstFiles, ...secondFiles];
  let socket: WebSocketRoute | undefined;
  await page.route('**/api/state', route => route.fulfill({ json: snapshot }));
  await page.routeWebSocket('**/api/events', route => {
    socket = route;
    route.send(JSON.stringify({ type: 'state', state: snapshot }));
  });
  await page.goto(path);
  await expect.poll(() => Boolean(socket)).toBe(true);
  const details = page.locator('details.conversation-files');
  await expect(details).toBeVisible();
  return {
    path, snapshot, firstSession, secondSession, firstFiles, secondFiles, artifact, details,
    publishState() { socket!.send(JSON.stringify({ type: 'state', state: snapshot })); },
    publishArtifacts() { socket!.send(JSON.stringify({ type: 'artifacts', artifacts: snapshot.artifacts })); },
  };
}

test('conversation files start collapsed and support mouse, keyboard, bounded scrolling, and downloads', async ({ page }) => {
  const fixture = await conversationFiles(page);
  const { details } = fixture;
  const summary = details.locator('summary');
  const list = details.locator('.conversation-files-list');
  await expect(summary).toHaveAccessibleName('Files from this conversation (12)');
  await expect(details.locator('.conversation-files-count')).toHaveText('12');
  await expect(details).toHaveJSProperty('open', false);
  await expect(list).toBeHidden();
  await expect(summary.getByText('Show files', { exact: true })).toBeVisible();
  await summary.click();
  await expect(details).toHaveJSProperty('open', true);
  await expect(list).toBeVisible();
  await expect(list.locator('a')).toHaveCount(12);
  await expect(summary.getByText('Hide files', { exact: true })).toBeVisible();
  const scrolling = await list.evaluate(element => ({
    height: element.clientHeight, contentHeight: element.scrollHeight,
    maxHeight: getComputedStyle(element).maxHeight, overflow: getComputedStyle(element).overflowY,
  }));
  expect(scrolling.maxHeight).toBe('250px');
  expect(scrolling.height).toBeLessThanOrEqual(250);
  expect(scrolling.contentHeight).toBeGreaterThan(scrolling.height);
  expect(scrolling.overflow).toBe('auto');
  await summary.click();
  await expect(details).toHaveJSProperty('open', false);
  await summary.focus();
  await summary.press('Enter');
  await expect(details).toHaveJSProperty('open', true);
  await summary.press('Space');
  await expect(details).toHaveJSProperty('open', false);
  await summary.press('Space');
  await expect(details).toHaveJSProperty('open', true);
  const file = fixture.firstFiles[0];
  const link = list.locator('a').first();
  await expect(link).toHaveAttribute('href', `${fixture.path}api/artifacts/${encodeURIComponent(file.id)}`);
  await expect(link).toHaveAttribute('download', file.fileName);
  await expect(list.locator('a').nth(1)).toHaveAttribute('href', `${fixture.path}api/artifacts/${encodeURIComponent(fixture.firstFiles[1].id)}`);
  const downloading = page.waitForEvent('download');
  await link.click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe(file.fileName);
  const downloadedPath = await download.path();
  expect(downloadedPath).not.toBeNull();
  expect(await readFile(downloadedPath!, 'utf8')).toBe(`Downloaded ${file.fileName}\n`);
});

test('artifact updates preserve the expanded section while changing conversations resets it', async ({ page }) => {
  const fixture = await conversationFiles(page);
  const { details } = fixture;
  await details.locator('summary').click();
  await expect(details).toHaveJSProperty('open', true);
  fixture.snapshot.artifacts.push(fixture.artifact(fixture.firstSession, 13));
  fixture.publishArtifacts();
  await expect(details.locator('summary')).toHaveAccessibleName('Files from this conversation (13)');
  await expect(details.locator('a')).toHaveCount(13);
  await expect(details).toHaveJSProperty('open', true);
  fixture.snapshot.activeSessionId = fixture.secondSession;
  fixture.publishState();
  await expect(details.locator('summary')).toHaveAccessibleName('Files from this conversation (2)');
  await expect(details).toHaveJSProperty('open', false);
  await details.locator('summary').click();
  await expect(details.locator('a')).toHaveCount(2);
  await expect(details.locator('a').first()).toContainText('Fixture document 101');
  fixture.publishState();
  await expect(details).toHaveJSProperty('open', true);
  fixture.snapshot.activeSessionId = fixture.firstSession;
  fixture.publishState();
  await expect(details.locator('summary')).toHaveAccessibleName('Files from this conversation (13)');
  await expect(details).toHaveJSProperty('open', false);
  fixture.snapshot.artifacts = [];
  fixture.publishArtifacts();
  await expect(details).toHaveCount(0);
});
