import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';

test.use({ screenshot: 'off', trace: 'off', video: 'off' });

type Project = { id: string; name: string; workspace: string };
type Session = { id: string; title: string; cols: number; rows: number; exited: boolean; exitCode?: number };

async function sessions(page: Page, project?: Project): Promise<Session[]> {
  const url = project ? new URL(`/projects/${project.id}/api/terminals`, page.url()).href : new URL('api/terminals', page.url()).href;
  return (await (await page.request.get(url)).json()).terminals;
}

async function catalog(page: Page): Promise<Project[]> {
  return (await (await page.request.get('/api/projects')).json()).projects;
}

async function showTerminal(page: Page) {
  const panel = page.getByRole('region', { name: 'Project terminal', exact: true, includeHidden: true });
  const toggle = page.getByRole('button', { name: 'Toggle terminal', exact: true });
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-pressed') !== 'true') await toggle.click();
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Terminal input', exact: true });
  await expect(input).toBeFocused();
  return { panel, input };
}

async function command(page: Page, text: string) {
  const input = page.getByRole('textbox', { name: 'Terminal input', exact: true });
  await input.focus();
  await page.keyboard.type(text);
  await input.press('Enter');
}

test.afterEach(async ({ page }) => {
  for (const project of await catalog(page)) {
    await page.request.get(new URL(`/projects/${project.id}/api/state`, page.url()).href);
    for (const session of await sessions(page, project)) await page.request.post(new URL(`/projects/${project.id}/api/terminals/${session.id}/close`, page.url()).href, { data: {} });
  }
});

