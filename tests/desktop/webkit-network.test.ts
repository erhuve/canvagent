import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);

test('windowless macOS WebKit loads local previews, draws annotations, and reports network failures', {
  skip: process.platform !== 'darwin', timeout: 135_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'canvagent-webkit-test-'));
  const executable = join(directory, 'webkit-network-probe');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<!doctype html><title>Local fixture</title><p>WebKit network fixture</p>');
  });
  try {
    const { stdout: developer } = await execute('xcode-select', ['-p']);
    // Avoid newer beta SDKs that the installed Swift compiler cannot consume.
    const sdk = await realpath(join(developer.trim(), 'SDKs/MacOSX.sdk'));
    await execute('swiftc', [
      resolve('tests/desktop/webkit-smoke.swift'), '-sdk', sdk,
      '-module-cache-path', join(directory, 'modules'), '-o', executable,
      '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist',
      '-Xlinker', resolve('src-tauri/Info.plist'),
    ], { timeout: 90_000 });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://localhost:${address.port}/`;
    const loaded = await execute(executable, [url], { timeout: 15_000 });
    assert.deepEqual(JSON.parse(loaded.stdout), { status: 'loaded' });
    const annotated = await execute(executable, [url, resolve('src/shared/browser-annotations.js')], { timeout: 15_000 });
    assert.deepEqual(JSON.parse(annotated.stdout), {
      status: 'annotated', visibleWindowCount: 0, keyWindowCount: 0, mainWindowCount: 0, activationProhibited: true,
      checks: {
        bridgeAbsent: true, factoryOnly: true, penDraws: true, highlightDraws: true,
        rectangleDraws: true, undoWorks: true, stopWorks: true, clearWorks: true,
        navigationClears: true, disposeWorks: true,
      },
    });
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    const failed = await execute(executable, [url], { timeout: 15_000 });
    assert.deepEqual(JSON.parse(failed.stdout), { status: 'failed', domain: 'NSURLErrorDomain', code: -1004 });
  } finally {
    server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
