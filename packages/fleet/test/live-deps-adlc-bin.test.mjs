// `config.adlcBin` must reach EVERY adlc invocation, not just the sync ones.
//
// `defaultIo().adlcAsync` used to hardcode the bare name `adlc`, so the
// per-ticket rails-guard — the production rails gate, and the only adlc call on
// the async hot path — ignored the operator's configured binary and ran whatever
// PATH resolved inside the ticket worktree. On Windows an npm-installed
// `adlc.cmd` cannot be spawned shell-free at all, and a configured `adlc.mjs`
// was never routed through node, so the gate failed to spawn instead of gating.
//
// These tests drive the REAL primitive against REAL child processes: a fake that
// records the argv it was handed would have recorded the hardcoded name just as
// happily as the configured one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildLiveDeps, defaultIo } from '../lib/live-deps.mjs';
import { withWin32Platform } from './platform-mock.mjs';

/** A temp dir that reports its REAL path — macOS /var is a symlink to /private/var. */
function tempDir() {
  return realpathSync(mkdtempSync(join(tmpdir(), 'fleet-adlcbin-')));
}

test('defaultIo().adlcAsync runs the bin from opts.bin, not the bare name', async () => {
  // process.execPath is a binary that is provably NOT `adlc`: if the hardcoded
  // name were still used, this spawn would fail with ENOENT (or run some
  // unrelated adlc), and could never print the marker.
  const r = await defaultIo().adlcAsync(['-e', 'process.stdout.write("bin-honored")'], { bin: process.execPath });

  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'bin-honored', 'the configured bin ran with its args intact');
});

test('defaultIo().adlcAsync routes a .mjs bin through node on win32 and returns its real stdout', async () => {
  const dir = tempDir();
  try {
    const bin = join(dir, 'probe-adlc.mjs');
    // Echo back the argv AND the cwd: the argv proves the routing kept the
    // arguments after inserting the script path, the cwd proves the remaining
    // options still reach spawn once `bin` is stripped off them.
    writeFileSync(bin, 'process.stdout.write("probe:" + process.argv.slice(2).join(",") + "|" + process.cwd());\n');

    // withWin32Platform takes a SYNCHRONOUS callback, and spawnAsync makes its
    // routing decision synchronously inside the promise executor — so the
    // platform is restored before the child is even reaped. Awaiting inside
    // would leak win32 into the rest of the event loop.
    const r = await withWin32Platform(() => defaultIo().adlcAsync(['rails-guard', '--base', 'SHA'], { bin, cwd: dir }));

    assert.equal(r.error, undefined, r.error?.message);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      r.stdout,
      `probe:rails-guard,--base,SHA|${dir}`,
      'the .mjs bin executed under node, with its args and cwd intact'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -- call site -------------------------------------------------------------
// Threading `bin` through the primitive is inert unless the gate actually passes
// `config.adlcBin`. This is the defect the reviewer described.

function railsGuardOptsFor(config) {
  const calls = [];
  const git = () => (...args) => {
    const verb = args[0];
    if (verb === 'diff') return 'packages/fleet/lib/x.mjs';
    if (verb === 'show') throw new Error('no such path at rev');
    if (verb === 'rev-parse') return 'SHA';
    return '';
  };
  const io = {
    git,
    adlc: (args, opts) => { calls.push({ kind: 'sync', args, opts }); return { status: 0, stdout: '' }; },
    adlcAsync: async (args, opts) => { calls.push({ kind: 'async', args, opts }); return { status: 0, stdout: '' }; },
    spawnWorker: async () => ({ status: 0, stdout: 'ok', stderr: '' }),
    readFile: () => undefined,
    exists: () => false,
    mkdirp: () => {},
    writeJson: () => {},
    appendLog: () => {},
    ensureGitignore: () => {},
    env: { PATH: '/usr/bin', HOME: '/home/real' },
    hasGh: () => false,
  };
  const deps = buildLiveDeps({
    repo: '/repo',
    config,
    statusDir: undefined,
    sandboxSpec: { mode: 'sandbox', backend: { name: 'bubblewrap' } },
    reviewRunner: () => ({ ok: true, findings: [] }),
    io,
  });
  return { deps, calls };
}

const ticket = { id: 'T1', title: 'T1', scope: ['packages/fleet/**'], body: 'do it', edges: [] };
const gateConfig = { gate: { build: 'npm run build', test: 'npm test' }, timeoutMinutes: 1 };

test('gate passes config.adlcBin to the rails-guard invocation', async () => {
  const { deps, calls } = railsGuardOptsFor({ ...gateConfig, adlcBin: '/opt/adlc/bin/adlc' });

  await deps.gate({ ticket, worktree: '/wt/T1', startSha: 'TIP' });

  const rg = calls.find((c) => c.args[0] === 'rails-guard');
  assert.ok(rg, 'rails-guard was invoked');
  assert.equal(rg.opts?.bin, '/opt/adlc/bin/adlc', 'the operator-configured adlc runs the rails gate');
  assert.equal(rg.opts?.cwd, '/wt/T1', 'and it still runs inside the ticket worktree');
});

test('gate defaults the rails-guard bin to adlc when none is configured', async () => {
  const { deps, calls } = railsGuardOptsFor({ ...gateConfig });

  await deps.gate({ ticket, worktree: '/wt/T1', startSha: 'TIP' });

  const rg = calls.find((c) => c.args[0] === 'rails-guard');
  assert.equal(rg.opts?.bin, 'adlc', 'unconfigured runs stay on the bare PATH name');
});

test('recordGate passes config.adlcBin to the gate-manifest recorder', async () => {
  const { deps, calls } = railsGuardOptsFor({ ...gateConfig, adlcBin: '/opt/adlc/bin/adlc' });

  deps.recordGate({ ticket, phase: 'P5', ok: true });

  const rec = calls.find((c) => c.args[0] === 'gate-manifest');
  assert.ok(rec, 'gate-manifest record was invoked');
  assert.equal(rec.opts?.bin, '/opt/adlc/bin/adlc', 'evidence is recorded by the configured adlc');
});
