// spawn-safe.mjs — resolve a command to an ABSOLUTE path before it can reach a
// shell, and build a correctly-quoted cmd.exe invocation.
//
// WHY THIS EXISTS (cross-model review finding, #352 windows-compat).
//
// The Windows compatibility work introduced two call sites that spawned a BARE
// command name (`agy.cmd`, `copilot.cmd`) with `shell: true` on win32. That is a
// repo-local command hijack:
//
//   cmd.exe resolves a bare command name against the CURRENT DIRECTORY BEFORE it
//   searches PATH.
//
// Both call sites run with cwd set to the repository under analysis — which is
// attacker-controlled in the exact scenarios these tools exist for (reviewing an
// untrusted change, driving a gate over a fetched branch). A repo that merely
// CONTAINS a file named `agy.cmd` at its root would have that file executed with
// the operator's credentials, and the prompt — which can carry source, ticket
// text, and review context — handed to it on stdin. The pre-existing
// metacharacter denylist does not help: it validates the OVERRIDE string, and
// this path is the trusted DEFAULT, so nothing was ever checked.
//
// The same hole exists on POSIX in a quieter form: an EMPTY component in PATH
// (`PATH=/usr/bin:` or a leading/doubled `:`) means "the current directory" to
// the shell. resolveOnPath therefore SKIPS empty components rather than joining
// them, which would silently reintroduce cwd resolution.
//
// The fix is not "escape harder" — it is to never hand a shell a name it has to
// resolve. Resolve to an absolute path here, from PATH only, and pass that.

import { statSync, accessSync, constants } from 'node:fs';
import path from 'node:path';

/**
 * Default probe: the candidate must be a FILE.
 *
 * `existsSync` is wrong here — it answers true for a DIRECTORY, so a directory
 * named `agy.cmd` earlier on PATH would be "resolved" and then handed to spawn,
 * shadowing the real executable further along. Returning false for anything
 * that is not a regular file keeps the search going.
 */
