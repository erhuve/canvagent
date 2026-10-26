import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

async function fixture(page: Page) {
  const registry = await (await page.request.get('/api/projects')).json();
  const workspace = join(dirname(registry.projects[0].workspace), `review-${randomUUID()}`);
  await mkdir(workspace);
  await writeFile(join(workspace, 'result.txt'), 'before this turn\n');
  const added = await page.request.post('/api/projects', { data: { workspace } });
  expect(added.ok()).toBe(true);
  const project = await added.json();
  await page.goto(project.path);
  await expect(page.getByRole('status', { name: 'Codex connected', exact: true })).toBeVisible();
  return { workspace, path: project.path as string };
}

async function startTurn(page: Page) {
  await page.getByRole('textbox', { name: 'Message Codex', exact: true }).fill('[chat] Keep working while I edit the project.');
  await page.getByRole('button', { name: 'Send message to Codex', exact: true }).click();
  await expect(page.locator('.message-assistant strong').getByText('streamed', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Tracking changes…' })).toBeVisible();
}

async function finishChangedTurn(page: Page, workspace: string) {
  await startTurn(page);
  await writeFile(join(workspace, 'result.txt'), 'after this turn\n');
  await page.getByRole('button', { name: 'Stop agent', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Review changes', exact: true })).toBeVisible();
  // Finishing the review also releases the server's restoration guard.
  await expect(page.getByRole('status').filter({ hasText: 'Tracking changes…' })).toHaveCount(0);
}

test('conversation review shows saved changes and restores only after a concrete confirmation', async ({ page }) => {
  const f = await fixture(page);
  await finishChangedTurn(page, f.workspace);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review changes', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Changes observed during this turn. Other editors or agents may also have contributed.');
  // A focusable pre is exposed as a generic element, so select its accessible label directly.
  const savedDiff = dialog.locator('[aria-label="Saved diff for result.txt"]');
  await expect(savedDiff).toContainText('-before this turn');
  await expect(savedDiff).toContainText('+after this turn');
  await expect(savedDiff).not.toContainText(f.workspace);
  if (process.env.CANVAGENT_REVIEW_SCREENSHOT) await page.screenshot({ path: '/tmp/canvagent-turn-review.png' });
  await dialog.getByRole('button', { name: 'Restore file before this turn', exact: true }).click();
  await expect(dialog).toContainText('Replace result.txt with its contents before this turn?');
  expect(await readFile(join(f.workspace, 'result.txt'), 'utf8')).toBe('after this turn\n');
  await dialog.getByRole('button', { name: 'Cancel restore', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Confirm restore', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Restore file before this turn', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm restore', exact: true }).click();
  await expect.poll(() => readFile(join(f.workspace, 'result.txt'), 'utf8')).toBe('before this turn\n');
  await expect(dialog.getByText('This file has been restored.', { exact: true })).toBeVisible();
  // The comparison remains a frozen observation after restoring and later edits.
  await writeFile(join(f.workspace, 'result.txt'), 'a later human edit\n');
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  await expect(savedDiff).toContainText('+after this turn');
  await expect(savedDiff).not.toContainText('a later human edit');
  await expect(dialog.getByRole('button', { name: 'Restore file before this turn', exact: true })).toHaveCount(0);
});

test('restoring an older turn preserves newer edits and still displays the immutable diff', async ({ page }) => {
  const f = await fixture(page);
  await finishChangedTurn(page, f.workspace);
  await writeFile(join(f.workspace, 'result.txt'), 'newer human content\n');
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review changes', exact: true });
  const savedDiff = dialog.locator('[aria-label="Saved diff for result.txt"]');
  await expect(savedDiff).toContainText('+after this turn');
  await dialog.getByRole('button', { name: 'Restore file before this turn', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm restore', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Later edits are preserved.');
  expect(await readFile(join(f.workspace, 'result.txt'), 'utf8')).toBe('newer human content\n');
  await expect(savedDiff).toContainText('-before this turn');
  await expect(savedDiff).not.toContainText('newer human content');
});

test('file restoration waits for active agent work to finish', async ({ page }) => {
  const f = await fixture(page);
  await finishChangedTurn(page, f.workspace);
  await startTurn(page);
  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Review changes', exact: true });
  await dialog.getByRole('button', { name: 'Restore file before this turn', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm restore', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Wait for active agent work');
  expect(await readFile(join(f.workspace, 'result.txt'), 'utf8')).toBe('after this turn\n');
  await dialog.getByRole('button', { name: 'Close change review', exact: true }).click();
  await page.getByRole('button', { name: 'Stop agent', exact: true }).click();
});
