import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { AgentWorkspaceTools } from '../src/server/agent-workspace-tools.ts';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'canvagent-api-tools-'));
  mkdirSync(join(directory, 'project')); const workspace = realpathSync(join(directory, 'project'));
  mkdirSync(join(workspace, 'src'));
  writeFileSync(join(workspace, 'src', 'main.ts'), 'export const value = 1;\n');
  writeFileSync(join(directory, 'outside.txt'), 'private');
  symlinkSync(join(directory, 'outside.txt'), join(workspace, 'escape'));
  symlinkSync(directory, join(workspace, 'outside'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const tools = new AgentWorkspaceTools(workspace);
  const call = async (name: string, args: unknown, signal?: AbortSignal) => {
    const result = await tools.call(name, args, signal);
    return { ...result, value: result.success ? JSON.parse(result.contentItems[0].text) : result.contentItems[0].text };
  };
  return { workspace, call };
}

test('API workspace tools read/search/list and edit with disk revision conflicts preserved', async t => {
  const f = fixture(t);
  const files = await f.call('workspace_list', { path: 'src' });
  assert.equal(files.value.entries[0].path, 'src/main.ts');
  const file = await f.call('workspace_read', { path: 'src/main.ts' });
  assert.match(file.value.content, /value = 1/);
  const found = await f.call('workspace_search', { query: 'value' });
  assert.equal(found.value.matches[0].path, 'src/main.ts');
  const saved = await f.call('workspace_write', { path: 'src/main.ts', revision: file.value.revision, content: 'export const value = 2;\n' });
  assert.equal(saved.success, true);
  const conflict = await f.call('workspace_write', { path: 'src/main.ts', revision: file.value.revision, content: 'overwrite' });
  assert.equal(conflict.success, false); assert.match(conflict.value, /changed on disk/);
  assert.match(readFileSync(join(f.workspace, 'src/main.ts'), 'utf8'), /value = 2/);
});

test('new files are exclusive, project confined, and cancellation prevents new work', async t => {
  const f = fixture(t);
  assert.equal((await f.call('workspace_create', { path: 'src/new.ts', content: 'new' })).success, true);
  assert.equal((await f.call('workspace_create', { path: 'src/new.ts', content: 'replacement' })).success, false);
  for (const path of ['../outside.txt', '.git/config', 'outside/created.txt', '/tmp/created.txt', 'escape'])
    assert.equal((await f.call('workspace_create', { path, content: 'overwrite' })).success, false, path);
  assert.equal((await f.call('workspace_read', { path: 'escape' })).success, false);
  assert.equal((await f.call('workspace_create', { path: 'cancelled.txt', content: 'no' }, AbortSignal.abort())).success, false);
});

test('commands preserve argument boundaries and project cwd without shell expansion', async t => {
  const f = fixture(t);
  const result = await f.call('workspace_command', { executable: process.execPath, args: ['-e', 'console.log(JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(1) }))', '$(echo unsafe); spaces'] });
  assert.equal(result.value.exitCode, 0);
  assert.deepEqual(JSON.parse(result.value.output), { cwd: f.workspace, args: ['$(echo unsafe); spaces'] });
});

test('interrupting a running API command stops it and returns a cancelled result', async t => {
  const f = fixture(t);
  const controller = new AbortController();
  const running = f.call('workspace_command', { executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, controller.signal);
  setTimeout(() => controller.abort(), 80);
  const result = await running;
  assert.equal(result.value.cancelled, true);
  assert.equal(result.value.timedOut, false);
});
