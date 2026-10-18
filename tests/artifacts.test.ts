import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ArtifactFiles, MAX_FILE_BYTES } from '../src/server/artifacts.js';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'canvagent-artifacts-'));
  const workspace = join(directory, 'project');
  const storage = join(directory, 'published');
  await mkdir(workspace);
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { workspace, storage, directory, files: new ArtifactFiles(workspace, storage) };
}

test('publication stores original bytes independently of the source and survives reopening', async t => {
  const { workspace, storage, files } = await fixture(t);
  const original = Buffer.from('Generated report\nwith actual bytes.\n');
  await mkdir(join(workspace, 'output'));
  await writeFile(join(workspace, 'output', 'report.md'), original);
  const artifact = await files.publish('output/report.md', 'Project report', 'session-1');
  assert.equal(artifact.fileName, 'report.md');
  assert.equal(artifact.title, 'Project report');
  assert.equal(artifact.mimeType, 'text/markdown');
  assert.equal(artifact.sessionId, 'session-1');
  assert.equal(artifact.size, original.length);
  assert.equal(artifact.sha256, createHash('sha256').update(original).digest('hex'));
  assert.deepEqual(await readFile(files.path(artifact.id)), original);
  await rm(join(workspace, 'output'), { recursive: true });
  assert.deepEqual(await new ArtifactFiles(workspace, storage).bytes(artifact), original);
});

test('publication cannot read parent paths, absolute outside paths, or symlink escapes', async t => {
  const { workspace, directory, files } = await fixture(t);
  const sibling = join(directory, 'project-sibling');
  await mkdir(sibling);
  const secret = join(sibling, 'private.txt');
  await writeFile(secret, 'outside workspace');
  await symlink(secret, join(workspace, 'linked-file.txt'));
  await symlink(sibling, join(workspace, 'linked-directory'));
  for (const source of ['../project-sibling/private.txt', secret, 'linked-file.txt', 'linked-directory/private.txt']) {
    await assert.rejects(files.publish(source, 'Must reject'), /inside the project workspace/);
  }
});

test('publication permits an internal symlink and records the resolved file bytes', async t => {
  const { workspace, files } = await fixture(t);
  const bytes = Buffer.from([0, 1, 2, 255]);
  await writeFile(join(workspace, 'actual.bin'), bytes);
  await symlink('actual.bin', join(workspace, 'alias.bin'));
  const artifact = await files.publish('alias.bin', 'Binary output');
  assert.equal(artifact.mimeType, 'application/octet-stream');
  assert.deepEqual(await files.bytes(artifact), bytes);
});

test('publication rejects directories and oversized files before retaining bytes', async t => {
  const { workspace, files } = await fixture(t);
  await assert.rejects(files.publish('.', 'Directory'), /regular file/);
  const large = join(workspace, 'large.bin');
  await writeFile(large, '');
  await truncate(large, MAX_FILE_BYTES + 1);
  await assert.rejects(files.publish('large.bin', 'Large output'), /20 MB/);
});

test('published content corruption is detected rather than served under the original hash', async t => {
  const { workspace, files } = await fixture(t);
  await writeFile(join(workspace, 'report.txt'), 'original');
  const artifact = await files.publish('report.txt', 'Report');
  await writeFile(files.path(artifact.id), 'tampered');
  await assert.rejects(files.bytes(artifact), /unavailable or corrupt/);
  for (const invalidId of ['../private', '/tmp/private', 'a'.repeat(35), 'g'.repeat(36)]) {
    assert.throws(() => files.path(invalidId), /Invalid artifact ID/);
  }
});
