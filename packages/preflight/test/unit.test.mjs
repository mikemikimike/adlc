// preflight unit tests — individual check functions and render utilities.
// node:test, offline, no API keys, temp dirs cleaned up.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { computeVerdict, renderTable } from '../lib/render.mjs';
import {
  checkBash, checkGit, checkWrite, checkBranch,
  checkWorktrees, checkTestCmd, checkLlm, runCmd,
  probePosixShell, posixShellCandidates,
} from '../lib/checks.mjs';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'preflight-unit-'));
}

function cleanTmp(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function initRepo(dir) {
  const g = (args) =>
    execFileSync('git', args, {
      cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    });
  g(['init', '-b', 'main']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  g(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(dir, 'README.md'), 'test');
  g(['add', '.']);
  g(['commit', '-m', 'init']);
  return g;
}

// runCmd reads process.platform directly, and so does node's own spawn(): with
// platform forced to 'win32' it resolves `shell: true` to process.env.comspec,
// so comspec must point at a real shell for the win32 branch to execute here.
async function withWin32(fn) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const comspec = process.env.comspec;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  process.env.comspec = '/bin/sh';
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', platform);
    if (comspec === undefined) delete process.env.comspec;
    else process.env.comspec = comspec;
  }
}

// These simulate win32 dispatch through POSIX shell semantics.
const posixHost = { skip: process.platform === 'win32' ? 'requires a POSIX host shell' : false };

// ── runCmd platform dispatch ──────────────────────────────────────────────────

describe('runCmd platform dispatch', () => {
  it('runs echo through the platform shell on win32', posixHost, async () => {
    const result = await withWin32(() => runCmd('echo', ['a', '&&', 'echo', 'b']));
    assert.equal(result.exitCode, 0);
    // '&&' was interpreted, so echo really went through a shell
    assert.equal(result.stdout, 'a\nb\n');
  });

  it('runs the script itself instead of spawning sh -c on win32', posixHost, async () => {
    const plain = await withWin32(() => runCmd('sh', ['-c', 'echo hi']));
    assert.equal(plain.exitCode, 0);
    assert.equal(plain.stdout, 'hi\n');

    // The rewrite runs args[1] as the whole command line, so trailing
    // positional args are not forwarded as $1..$n the way sh -c would.
    const positional = await withWin32(() => runCmd('sh', ['-c', 'echo "[$1]"', 'x', 'ARG']));
    assert.equal(positional.exitCode, 0);
    assert.equal(positional.stdout, '[]\n');
  });

  it('spawns echo without a shell off win32', posixHost, async () => {
    const result = await runCmd('echo', ['a', '&&', 'echo', 'b']);
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, 'a && echo b\n');
  });
});

// ── checkBash ─────────────────────────────────────────────────────────────────

