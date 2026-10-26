import { expect, test, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function openProject(page: Page, workspace: string) {
  expect((await page.request.get('/api/projects')).ok()).toBe(true);
  const created = await page.request.post('/api/projects', { data: { workspace } });
  expect(created.ok()).toBe(true);
  const project = await created.json();
  await page.goto(project.path);
  await page.getByRole('tab', { name: 'Changes', exact: true }).click();
}

test('Changes reviews staged, working and untracked files, retains selection between tabs and refreshes', async ({ page }) => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'canvagent-review-ui-')));
  const git = (...args: string[]) => execFileSync('git', ['--literal-pathspecs', ...args], { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    git('init', '-b', 'review-ui');
    writeFileSync(join(workspace, 'both.txt'), 'original body\n');
    git('add', '--', '.');
    git('-c', 'user.name=Canvagent UI test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial files');
    writeFileSync(join(workspace, 'both.txt'), 'staged body\n'); git('add', '--', 'both.txt');
    writeFileSync(join(workspace, 'both.txt'), 'working body\n');
    writeFileSync(join(workspace, 'new note.txt'), 'untracked note\n');
    const indexBefore = readFileSync(join(workspace, '.git', 'index'));
    await openProject(page, workspace);
    await expect(page.locator('.git-branch')).toHaveText('review-ui');
    const working = page.getByRole('region', { name: 'Working tree', exact: true });
    const staged = page.getByRole('region', { name: 'Staged', exact: true });
    await expect(working.getByRole('button').filter({ hasText: 'both.txt' })).toBeVisible();
    await expect(staged.getByRole('button').filter({ hasText: 'both.txt' })).toBeVisible();
    await staged.getByRole('button').filter({ hasText: 'both.txt' }).click();
    await expect(page.locator('.git-diff')).toContainText('-original body');
    await expect(page.locator('.git-diff')).toContainText('+staged body');
    await expect(page.locator('.git-diff')).not.toContainText('working body');
    await page.getByRole('tab', { name: 'Canvas', exact: true }).click();
    await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
    await page.getByRole('tab', { name: 'Changes', exact: true }).click();
    await expect(staged.getByRole('button').filter({ hasText: 'both.txt' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.git-diff')).toContainText('+staged body');
    await working.getByRole('button').filter({ hasText: 'both.txt' }).click();
    await expect(page.locator('.git-diff')).toContainText('-staged body');
    await expect(page.locator('.git-diff')).toContainText('+working body');
    await working.getByRole('button').filter({ hasText: 'new note.txt' }).click();
    await expect(page.locator('.git-diff')).toContainText('+untracked note');
    await working.getByRole('button').filter({ hasText: 'both.txt' }).click();
    writeFileSync(join(workspace, 'both.txt'), 'latest working body\n');
    await page.getByRole('button', { name: 'Refresh changes', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Refresh changes', exact: true })).toBeEnabled();
    await expect(page.locator('.git-diff')).toContainText('+latest working body');
    await expect(page.getByText('Loading diff…', { exact: true })).not.toBeVisible();
    if (process.env.CANVAGENT_CAPTURE_GIT_REVIEW === '1') await page.screenshot({ path: '/tmp/canvagent-changes.png', fullPage: true });
    writeFileSync(join(workspace, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    await page.getByRole('button', { name: 'Refresh changes', exact: true }).click();
    await working.getByRole('button').filter({ hasText: 'binary.bin' }).click();
    await expect(page.getByText('Binary file changed', { exact: true })).toBeVisible();
    expect(readFileSync(join(workspace, '.git', 'index'))).toEqual(indexBefore);
    await expect(page.locator('.git-panel').getByRole('button', { name: /^(Stage|Commit|Discard)/ })).toHaveCount(0);
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test('Changes explains projects without a Git working tree', async ({ page }) => {
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'canvagent-no-git-ui-')));
  try {
    writeFileSync(join(workspace, 'note.txt'), 'ordinary folder\n');
    await openProject(page, workspace);
    await expect(page.getByText('No Git repository', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh changes', exact: true })).toBeEnabled();
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});
