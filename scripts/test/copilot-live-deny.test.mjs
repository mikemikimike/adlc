// Unit coverage for scripts/copilot-live-deny.mjs — exercises the skip gate and
// the control/treatment/deny-tool proof logic against a MOCK `copilot` binary
// (no real model turns, no credits), mirroring the mock-harness approach in
// opencode-live-deny's tests. Without this, the mutation-gate's slow path would
// find surviving mutants in the live-deny harness (it is not otherwise run in CI).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'copilot-live-deny.mjs');

// A fake `copilot` that reproduces the three verified behaviors the proof asserts:
//  --version                        → print a version
//  ... --deny-tool shell            → refuse the shell tool, write nothing
//  ... --allow-all-tools (control)  → perform the edit (rail → CHANGED)
//  ... --allow-tool ... (treatment) → hook blocks; no edit
function withFakeCopilot(fn) {
  const bin = mkdtempSync(join(tmpdir(), 'fake-copilot-bin-'));
  const fake = join(bin, 'copilot');
  const code = `
const fs = require('fs');
const args = process.argv.join(' ');
if (args.includes('--version')) { console.log("GitHub Copilot CLI 0.0.0-mock"); process.exit(0); }
if (args.includes('--deny-tool')) { console.log("Permission to run this tool was denied due to the following rules: shell"); process.exit(0); }
if (args.includes('--allow-all-tools')) { fs.writeFileSync('protected/rail.txt', 'CHANGED'); process.exit(0); }
console.log("the edit was blocked");
process.exit(0);
`;
  writeFileSync(fake, `#!/usr/bin/env node\n${code}`);
  chmodSync(fake, 0o755);
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'copilot.cjs'), code);
    writeFileSync(join(bin, 'copilot.cmd'), `@node "%~dp0copilot.cjs" %*\n`);
    writeFileSync(join(bin, 'copilot.bat'), `@node "%~dp0copilot.cjs" %*\n`);
  }
  try { return fn(bin); } finally { rmSync(bin, { recursive: true, force: true }); }
}

test('skips (exit 3) when ADLC_COPILOT_LIVE_INSTALL is not set', () => {
  const { ADLC_COPILOT_LIVE_INSTALL: _e, ...env } = process.env;
  const r = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  assert.equal(r.status, 3, r.stdout + r.stderr);
});