// A stand-in for a non-POSIX shell shim (cmd.exe is the real one): it knows how
// to `echo`, and otherwise hands the command line straight back. The old
// echo-only bash check passed through exactly such a shim.
const FAKE_SHIM = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const cmd = argv[argv.length - 1] ?? '';
const m = /^echo\\s+(.*)$/.exec(cmd);
process.stdout.write((m ? m[1] : cmd) + '\\n');
`;

function writeShim(dir) {
  const p = join(dir, 'fake-shell.mjs');
  writeFileSync(p, FAKE_SHIM, { mode: 0o755 });
  return p;
}

describe('checkBash', () => {
  let dir;

  before(() => { dir = makeTmp(); });
  after(() => cleanTmp(dir));

  it('passes on a host with a real POSIX shell', async () => {
    const result = await checkBash();
    assert.equal(result.name, 'bash');
    assert.equal(result.status, 'pass');
    assert.match(result.detail, /POSIX shell/);
  });

  it('still passes on win32 when a real shell is on PATH', posixHost, async () => {
    // Git for Windows / WSL ship bash — win32 must not be hard-failed.
    //
    // Resolution is injected rather than mocked through: forcing
    // process.platform to win32 also switches resolveOnPath to Windows path
    // semantics (';' PATH delimiter, drive-letter absoluteness) while the host
    // filesystem and PATH are still POSIX, so a real resolve can never succeed
    // here. That mismatch is an artifact of the mock, not the behaviour under
    // test — what this asserts is that the win32 CANDIDATE LIST is probed and
    // can pass, i.e. Windows is not condemned outright.
    const result = await withWin32(() => checkBash({
      resolve: (s) => `C:\\Program Files\\Git\\bin\\${s}`,
      run: async () => ({ exitCode: 0, stdout: 'preflight-ok\n', stderr: '' }),
    }));
    assert.equal(result.status, 'pass');
    assert.match(result.detail, /bash|sh/);
  });

  it('probes Windows for a real shell instead of hard-failing it', () => {
    // The list must actually contain something Git-Bash/WSL provides — a win32
    // list that named only `/bin/sh` would make the required check permanently
    // red on every legitimate Windows setup.
    const list = posixShellCandidates('win32');
    assert.ok(list.length > 0);
    assert.ok(list.some((c) => /^bash(\.exe)?$/.test(c)), `expected a bash candidate, got ${list.join(', ')}`);
  });

  it('fails when no candidate shell can be executed', async () => {
    const result = await checkBash({ candidates: [join(dir, 'no-such-shell')], resolve: (s) => s });
    assert.equal(result.name, 'bash');
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /no working POSIX shell/);
    assert.match(result.detail, /\/bin\/sh -c/);      // names what actually breaks
    assert.match(result.detail, /Git for Windows|WSL/); // actionable
    assert.match(result.detail, /no-such-shell/);      // says what it tried
  });

  it('fails on an echo-capable shim that is not a POSIX shell', posixHost, async () => {
    const shim = writeShim(dir);

    // The shim satisfies the old check's evidence: `echo` produces output.
    const echoed = await runCmd(shim, ['-c', 'echo preflight-ok']);
    assert.equal(echoed.exitCode, 0);
    assert.match(echoed.stdout, /preflight-ok/);

    // It still fails the real check, because it cannot run `sh -c` semantics.
    const result = await checkBash({ candidates: [shim], resolve: (s) => s });
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /no working POSIX shell/);
  });

  it('never throws when the runner itself explodes', async () => {
    const result = await checkBash({
      candidates: ['x'],
      resolve: (s) => s,
      run: async () => { throw new Error('runner exploded'); },
    });
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /runner exploded/);
  });
});

describe('probePosixShell', () => {
  it('returns the first candidate that satisfies the probe', async () => {
    const seen = [];
    const { ok, shell, attempts } = await probePosixShell({
      candidates: ['bogus-a', '/bin/sh'],
      resolve: (s) => s,
      run: async (cmd, args) => {
        seen.push(cmd);
        return runCmd(cmd, args);
      },
    });
    assert.equal(ok, true);
    assert.equal(shell, '/bin/sh');
    assert.deepEqual(seen, ['bogus-a', '/bin/sh']);
    assert.equal(attempts.length, 1);
  });

  it('runs a script that a literal-echo shim cannot fake', async () => {
    // The expected output must not be reproducible by echoing the probe back.
    let probe;
    await probePosixShell({
      candidates: ['x'],
      resolve: (s) => s,
      run: async (_cmd, args) => { probe = args[1]; return { exitCode: 0, stdout: args[1], stderr: '' }; },
    });
    assert.equal(probe.includes('preflight-ok'), false);
  });
});

describe('posixShellCandidates', () => {
  it('leads with /bin/sh off win32 — the path gate commands spawn', () => {
    assert.equal(posixShellCandidates('darwin')[0], '/bin/sh');
  });

  it('probes real shells on win32 instead of assuming none exist', () => {
    const candidates = posixShellCandidates('win32');
    assert.ok(candidates.some((c) => /bash/.test(c)), 'win32 must try bash');
    assert.equal(candidates.includes('/bin/sh'), false, 'win32 has no /bin/sh');
  });
});

// ── checkGit ──────────────────────────────────────────────────────────────────

describe('checkGit', () => {
  let repoDir;
  let nonRepoDir;

  before(() => {
    repoDir = makeTmp();
    initRepo(repoDir);
    nonRepoDir = makeTmp();
  });

  after(() => {
    cleanTmp(repoDir);
    cleanTmp(nonRepoDir);
  });

  it('passes in a git repo', async () => {
    const result = await checkGit(repoDir);
    assert.equal(result.name, 'git');
    assert.equal(result.status, 'pass');
  });

  it('fails in a non-git directory', async () => {
    const result = await checkGit(nonRepoDir);
    assert.equal(result.name, 'git');
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /not a git repo/i);
  });
});

// ── checkWrite ────────────────────────────────────────────────────────────────

describe('checkWrite', () => {
  let dir;

  before(() => { dir = makeTmp(); });
  after(() => cleanTmp(dir));

  it('passes and leaves no residue', async () => {
    const result = await checkWrite(dir);
    assert.equal(result.status, 'pass');
    const tmpFile = join(dir, '.adlc', 'tmp', 'preflight-test');
    assert.equal(existsSync(tmpFile), false, 'preflight-test file should be cleaned up');
  });
});

// ── checkBranch ───────────────────────────────────────────────────────────────

describe('checkBranch', () => {
  let dir;

  before(() => {
    dir = makeTmp();
    initRepo(dir);
  });

  after(() => cleanTmp(dir));

  it('passes and cleans up the branch', async () => {
    const result = await checkBranch(dir);
    assert.equal(result.status, 'pass');
    const branchList = execFileSync('git', ['branch'], {
      cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    assert.equal(
      branchList.includes('preflight-test-branch'),
      false,
      'preflight-test-branch must be absent after check'
    );
  });

  it('fails gracefully in a non-repo dir', async () => {
    const nonRepo = makeTmp();
    try {
      const result = await checkBranch(nonRepo);
      assert.equal(result.status, 'fail');
    } finally {
      cleanTmp(nonRepo);
    }
  });
});

// ── checkWorktrees ────────────────────────────────────────────────────────────

describe('checkWorktrees', () => {
  let dir;

  before(() => {
    dir = makeTmp();
    initRepo(dir);
  });

  after(() => cleanTmp(dir));

  it('passes and leaves no residue', async () => {
    const result = await checkWorktrees(dir);
    assert.equal(result.status, 'pass');
    const worktreePath = join(dir, '.worktrees', 'preflight-test');
    assert.equal(existsSync(worktreePath), false, 'worktree dir must be cleaned up');
  });
});

// ── checkTestCmd ──────────────────────────────────────────────────────────────

describe('checkTestCmd', () => {
  let dir;

  before(() => { dir = makeTmp(); });
  after(() => cleanTmp(dir));

  it('passes when command exits 0', async () => {
    const result = await checkTestCmd('exit 0', dir);
    assert.equal(result.status, 'pass');
  });

  it('fails when command exits non-zero', async () => {
    const result = await checkTestCmd('exit 1', dir);
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /exited 1/);
  });

  it('includes tail of output on failure', async () => {
    const result = await checkTestCmd('echo "error output" && exit 42', dir);
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /error output/);
  });
});

// ── checkLlm ─────────────────────────────────────────────────────────────────

describe('checkLlm', () => {
  it('passes when ANTHROPIC_API_KEY is set', async () => {
    const result = await checkLlm({ ANTHROPIC_API_KEY: 'sk-test-key' });
    assert.equal(result.status, 'pass');
    assert.match(result.detail, /anthropic/);
  });

  it('passes when OPENAI_API_KEY is set', async () => {
    const result = await checkLlm({ OPENAI_API_KEY: 'sk-test-key' });
    assert.equal(result.status, 'pass');
    assert.match(result.detail, /openai/);
  });

  it('fails when no provider key is set', async () => {
    const result = await checkLlm({});
    assert.equal(result.status, 'fail');
    assert.match(result.detail, /no LLM provider/);
  });
});

// ── computeVerdict ────────────────────────────────────────────────────────────

describe('computeVerdict', () => {
  it('pass when all required checks pass', () => {
    const results = [
      { name: 'bash',   status: 'pass', required: true },
      { name: 'git',    status: 'pass', required: true },
      { name: 'write',  status: 'pass', required: true },
      { name: 'branch', status: 'pass', required: true },
    ];
    const { verdict, failedNames } = computeVerdict(results);
    assert.equal(verdict, 'pass');
    assert.deepEqual(failedNames, []);
  });

  it('fail when a required check fails', () => {
    const results = [
      { name: 'bash',   status: 'pass', required: true },
      { name: 'git',    status: 'fail', required: true },
      { name: 'write',  status: 'pass', required: true },
      { name: 'branch', status: 'pass', required: true },
    ];
    const { verdict, failedNames } = computeVerdict(results);
    assert.equal(verdict, 'fail');
    assert.deepEqual(failedNames, ['git']);
  });

  it('pass when all skipped (required: false)', () => {
    const results = [{ name: 'gh', status: 'skipped', required: false }];
    const { verdict } = computeVerdict(results);
    assert.equal(verdict, 'pass');
  });
});

// ── renderTable ───────────────────────────────────────────────────────────────

describe('renderTable', () => {
  it('produces lines containing check names and status labels', () => {
    const results = [
      { name: 'bash', status: 'pass', detail: 'ok' },
      { name: 'git',  status: 'fail', detail: 'not a repo' },
    ];
    const lines = renderTable(results);
    const joined = lines.join('\n');
    assert.match(joined, /bash/);
    assert.match(joined, /git/);
    assert.match(joined, /PASS/);
    assert.match(joined, /FAIL/);
  });
});
