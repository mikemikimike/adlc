// preflight/lib/checks.mjs — individual check implementations.
// Each check is an isolated async function returning { name, status, detail }.
// status: 'pass' | 'fail' | 'skipped'
// All checks guarantee cleanup in finally blocks.

import { spawn } from 'node:child_process';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { detectProvider, resolveOnPath } from '@adlc/core';
import { git } from '@adlc/core';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a command and return { exitCode, stdout, stderr }.
 * Never throws — failures are captured in the result.
 */
export async function runCmd(cmd, args = [], opts = {}) {
  return new Promise((resolve) => {
    let actualCmd = cmd;
    let actualArgs = args;
    let shell = opts.shell;
    if (process.platform === 'win32') {
      if (cmd === 'echo') {
        shell = true;
      } else if (cmd === 'sh' && args[0] === '-c') {
        shell = true;
        actualCmd = args[1];
        actualArgs = [];
      }
    }
    const proc = spawn(actualCmd, actualArgs, { ...opts, shell, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    proc.stdout.on('data', (d) => stdout.push(d));
    proc.stderr.on('data', (d) => stderr.push(d));
    proc.on('error', (err) => resolve({ exitCode: -1, stdout: '', stderr: err.message }));
    proc.on('close', (code) => resolve({
      exitCode: code ?? -1,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

/** Return last N lines of text (non-empty lines). */
function tailLines(text, n = 10) {
  return text.split('\n').filter((l) => l.trim()).slice(-n).join('\n');
}

// ── required checks ──────────────────────────────────────────────────────────

/**
 * A one-liner only a POSIX shell runs correctly: two variable assignments and a
 * quoted parameter expansion. cmd.exe cannot run it (it fails on `a=preflight`),
 * and a shim that merely echoes its argument back cannot produce the expected
 * output either — the expected string never appears literally in the script.
 * That is the point: `echo` working proves nothing about `sh -c` semantics.
 */
const POSIX_PROBE = 'a=preflight; b=ok; echo "${a}-${b}"';
const POSIX_PROBE_EXPECT = 'preflight-ok';

/**
 * Shells to try, in the order the runtime would prefer them.
 *
 * POSIX hosts lead with the literal `/bin/sh` that fleet's runGateCommand
 * spawns. Windows has no `/bin/sh`, but Git for Windows and WSL both put a real
 * bash on PATH — so Windows is probed, not condemned.
 */
export function posixShellCandidates(platform = process.platform) {
  if (platform === 'win32') return ['bash.exe', 'sh.exe', 'bash', 'sh'];
  return ['/bin/sh', 'sh', 'bash'];
}

/** One-line reason a candidate shell did not satisfy the probe. */
function probeFailure(shell, { exitCode, stdout, stderr }) {
  if (exitCode === -1) return `${shell}: ${(stderr.split('\n')[0] || 'not runnable').trim()}`;
  if (exitCode !== 0) return `${shell}: exited ${exitCode}`;
  return `${shell}: ran but produced ${JSON.stringify(stdout.trim().split('\n')[0] ?? '')}`;
}

/**
 * Find the first candidate that executes POSIX_PROBE with POSIX semantics.
 * Returns { ok, shell, attempts } and never throws. `run` is injectable so the
 * "no usable shell" path is testable without uninstalling the host's shell.
 */
export async function probePosixShell({ candidates, run = runCmd, resolve = resolveOnPath } = {}) {
  const list = candidates ?? posixShellCandidates();
  const attempts = [];
  for (const shell of list) {
    // RESOLVE BEFORE SPAWNING. These candidates are bare interpreter names, and
    // preflight runs with cwd at the repository being checked — on Windows a
    // checkout shipping its own `bash.exe` would be executed here, and an empty
    // PATH component does the same on POSIX. An absolute candidate (`/bin/sh`)
    // passes through unchanged; anything unresolvable is skipped rather than
    // handed to spawn.
    const resolved = resolve(shell);
    if (!resolved) {
      attempts.push(`${shell}: not found on PATH`);
      continue;
    }
    const result = await run(resolved, ['-c', POSIX_PROBE]);
    if (result.exitCode === 0 && result.stdout.includes(POSIX_PROBE_EXPECT)) {
      return { ok: true, shell: resolved, attempts };
    }
    attempts.push(probeFailure(shell, result));
  }
  return { ok: false, shell: null, attempts };
}

/**
 * REQUIRED: bash — prove a POSIX shell able to run `sh -c <command>` is present.
 *
 * Gate commands are executed as `['/bin/sh', '-c', command]` (fleet's
 * runGateCommand), so a host without a POSIX shell must fail HERE rather than
 * mid-run inside a gate.
 */
export async function checkBash(opts = {}) {
  const name = 'bash';
  try {
    const { ok, shell, attempts } = await probePosixShell(opts);
    if (ok) {
      return { name, status: 'pass', detail: `POSIX shell '${shell}' ran 'sh -c' probe` };
    }
    return {
      name,
      status: 'fail',
      detail:
        "no working POSIX shell — gate commands run as '/bin/sh -c <command>' and will fail. " +
        'On Windows install Git for Windows or WSL and put bash on PATH. ' +
        `Tried: ${attempts.join('; ')}`,
    };
  } catch (err) {
    return { name, status: 'fail', detail: String(err.message ?? err) };
  }
}

/** REQUIRED: git — git status in cwd (must be a git repo). */
export async function checkGit(cwd = process.cwd()) {
  const name = 'git';
  try {
    git(['status'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    return { name, status: 'pass', detail: 'git status succeeded' };
  } catch (err) {
    const msg = String(err.message ?? err);
    if (msg.includes('not a git repository') || msg.includes('fatal:')) {
      return { name, status: 'fail', detail: 'cwd is not a git repository' };
    }
    return { name, status: 'fail', detail: msg.split('\n')[0] };
  }
}

/** REQUIRED: write — write+delete .adlc/tmp/preflight-test in cwd. */
export async function checkWrite(cwd = process.cwd()) {
  const name = 'write';
  const dir = join(cwd, '.adlc', 'tmp');
  const file = join(dir, 'preflight-test');
  let written = false;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(file, 'preflight-write-test');
    written = true;
    return { name, status: 'pass', detail: `.adlc/tmp/preflight-test written and removed` };
  } catch (err) {
    return { name, status: 'fail', detail: String(err.message ?? err) };
  } finally {
    if (written) {
      try {
        await unlink(file);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/** REQUIRED: branch — create and delete a test branch (finally cleanup). */
export async function checkBranch(cwd = process.cwd()) {
  const name = 'branch';
  const branchName = 'preflight-test-branch';
  let created = false;
  try {
    git(['branch', branchName], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    created = true;
    return { name, status: 'pass', detail: `branch '${branchName}' created and removed` };
  } catch (err) {
    const msg = String(err.message ?? err);
    if (msg.includes(`already exists`)) {
      return {
        name,
        status: 'fail',
        detail: `branch '${branchName}' already exists — likely left by a prior crashed run; delete it manually: git branch -D ${branchName}`,
      };
    }
    // Preserve the full fatal message (may span multiple lines) up to 3 lines for readability
    const detail = msg.split('\n').filter((l) => l.trim()).slice(0, 3).join(' | ');
    return { name, status: 'fail', detail };
  } finally {
    if (created) {
      try {
        git(['branch', '-D', branchName], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch {
        // best-effort cleanup
      }
    }
  }
}

// ── optional checks ──────────────────────────────────────────────────────────

/** OPTIONAL (--worktrees): add/remove a detached worktree. */
export async function checkWorktrees(cwd = process.cwd()) {
  const name = 'worktrees';
  const worktreePath = join(cwd, '.worktrees', 'preflight-test');
  let added = false;
  try {
    git(
      ['worktree', 'add', '--detach', worktreePath, 'HEAD'],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    added = true;
    return { name, status: 'pass', detail: 'worktree add/remove succeeded' };
  } catch (err) {
    return { name, status: 'fail', detail: String(err.message ?? err).split('\n')[0] };
  } finally {
    if (added) {
      try {
        git(
          ['worktree', 'remove', '--force', worktreePath],
          { cwd, stdio: ['ignore', 'pipe', 'pipe'] }
        );
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/** OPTIONAL (--test-cmd "..."): run the given command and expect exit 0. */
export async function checkTestCmd(cmd, cwd = process.cwd()) {
  const name = 'test-cmd';
  try {
    // Parse simple shell string into argv (no shell injection — just whitespace split)
    // For commands with shell features, delegate to sh -c
    const { exitCode, stdout, stderr } = await runCmd('sh', ['-c', cmd], { cwd });
    const output = (stdout + stderr).trim();
    const tail = tailLines(output, 10);
    if (exitCode !== 0) {
      return {
        name,
        status: 'fail',
        detail: `exited ${exitCode}${tail ? `\n${tail}` : ''}`,
      };
    }
    return { name, status: 'pass', detail: `exited 0${tail ? `\n${tail}` : ''}` };
  } catch (err) {
    return { name, status: 'fail', detail: String(err.message ?? err) };
  }
}

/** OPTIONAL (--gh): gh auth status exits 0. */
export async function checkGh() {
  const name = 'gh';
  try {
    const { exitCode, stderr } = await runCmd('gh', ['auth', 'status']);
    if (exitCode !== 0) {
      return { name, status: 'fail', detail: `gh auth status exited ${exitCode}: ${stderr.trim()}` };
    }
    return { name, status: 'pass', detail: 'gh auth status OK' };
  } catch (err) {
    return { name, status: 'fail', detail: String(err.message ?? err) };
  }
}

/** OPTIONAL (--llm): detectProvider() is non-null — no API call made. */
export async function checkLlm(env = process.env) {
  const name = 'llm';
  try {
    const provider = detectProvider(env);
    if (!provider) {
      return {
        name,
        status: 'fail',
        detail: 'no LLM provider detected (set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY)',
      };
    }
    return { name, status: 'pass', detail: `provider: ${provider.name}` };
  } catch (err) {
    return { name, status: 'fail', detail: String(err.message ?? err) };
  }
}