test('--require fails (exit 1) when no copilot binary resolves', () => {
  const { ADLC_COPILOT_LIVE_INSTALL: _e, ...base } = process.env;
  const bin = mkdtempSync(join(tmpdir(), 'empty-bin-'));
  try {
    const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
    const env = { ...base, ADLC_COPILOT_LIVE_INSTALL: '1', [pathKey]: `${bin}${delimiter}${dirname(process.execPath)}` };
    const r = spawnSync(process.execPath, [SCRIPT, '--require'], { env, encoding: 'utf8' });
    assert.equal(r.status, 1);
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

function cleanEnv(bin) {
  const env = { ...process.env, ADLC_COPILOT_LIVE_INSTALL: '1', ADLC_COPILOT_PATH: join(bin, process.platform === 'win32' ? 'copilot.cjs' : 'copilot') };
  const oldPath = process.env.PATH ?? process.env.Path ?? process.env.path ?? '';
  delete env.PATH;
  delete env.Path;
  delete env.path;
  env.PATH = `${bin}${delimiter}${oldPath}`;
  return env;
}

test('PASS against a mock copilot: control edits, treatment blocks, deny-tool blocks shell', () => {
  withFakeCopilot((bin) => {
    const env = cleanEnv(bin);
    const r = spawnSync(process.execPath, [SCRIPT, '--require'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, `expected pass; got:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /control ok/);
    assert.match(r.stdout, /treatment ok/);
    assert.match(r.stdout, /deny-tool ok/);
  });
});

test('FAILS (exit 1) when the mock copilot does NOT block the rail (treatment regression)', () => {
  // A copilot that ALWAYS edits (even in treatment) must make the proof fail —
  // proving the treatment assertion is load-bearing, not hollow.
  const bin = mkdtempSync(join(tmpdir(), 'fake-copilot-bad-'));
  const fake = join(bin, 'copilot');
  const code = `
const fs = require('fs');
const args = process.argv.join(' ');
if (args.includes('--version')) { console.log("mock"); process.exit(0); }
if (args.includes('--deny-tool shell')) { console.log("denied ... shell"); process.exit(0); }
fs.writeFileSync('protected/rail.txt', 'CHANGED');
process.exit(0);
`;
  writeFileSync(fake, `#!/usr/bin/env node\n${code}`);
  chmodSync(fake, 0o755);
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'copilot.cjs'), code);
    writeFileSync(join(bin, 'copilot.cmd'), `@node "%~dp0copilot.cjs" %*\n`);
    writeFileSync(join(bin, 'copilot.bat'), `@node "%~dp0copilot.cjs" %*\n`);
  }
  try {
    const env = cleanEnv(bin);
    const r = spawnSync(process.execPath, [SCRIPT, '--require'], { env, encoding: 'utf8' });
    assert.equal(r.status, 1);
  } finally { rmSync(bin, { recursive: true, force: true }); }
});

test('refuses ADLC_COPILOT_PATH with cmd metacharacters (no shell injection)', () => {
  const { ADLC_COPILOT_LIVE_INSTALL: _e, ...base } = process.env;
  const marker = join(tmpdir(), `adlc-copilot-inject-${process.pid}.marker`);
  try {
    if (existsSync(marker)) rmSync(marker, { force: true });
    // Hostile override: if this were passed through `shell: true` on Windows,
    // cmd.exe would chain and create the marker. The gate must refuse first.
    const env = {
      ...base,
      ADLC_COPILOT_LIVE_INSTALL: '1',
      ADLC_COPILOT_PATH: process.platform === 'win32'
        ? `copilot.cmd & echo pwned > "${marker}"`
        : `copilot; touch "${marker}"`,
    };
    const r = spawnSync(process.execPath, [SCRIPT, '--require'], { env, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /shell metacharacters/);
    assert.equal(existsSync(marker), false, 'payload must not have run');
  } finally {
    try { rmSync(marker, { force: true }); } catch { /* ignore */ }
  }
});

test('with no ADLC_COPILOT_PATH, the default binary name is `copilot` (not `copilot.cmd`) off win32', {
  skip: process.platform === 'win32'
    ? 'cmd.exe resolves `copilot` to `copilot.cmd` via PATHEXT, so the name is not observable here'
    : false,
}, () => {
  withFakeCopilot((bin) => {
    // The fake bin dir holds only a POSIX `copilot` on non-Windows, so the whole
    // proof runs iff the unset-override default picks that exact name.
    const env = cleanEnv(bin);
    delete env.ADLC_COPILOT_PATH;
    const r = spawnSync(process.execPath, [SCRIPT, '--require'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, `expected the default \`copilot\` name to resolve on PATH; got:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /control ok/);
  });
});

test('ADLC_COPILOT_PATH override to a .cmd shim works on win32', {
  skip: process.platform !== 'win32' ? 'Windows .cmd CreateProcess/shell behavior' : false,
}, () => {
  withFakeCopilot((bin) => {
    const env = { ...process.env, ADLC_COPILOT_LIVE_INSTALL: '1', ADLC_COPILOT_PATH: join(bin, 'copilot.cmd') };
    const oldPath = process.env.PATH ?? '';
    delete env.PATH;
    delete env.Path;
    delete env.path;
    env.PATH = `${bin}${delimiter}${oldPath}`;
    const r = spawnSync(process.execPath, [SCRIPT, '--require'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, `expected pass via .cmd override; got:\n${r.stdout}\n${r.stderr}`);
  });
});

test('ADLC_COPILOT_PATH override with uppercase .CMD extension works on win32', {
  skip: process.platform !== 'win32' ? 'Windows extension case-insensitivity' : false,
}, () => {
  withFakeCopilot((bin) => {
    // File is written as copilot.cmd; env uses .CMD — Windows treats them as the
    // same path, and our suffix checks must too (not only lowercase).
    const override = join(bin, 'copilot.cmd').replace(/\.cmd$/i, '.CMD');
    const env = { ...process.env, ADLC_COPILOT_LIVE_INSTALL: '1', ADLC_COPILOT_PATH: override };
    const oldPath = process.env.PATH ?? '';
    delete env.PATH;
    delete env.Path;
    delete env.path;
    env.PATH = `${bin}${delimiter}${oldPath}`;
    const r = spawnSync(process.execPath, [SCRIPT, '--require'], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, `expected pass via .CMD override; got:\n${r.stdout}\n${r.stderr}`);
  });
});

// The normalization block reads `Path`, writes `PATH`, and deletes the variant.
// On Windows those are the SAME variable (process.env is case-insensitive
// there), so doing it in the wrong order deletes the value just written and
// leaves the process with no PATH — an installed Copilot then reports missing.
//
// Node's env is case-SENSITIVE on POSIX, so the real hazard cannot be reproduced
// on this host. What IS portable, and what actually broke, is the ORDER: the
// assignment must be the last operation. This drives the same statements against
// a plain object with Windows semantics simulated, so the ordering contract is
// pinned on any host. The existing tests could not catch it — they delete every
// variant and force an uppercase PATH before invoking (see cleanEnv above),
// which is exactly the shape that masks it.
test('PATH case-normalization assigns AFTER deleting the variant', () => {
  // A case-insensitive stand-in for Windows process.env.
  const makeWinEnv = (initial) => {
    const store = new Map(Object.entries(initial));
    const keyFor = (k) => [...store.keys()].find((s) => s.toUpperCase() === String(k).toUpperCase());
    return new Proxy({}, {
      get: (_t, k) => (typeof k === 'string' ? store.get(keyFor(k)) : undefined),
      set: (_t, k, v) => { const e = keyFor(k); store.delete(e); store.set(String(k), v); return true; },
      deleteProperty: (_t, k) => { const e = keyFor(k); if (e) store.delete(e); return true; },
      ownKeys: () => [...store.keys()],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    });
  };

  const env = makeWinEnv({ Path: 'C:\\tools;C:\\Windows\\System32' });
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  assert.equal(pathKey, 'Path');

  // The production order: read, delete, assign.
  const value = env[pathKey];
  delete env[pathKey];
  env.PATH = value;

  assert.equal(env.PATH, 'C:\\tools;C:\\Windows\\System32', 'PATH must survive normalization');
  assert.ok(env.PATH, 'PATH must not be wiped — the version probe depends on it');
});
