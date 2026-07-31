import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dispatch, npxCliJsCandidates } from '../lib/dispatch.mjs';
import { getTool, isTool } from '../lib/registry.mjs';
import { renderHelp } from '../lib/help.mjs';

// Issue #65: packages/prosecute is a P5 evidence recorder, not the model reviewer.
// The actual adversarial engine lives in the separate `adversarial-review` CLI
// (`npx adversarial-review`), which was previously unreachable from the `adlc`
// dispatcher. These tests confirm `adlc review` routes to it via npx passthrough,
// without ever spawning a real child process (the spawn call is injected/mocked).

test('registry registers "review" as an external npx-routed verb, not a workspace package', () => {
  assert.equal(isTool('review'), true);
  const tool = getTool('review');
  assert.ok(tool);
  assert.equal(tool.external, true);
  assert.equal(tool.packageName, 'adversarial-review');
  assert.equal(tool.name, 'review');
});

test('help output lists the review verb', () => {
  const output = renderHelp('1.0.0');
  assert.match(output, /\breview\b/);
  assert.match(output, /adversarial-review/);
});

test('npx-cli candidates cover fnm (beside binary) and hostedtoolcache (lib/) layouts', () => {
  const norm = (p) => p.replaceAll('\\', '/');
  const gha = npxCliJsCandidates('/opt/hostedtoolcache/node/20.20.2/x64/bin/node').map(norm);
  assert.ok(gha.some((p) => p.endsWith('/bin/node_modules/npm/bin/npx-cli.js')));
  assert.ok(gha.some((p) => p.endsWith('/lib/node_modules/npm/bin/npx-cli.js')),
    'GitHub Actions Node puts npm under lib/, not beside bin/node');
});

function recordingSpawn(result = { status: 0, error: null, signal: null }) {
  const calls = [];
  const spawnFn = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return result;
  };
  return { calls, spawnFn };
}

// process.platform is a configurable property, so the win32-only branches of the
// `npx` fallback can be exercised in-process on a POSIX runner. SYNCHRONOUS
// callbacks only — the override is process-global.
function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

// TWO spawn shapes are legitimate, and which one production takes is a property of
// the runner's Node install, not of dispatch: `node <npx-cli.js>` when npm's JS entry
// is found (resolveNpxCliJs), and plain `npx` when it is not (a Node built without a
// bundled npm — a supported, deliberate fallback). Asserting one of them
// unconditionally made this test pass or fail on the machine rather than on the
// behavior. So the un-injected test asserts what must hold of BOTH shapes, and each
// branch is then pinned exactly by injecting the resolver.
function assertSupportedNpxSpawn(call, passthrough) {
  const expected = ['adversarial-review', ...passthrough];
  assert.equal(call.options.stdio, 'inherit');
  if (call.cmd === process.execPath) {
    assert.match(call.args[0].replaceAll('\\', '/'), /npm\/bin\/npx-cli\.js$/,
      'the `node ...` form may only run npm\'s npx JS entry');
    assert.deepEqual(call.args.slice(1), expected);
    assert.equal(call.options.shell, undefined, 'the JS entry must never cross a shell');
  } else {
    assert.equal(call.cmd, process.platform === 'win32' ? 'npx.cmd' : 'npx',
      'the only alternative to `node <npx-cli.js>` is the documented plain-npx fallback');
    assert.deepEqual(call.args, expected);
    assert.equal(call.options.shell, process.platform === 'win32' ? true : undefined);
  }
}

test('dispatching "review" reaches adversarial-review with full argument passthrough, whichever npx form this Node supports', () => {
  const { calls, spawnFn } = recordingSpawn();
  const passthrough = ['--scope', 'working-tree', '--include-files'];

  const { code, error } = dispatch('review', passthrough, { spawnFn });

  assert.equal(error, undefined);
  assert.equal(code, 0);
  assert.equal(calls.length, 1, 'expected exactly one spawn call (no network access)');
  assertSupportedNpxSpawn(calls[0], passthrough);
});

