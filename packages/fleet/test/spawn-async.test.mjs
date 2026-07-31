import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnAsync, isWinMjsCommand } from '../lib/spawn-async.mjs';
import { withPlatform, withWin32Platform } from './platform-mock.mjs';

test('captures stdout and a zero exit', async () => {
  const r = process.platform === 'win32'
    ? await spawnAsync(process.execPath, ['-e', 'console.log("hello-fleet")'])
    : await spawnAsync('/bin/sh', ['-c', 'echo hello-fleet']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /hello-fleet/);
  assert.equal(r.timedOut, false);
});

test('propagates a non-zero exit status and stderr', async () => {
  const r = process.platform === 'win32'
    ? await spawnAsync(process.execPath, ['-e', 'console.error("oops"); process.exit(3)'])
    : await spawnAsync('/bin/sh', ['-c', 'echo oops 1>&2; exit 3']);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /oops/);
});

test('a missing binary resolves to an error result (not a throw)', async () => {
  const r = await spawnAsync('/definitely/not/a/real/binary-xyz', []);
  assert.ok(r.error, 'spawn error is surfaced as { error }');
  assert.equal(r.status, null);
});

test('a command exceeding the timeout is killed and flagged timedOut', async () => {
  const r = process.platform === 'win32'
    ? await spawnAsync(process.execPath, ['-e', 'setTimeout(()=>{}, 5000)'], { timeout: 50 })
    : await spawnAsync('/bin/sh', ['-c', 'sleep 5'], { timeout: 50 });
  assert.equal(r.timedOut, true, 'the slow command was killed by the timeout');
  assert.notEqual(r.status, 0);
});

test('opts.input is piped to the child stdin (agy-style prompt)', async () => {
  // `cat` echoes stdin to stdout — proves the input actually reached the child.
  const r = process.platform === 'win32'
    ? await spawnAsync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'prompt-on-stdin-123' })
    : await spawnAsync('cat', [], { input: 'prompt-on-stdin-123' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /prompt-on-stdin-123/);
});

test('without opts.input the child gets no stdin (reads EOF immediately)', async () => {
  // `cat` with stdin ignored closes immediately with empty output.
  const r = process.platform === 'win32'
    ? await spawnAsync(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {})
    : await spawnAsync('cat', [], {});
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('does not block the event loop — a timer fires while the child runs', async () => {
  let tickedDuringChild = false;
  const t = setTimeout(() => { tickedDuringChild = true; }, 20);
  if (process.platform === 'win32') {
    await spawnAsync(process.execPath, ['-e', 'setTimeout(()=>{}, 100)']);
  } else {
    await spawnAsync('/bin/sh', ['-c', 'sleep 0.1']);
  }
  clearTimeout(t);
  assert.equal(tickedDuringChild, true, 'the event loop kept running while the child was alive (#164)');
});

test('isWinMjsCommand routes .mjs (any case) through node on win32', () => {
  withWin32Platform(() => {
    assert.equal(isWinMjsCommand('adapter.mjs'), true);
    assert.equal(isWinMjsCommand('adapter.MJS'), true, 'NTFS is case-insensitive — .MJS is the same file');
    assert.equal(isWinMjsCommand('adapter.cmd'), false, 'only .mjs needs the CreateProcess workaround');
    assert.equal(isWinMjsCommand('adapter.mjs.bak'), false);
  });
});

test('isWinMjsCommand rejects a non-string command on win32', () => {
  withWin32Platform(() => {
    assert.equal(isWinMjsCommand(undefined), false);
    assert.equal(isWinMjsCommand(null), false);
    assert.equal(isWinMjsCommand(42), false);
    // A regex-ish object would match /\.mjs$/ if it were coerced instead of
    // type-checked, which is how a non-command reaches spawn as argv[0].
    assert.equal(isWinMjsCommand({ toString: () => 'adapter.mjs' }), false);
  });
});

test('isWinMjsCommand never reroutes off win32 — CreateProcess is the only reason to', () => {
  for (const platform of ['darwin', 'linux']) {
    withPlatform(platform, () => {
      assert.equal(isWinMjsCommand('adapter.mjs'), false, platform);
      assert.equal(isWinMjsCommand('adapter.MJS'), false, platform);
      assert.equal(isWinMjsCommand(undefined), false, platform);
    });
  }
});

test('spawnAsync routes uppercase .MJS through node on win32', {
  skip: process.platform !== 'win32' ? 'Windows .mjs CreateProcess routing' : false,
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-mjs-'));
  try {
    const script = join(dir, 'probe.mjs');
    writeFileSync(script, 'console.log("mjs-ok")\n');
    // Force uppercase extension in the command string (NTFS is case-insensitive).
    const upper = script.replace(/\.mjs$/i, '.MJS');
    const r = await spawnAsync(upper, []);
    assert.equal(r.error, undefined, r.error?.message);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /mjs-ok/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