test('project terminal runs in the workspace, resizes and preserves its shell through hide and navigation', async ({ page }) => {
  let output = '';
  page.on('websocket', socket => {
    if (!socket.url().includes('/api/terminals/')) return;
    socket.on('framereceived', frame => {
      const message = JSON.parse(String(frame.payload));
      if (message.type === 'data') output += message.data;
      if (message.type === 'ready') output += message.output;
    });
  });
  await page.goto('/');
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  const known = await catalog(page);
  const first = known.find(project => project.name === 'browser-workspace')!;
  const second = known.find(project => project.name === 'second-workspace')!;
  expect(await sessions(page)).toEqual([]);
  const { panel } = await showTerminal(page);
  await expect.poll(async () => (await sessions(page)).length).toBe(1);
  const firstSession = (await sessions(page))[0];
  await command(page, "printf '__TERM_%s__\\n' READY; pwd");
  await expect.poll(() => output).toContain('__TERM_READY__');
  await expect.poll(() => output).toContain(first.workspace);
  await expect(panel.locator('.terminal-session:not([hidden]) .xterm-accessibility-tree')).toContainText('__TERM_READY__');

  const rows = (await sessions(page))[0].rows;
  await panel.getByRole('separator', { name: 'Resize terminal', exact: true }).press('ArrowUp');
  await expect.poll(async () => (await sessions(page))[0].rows).toBeGreaterThan(rows);
  await command(page, "sleep 1; printf '__TERM_%s__\\n' BACKGROUND");
  await page.keyboard.press('Control+Backquote');
  await expect(panel).toBeHidden();
  await expect.poll(() => output).toContain('__TERM_BACKGROUND__');
  await page.keyboard.press('Control+Backquote');
  await expect(page.getByRole('button', { name: 'Toggle terminal', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await showTerminal(page);
  expect((await sessions(page)).map(session => session.id)).toEqual([firstSession.id]);
  await expect(panel.locator('.terminal-session:not([hidden]) .xterm-accessibility-tree')).toContainText('__TERM_BACKGROUND__');

  await page.reload();
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  await showTerminal(page);
  expect((await sessions(page)).map(session => session.id)).toEqual([firstSession.id]);
  await page.getByRole('button', { name: 'Open project: second-workspace', exact: true }).click();
  await expect(page).toHaveURL(new URL(`/projects/${second.id}/`, page.url()).href);
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  await showTerminal(page);
  expect((await sessions(page))[0].id).not.toBe(firstSession.id);
  output = '';
  await command(page, "printf '__TERM_%s__\\n' SECOND; pwd");
  await expect.poll(() => output).toContain('__TERM_SECOND__');
  await expect.poll(() => output).toContain(second.workspace);
  await page.getByRole('button', { name: 'Open project: browser-workspace', exact: true }).click();
  await expect(page).toHaveURL(new URL(`/projects/${first.id}/`, page.url()).href);
  await showTerminal(page);
  expect((await sessions(page)).map(session => session.id)).toEqual([firstSession.id]);
  await expect(panel.locator('.terminal-session:not([hidden]) .xterm-accessibility-tree')).toContainText('__TERM_BACKGROUND__');
});

test('terminal tabs run independently and expose exit status before closing a session', async ({ page }, testInfo) => {
  const traffic = new Map<string, { sent: string[]; received: string[]; input: string; outputTail: string; commandDelivered: boolean; markerReceived: boolean; dataEvents: number; outputCharacters: number; connections: number }>();
  const focus: Array<{ point: string; tagName?: string; role: string | null; label: string | null; session: string | null }> = [];
  const recordFocus = async (point: string) => focus.push({ point, ...await page.evaluate(() => {
    const element = document.activeElement;
    return { tagName: element?.tagName, role: element?.getAttribute('role') ?? null, label: element?.getAttribute('aria-label') ?? null, session: element?.closest('.terminal-session')?.getAttribute('aria-label') ?? null };
  }) });
  const commandText = "printf '__TERM_%s__\\n' SECOND_TAB";
  page.on('websocket', socket => {
    const id = /\/api\/terminals\/([^/]+)\/events$/.exec(socket.url())?.[1];
    if (!id) return;
    const record = traffic.get(id) ?? { sent: [] as string[], received: [] as string[], input: '', outputTail: '', commandDelivered: false, markerReceived: false, dataEvents: 0, outputCharacters: 0, connections: 0 };
    record.connections += 1;
    traffic.set(id, record);
    socket.on('framesent', frame => {
      const message = JSON.parse(String(frame.payload));
      record.sent.push(message.type);
      if (message.type === 'input') {
        record.input += message.data;
        record.commandDelivered ||= record.input.includes(`${commandText}\r`);
      }
    });
    socket.on('framereceived', frame => {
      const message = JSON.parse(String(frame.payload));
      record.received.push(message.type);
      const output = message.type === 'data' ? message.data : message.type === 'ready' ? message.output : '';
      if (message.type === 'data') record.dataEvents += 1;
      record.outputCharacters += output.length;
      record.outputTail = (record.outputTail + output).slice(-256);
      record.markerReceived ||= record.outputTail.includes('__TERM_SECOND_TAB__');
    });
  });
  try {
  await page.goto('/');
  await expect(page.locator('.excalidraw canvas.interactive')).toBeVisible();
  const { panel } = await showTerminal(page);
  const first = (await sessions(page))[0];
  await page.getByRole('button', { name: 'New terminal', exact: true }).click();
  await expect.poll(async () => (await sessions(page)).length).toBe(2);
  const second = (await sessions(page)).find(session => session.id !== first.id)!;
  await expect(panel.getByRole('tab', { name: `Terminal: ${second.title}`, exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(panel.getByRole('status').filter({ hasText: 'Connected' })).toBeVisible();
  const input = page.getByRole('textbox', { name: 'Terminal input', exact: true });
  await input.focus();
  await recordFocus('before command');
  await page.keyboard.type(commandText);
  await recordFocus('after typing');
  await input.press('Enter');
  await recordFocus('after Enter');
  await expect.poll(() => traffic.get(second.id)?.commandDelivered).toBe(true);
  await expect.poll(() => traffic.get(second.id)?.markerReceived).toBe(true);
  await expect(panel.locator('.terminal-session:not([hidden]) .xterm-accessibility-tree')).toContainText('__TERM_SECOND_TAB__');
  await command(page, 'exit 7');
  await expect.poll(async () => (await sessions(page)).find(session => session.id === second.id)?.exitCode).toBe(7);
  await expect(panel.getByRole('status').filter({ hasText: 'Exited (7)' })).toBeVisible();
  expect((await sessions(page)).find(session => session.id === first.id)?.exited).toBe(false);
  await panel.getByRole('button', { name: `Close terminal: ${second.title}`, exact: true }).click();
  await expect.poll(async () => (await sessions(page)).map(session => session.id)).toEqual([first.id]);
  await expect(panel.getByRole('tab', { name: `Terminal: ${first.title}`, exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', { name: 'Terminal input', exact: true })).toBeFocused();
  } finally {
    const counts = (types: string[]) => types.reduce<Record<string, number>>((result, type) => { result[type] = (result[type] ?? 0) + 1; return result; }, {});
    const path = testInfo.outputPath('terminal-protocol.json');
    await writeFile(path, JSON.stringify({ sessions: [...traffic].map(([id, { input: _input, outputTail: _tail, sent, received, ...record }]) => ({ id, sent: counts(sent), received: counts(received), ...record })), focus }, null, 2));
    await testInfo.attach('terminal-protocol.json', { contentType: 'application/json', path });
  }
});