test('with npm\'s JS entry present, "review" spawns `node <npx-cli.js>` and never a shell', () => {
  const { calls, spawnFn } = recordingSpawn();
  const npxCli = '/opt/node/lib/node_modules/npm/bin/npx-cli.js';

  const { code, error } = dispatch('review', ['--scope', 'working-tree'], {
    spawnFn,
    resolveNpxCliJs: () => npxCli,
  });

  assert.equal(error, undefined);
  assert.equal(code, 0);
  // Exact shape: extra/dropped args, a renamed package, or a stray `shell: true`
  // all fail here.
  assert.deepEqual(calls, [{
    cmd: process.execPath,
    args: [npxCli, 'adversarial-review', '--scope', 'working-tree'],
    options: { stdio: 'inherit' },
  }]);
});

test('with npm\'s JS entry missing, "review" falls back to plain `npx` with the SAME passthrough', () => {
  const { calls, spawnFn } = recordingSpawn();

  const { code, error } = withPlatform('linux', () =>
    dispatch('review', ['--scope', 'working-tree'], { spawnFn, resolveNpxCliJs: () => null }));

  assert.equal(error, undefined);
  assert.equal(code, 0);
  // The command must be an ABSOLUTE resolved npx, never the bare name.
  assert.equal(calls.length, 1);
  assert.ok(calls[0].cmd.startsWith('/'), `expected absolute npx, got ${calls[0].cmd}`);
  assert.deepEqual(calls[0].args, ['adversarial-review', '--scope', 'working-tree'], 'full passthrough');
  assert.equal(calls[0].options.shell, undefined, 'POSIX needs no shell even in the fallback');
});

// THIS TEST PREVIOUSLY PINNED THE UNSAFE FORM. It asserted `cmd: 'npx.cmd'`
// with `shell: true` — a bare name resolved by cmd.exe against the cwd, which
// for `adlc review` is the repository under review. Asserting that shape as
// correct is what let the hole survive its own regression guard.
test('the win32 `npx` fallback resolves absolutely and never passes a bare name', () => {
  const { calls, spawnFn } = recordingSpawn();

  const { code } = withPlatform('win32', () =>
    dispatch('review', ['--scope', 'working-tree'], {
      spawnFn,
      resolveNpxCliJs: () => null,
      resolveNpxBin: () => 'C:\\Program Files\\nodejs\\npx.cmd',
    }));

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.notEqual(calls[0].cmd, 'npx.cmd', 'a bare name must never reach the spawn');
  assert.notEqual(calls[0].cmd, 'npx');
  // Either an absolute npx, or cmd.exe driving an absolute .cmd with quoted argv.
  const drivesCmdExe = /cmd\.exe$/i.test(calls[0].cmd);
  assert.ok(drivesCmdExe || calls[0].cmd.startsWith('/') || /^[A-Za-z]:/.test(calls[0].cmd),
    `expected a resolved command, got ${calls[0].cmd}`);
  assert.ok(JSON.stringify(calls[0].args).includes('adversarial-review'), 'full passthrough preserved');
});

test('the `npx` fallback refuses cmd.exe metacharacters instead of spawning them', () => {
  const { calls, spawnFn } = recordingSpawn();

  const { code, error } = withPlatform('win32', () =>
    dispatch('review', ['--scope', 'a&calc.exe'], { spawnFn, resolveNpxCliJs: () => null }));

  assert.equal(code, 1);
  assert.equal(calls.length, 0, 'nothing may be spawned once the guard trips');
  assert.match(error, /shell metacharacters/);
});

test('the metacharacter guard is scoped to the shell fallback — the JS entry passes such args verbatim', () => {
  const { calls, spawnFn } = recordingSpawn();
  const npxCli = '/opt/node/lib/node_modules/npm/bin/npx-cli.js';

  const { code, error } = withPlatform('win32', () =>
    dispatch('review', ['--scope', 'a&calc.exe'], { spawnFn, resolveNpxCliJs: () => npxCli }));

  assert.equal(error, undefined);
  assert.equal(code, 0);
  assert.deepEqual(calls[0].args, [npxCli, 'adversarial-review', '--scope', 'a&calc.exe'],
    'no shell is involved, so the argument must not be mangled or rejected');
});

test('dispatching "review" propagates the underlying tool\'s exit code', () => {
  const spawnFn = () => ({ status: 2, error: null, signal: null });
  const { code } = dispatch('review', [], { spawnFn });
  assert.equal(code, 2);
});

test('dispatching "review" surfaces a spawn error instead of throwing', () => {
  const spawnFn = () => ({ status: null, error: new Error('npx not found'), signal: null });
  const { code, error } = dispatch('review', [], { spawnFn });
  assert.equal(code, 1);
  assert.match(error, /npx not found/);
});
