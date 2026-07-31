/**
 * verify-claims.mjs — verify extracted claims against the actual environment.
 *
 * Claim status:
 *  - ok          — claim is verifiable and passes
 *  - stale       — claim is verifiable but fails
 *  - unverifiable — cannot determine truth (e.g. URL, ambiguous token)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { winSystemExe } from '@adlc/core';

/**
 * Verify a single claim.
 * @param {{ type: 'command'|'path'|'script', value: string, raw: string }} claim
 * @param {{ repoRoot: string, skillDir: string }} ctx
 * @returns {{ status: 'ok'|'stale'|'unverifiable', reason?: string }}
 */
export function verifyClaim(claim, ctx) {
  switch (claim.type) {
    case 'command':
      return verifyCommand(claim.value, ctx.repoRoot);
    case 'path':
      return verifyPath(claim.value, ctx.repoRoot, ctx.skillDir);
    case 'script':
      return verifyScript(claim.value, ctx.repoRoot);
    default:
      return { status: 'unverifiable', reason: 'unknown claim type' };
  }
}

// INTERNAL cmd.exe commands only — this set is consulted on win32 alone, and a
// name in it is certified WITHOUT consulting `where.exe`, so anything that is
// not genuinely built into cmd.exe would be falsely reported present.
//
// The POSIX names that used to live here (`ls`, `cat`, `rm`, `cp`, `mv`, `pwd`,
// `clear`, `touch`, `which`, `export`) are NOT cmd.exe builtins. On a stock
// Windows box `touch` does not exist, yet skill-rot answered `ok` for it —
// certifying a command that cannot run and weakening the verification this
// module exists to perform. They are removed so they fall through to the real
// `where.exe` lookup, which correctly finds them when Git-Bash/WSL supplies
// them and correctly fails when nothing does.
const COMMON_BUILTINS = new Set([
  'cd', 'dir', 'echo', 'set', 'type', 'copy', 'move', 'del', 'mkdir', 'rmdir', 'cls', 'path', 'exit',
]);

// POSIX SHELL BUILTINS — no executable file exists for these ANYWHERE, so
// `where.exe` cannot find them even on a box with Git Bash or WSL installed.
// Removing them from COMMON_BUILTINS (correct: they are not cmd.exe builtins and
// must not be certified `ok` unconditionally) sent them to where.exe instead,
// which marks a perfectly valid Bash-oriented skill STALE and exits 2 —
// `export ADLC_TICKET=T1` in a skill is extracted as the command `export`.
//
// The honest verdict for these on Windows is UNVERIFIABLE, not stale: whether
// the claim holds depends on a shell we cannot interrogate with where.exe. The
// POSIX branch below still resolves them properly via `command -v`.
const POSIX_SHELL_BUILTINS = new Set([
  'export', 'source', 'alias', 'unalias', 'eval', 'exec', 'shift', 'trap',
  'umask', 'ulimit', 'wait', 'read', 'readonly', 'unset', 'local', 'declare',
  'command', 'builtin', 'let', 'test',
]);

/**
 * Verify a command exists via `command -v <tok>` or in ./node_modules/.bin.
 */
function verifyCommand(cmd, repoRoot) {
  // Skip obvious placeholders
  if (isPlaceholder(cmd)) {
    return { status: 'unverifiable', reason: 'placeholder token' };
  }

  // Check ./node_modules/.bin first
  const nmBin = join(repoRoot, 'node_modules', '.bin', cmd);
  if (
    existsSync(nmBin) ||
    (process.platform === 'win32' && (existsSync(`${nmBin}.cmd`) || existsSync(`${nmBin}.exe`)))
  ) {
    return { status: 'ok' };
  }

  if (process.platform === 'win32') {
    if (COMMON_BUILTINS.has(cmd.toLowerCase())) {
      return { status: 'ok' };
    }
    if (POSIX_SHELL_BUILTINS.has(cmd.toLowerCase())) {
      return { status: 'unverifiable', reason: `POSIX shell builtin — no executable for where.exe to find: ${cmd}` };
    }
    try {
      // ABSOLUTE `where.exe`. skill-rot runs with cwd at the repository root,
      // and Windows resolves a bare executable name against the current
      // directory before the system directories — so a checkout shipping its
      // own `where.exe` would run on every non-builtin claim verified.
      execFileSync(winSystemExe('where.exe'), [cmd], { stdio: 'pipe', timeout: 5000 });
      return { status: 'ok' };
    } catch {
      return { status: 'stale', reason: `command not found: ${cmd}` };
    }
  }

  // Use `command -v` via sh to check for shell builtins and PATH binaries
  try {
    execFileSync('sh', ['-c', `command -v ${shellEscape(cmd)}`], {
      stdio: 'pipe',
      timeout: 5000,
    });
    return { status: 'ok' };
  } catch {
    return { status: 'stale', reason: `command not found: ${cmd}` };
  }
}

/**
 * Verify a repo-relative file path exists.
 * Check from repo root first, then relative to skill dir.
 */
function verifyPath(pathValue, repoRoot, skillDir) {
  // Skip URLs
  if (/^https?:\/\//.test(pathValue)) {
    return { status: 'unverifiable', reason: 'URL' };
  }

  const fromRoot = resolve(repoRoot, pathValue);
  if (existsSync(fromRoot)) return { status: 'ok' };

  const fromSkill = resolve(skillDir, pathValue);
  if (existsSync(fromSkill)) return { status: 'ok' };

  return { status: 'stale', reason: `path not found: ${pathValue}` };
}

/**
 * Verify a script name exists in root package.json scripts.
 */
function verifyScript(scriptName, repoRoot) {
  const pkgPath = join(repoRoot, 'package.json');
  if (!existsSync(pkgPath)) {
    return { status: 'unverifiable', reason: 'no root package.json' };
  }

  let pkg;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return { status: 'unverifiable', reason: 'could not parse root package.json' };
  }

  const scripts = pkg.scripts || {};
  if (Object.prototype.hasOwnProperty.call(scripts, scriptName)) {
    return { status: 'ok' };
  }

  return { status: 'stale', reason: `script not in package.json: ${scriptName}` };
}

/**
 * Return true if the token looks like a placeholder.
 * Placeholders: <...> or UPPERCASE_VARS (3+ chars, all caps/underscores/digits).
 */
function isPlaceholder(tok) {
  return /^<[^>]*>$/.test(tok) || /^[A-Z][A-Z0-9_]{2,}$/.test(tok);
}

/**
 * Simple shell-escape for a single token (no spaces expected in command names).
 */
function shellEscape(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