export const isRunnableFile = (p, platform = process.platform) => {
  try {
    if (!statSync(p).isFile()) return false;
  } catch {
    return false; // ENOENT, EACCES on a parent, a broken symlink — not usable
  }
  // On POSIX a regular file is not necessarily RUNNABLE. A mode-0644 `agy`
  // sitting earlier on PATH would otherwise be "resolved" and then spawned,
  // failing EACCES instead of falling through to the real 0755 one further
  // along — the same shadowing the directory check closed, one permission bit
  // over. Windows has no execute bit; a `.cmd`/`.exe` is selected by extension,
  // so the regular-file check is the right (and only) test there.
  if (platform === 'win32') return true;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// Path semantics must follow the PLATFORM ARGUMENT, not the host running this
// code. `path.isAbsolute` on a Mac does not recognise `C:\tools`, and `path.join`
// there produces `C:\tools/agy.cmd` — so a host-flavoured implementation would
// mis-resolve every win32 input and, worse, silently classify an absolute
// Windows PATH entry as "relative" and skip it. Selecting the flavour keeps the
// win32 branch honest on any host (which is also what makes it testable).
const flavour = (platform) => (platform === 'win32' ? path.win32 : path.posix);

/**
 * FULLY QUALIFIED, not merely "absolute".
 *
 * `path.win32.isAbsolute('\\tools\\agy.cmd')` is TRUE, but a single leading
 * separator on Windows is DRIVE-RELATIVE: it inherits whatever drive the process
 * is currently on. `\\attacker\\cmd.exe` therefore resolves differently depending
 * on cwd — which is exactly the property this module exists to eliminate, so
 * accepting it contradicts the fail-closed contract. Drive-qualified (`C:\\...`)
 * and UNC (`\\\\server\\share\\...`) forms are genuinely anchored and stay allowed.
 */
const isFullyQualified = (value, platform) => {
  const p = flavour(platform);
  if (!p.isAbsolute(value)) return false;
  if (platform !== 'win32') return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;   // C:\... or C:/...
  if (/^[\\/]{2}[^\\/]/.test(value)) return true;    // \\server\share (UNC)
  return false;                                    // \tools\... — drive-relative
};

/**
 * Candidate filenames for `name` on the given platform, in resolution order.
 *
 * Windows executables are selected by extension, and a bare name matches
 * several. The order mirrors what cmd.exe's PATHEXT does in practice and what
 * scripts/ceremony-drift.mjs's `gh` resolver already uses: batch shims first
 * (that is what npm installs for a JS CLI), then a real executable.
 *
 * @param {string} name  bare command name (no directory component)
 * @param {string} platform
 * @returns {string[]}
 */
export function binCandidates(name, platform = process.platform) {
  if (platform !== 'win32') return [name];
  // An explicit extension is already unambiguous — do not append more.
  if (/\.[A-Za-z0-9]+$/.test(name)) return [name];
  return [`${name}.cmd`, `${name}.exe`, `${name}.bat`, name];
}

/**
 * Resolve a bare command name to an absolute path using PATH ONLY.
 *
 * Returns null when the command is not found — callers must FAIL CLOSED on null
 * rather than falling back to the bare name, which is precisely the hijack this
 * module exists to close.
 *
 * An input that already contains a directory separator is returned as-is when
 * absolute (the caller chose an explicit path) and is REFUSED (null) when
 * relative, since a relative path is cwd-anchored and therefore attacker-
 * reachable in the same way a bare name is.
 *
 * @param {string} name
 * @param {{env?: NodeJS.ProcessEnv, platform?: string, exists?: (p: string) => boolean}} [opts]
 * @returns {string|null} absolute path, or null when unresolvable
 */
export function resolveOnPath(name, opts = {}) {
  const {
    env = process.env,
    platform = process.platform,
    exists = (candidate) => isRunnableFile(candidate, platform),
  } = opts;
  const p = flavour(platform);
  const value = String(name ?? '');
  if (value === '') return null;

  if (/[/\\]/.test(value)) return isFullyQualified(value, platform) && exists(value) ? value : null;

  // Windows env names are case-insensitive, so PATH may arrive as `Path`.
  const pathValue = platform === 'win32'
    ? env[Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH']
    : env.PATH;

  const candidates = binCandidates(value, platform);
  for (const dir of String(pathValue ?? '').split(p.delimiter)) {
    // An EMPTY component means "current directory" to a shell. Skipping it is
    // the POSIX half of this module's whole purpose — see the header.
    if (!dir) continue;
    // A relative PATH entry is cwd-anchored and equally hijackable.
    if (!isFullyQualified(dir, platform)) continue;
    for (const candidate of candidates) {
      const full = p.join(dir, candidate);
      if (exists(full)) return full;
    }
  }
  return null;
}

/**
 * Quote one argv element for a `cmd.exe /s /c "<line>"` command line so shell
 * metacharacters inside it (`& | < > ^ %`) stay LITERAL.
 *
 * Node's own `shell: true` builds that line by joining argv with spaces and no
 * quoting, so any argument containing `>` is reparsed by cmd.exe as a
 * redirection — which is how a prompt containing `>` silently became a file
 * write instead of an argument. `%` is doubled because cmd.exe expands
 * `%VAR%` inside the line.
 *
 * @param {string} arg
 * @returns {string}
 */
export function quoteWinCmdArg(arg) {
  const s = String(arg).replace(/%/g, '%%');
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * Build the argv for spawning `bin args...` through cmd.exe with every element
 * quoted. Pair with `windowsVerbatimArguments: true` so Node does not re-quote
 * the line we just built.
 *
 * @param {string} bin  absolute path (see resolveOnPath)
 * @param {string[]} args
 * @returns {string[]} argv for cmd.exe
 */
export function winCmdArgs(bin, args = []) {
  return ['/d', '/s', '/c', `"${[bin, ...args].map(quoteWinCmdArg).join(' ')}"`];
}

/**
 * The command interpreter to spawn `winCmdArgs` with — ALWAYS an absolute path.
 *
 * Returning a bare `cmd.exe` would reopen, one level up, the exact hole this
 * module exists to close: Windows searches the CURRENT DIRECTORY before the
 * system directories when resolving an unqualified executable, so a checkout
 * containing `cmd.exe` would supply the interpreter for every command we were
 * carefully resolving to an absolute path. A RELATIVE `ComSpec` is rejected for
 * the same reason — it is cwd-anchored.
 *
 * The fallback is `%SystemRoot%\System32\cmd.exe`, the canonical location, with
 * `C:\Windows` only as a last resort when SystemRoot is also absent. Callers on
 * a sanitised env (this repo scrubs env aggressively for gate subprocesses) hit
 * that path routinely, so it must not be the unsafe one.
 */
export function winShell(env = process.env) {
  const comSpec = env.ComSpec ?? env.COMSPEC;
  if (comSpec && isFullyQualified(comSpec, 'win32')) return comSpec;
  return winSystemExe('cmd.exe', env);
}

/**
 * Absolute path to a stock Windows system executable under `%SystemRoot%\System32`.
 *
 * EVERY env-derived component is checked for absoluteness. A previous version of
 * winShell() validated `ComSpec` but then joined `SystemRoot` unchecked, so
 * `{ SystemRoot: '.' }` produced the relative `System32\cmd.exe` — the same
 * cwd-resolved interpreter the check was added to prevent, reached by a
 * different door. Any env-supplied root that is not absolute is discarded in
 * favour of the literal default; a caller cannot end up with a relative result.
 *
 * Use this for system tools (`cmd.exe`, `where.exe`) rather than spawning them
 * by bare name: Windows searches the current directory first, and these run with
 * cwd set to the repository under analysis.
 *
 * @param {string} name  e.g. 'cmd.exe', 'where.exe'
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} absolute path
 */
export function winSystemExe(name, env = process.env) {
  const root = env.SystemRoot ?? env.SYSTEMROOT;
  const base = root && isFullyQualified(root, 'win32') ? root : 'C:\\Windows';
  return path.win32.join(base, 'System32', name);
}

/**
 * Collapse a case-variant Windows PATH key onto canonical `PATH`, in place.
 *
 * ORDER IS LOAD-BEARING and is the entire reason this is a function rather than
 * three inline statements. Windows `process.env` is CASE-INSENSITIVE, so `Path`
 * and `PATH` are the SAME variable: assigning `PATH` and THEN deleting `Path`
 * removes the value just written and leaves the process with no PATH at all.
 * Read, delete, then assign.
 *
 * Exported so the contract is testable against the real implementation — an
 * earlier test copied these statements into itself and therefore stayed green
 * no matter what production did.
 *
 * @param {NodeJS.ProcessEnv|Record<string,string>} env  mutated in place
 * @returns {boolean} whether a variant was collapsed
 */
export function normalizePathKey(env) {
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  if (!pathKey || pathKey === 'PATH') return false;
  const value = env[pathKey];
  delete env[pathKey];
  env.PATH = value;
  return true;
}

/**
 * Fold `\` to `/` ONLY on Windows.
 *
 * Separator equivalence is a Windows fact, not a universal one. On POSIX a
 * backslash is an ordinary filename character, so `test\critical.mjs` and
 * `test/critical.mjs` are two DIFFERENT files. Folding them unconditionally has
 * already produced three distinct defects in this repo: a wrong-file write in
 * consensus-fix, a source file misclassified as a test (mutation-gate then
 * exiting 0 with "nothing to mutate"), and mis-attributed merge signals.
 *
 * Lives here, once, because the same fold was independently reimplemented at
 * four call sites and each copy had to be found separately.
 */
export function foldWinSeparators(value, platform = process.platform) {
  return platform === 'win32' ? String(value).replaceAll('\\', '/') : String(value);
}
