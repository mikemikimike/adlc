// git-fixtures.mjs — build the adversarial git objects the trust-root gates must
// deny, WITHOUT needing filesystem symlink privilege.
//
// WHY THIS EXISTS. The symlink/type-confusion tests protect the manifest against
// forged evidence: a manifest committed as a mode-120000 blob makes `git show`
// return the link TARGET rather than file content, so a content-only check reads
// it as empty and passes. Those tests were written with `symlinkSync()` and then
// skipped wholesale on Windows, because creating a symlink there needs either
// Developer Mode or SeCreateSymbolicLinkPrivilege.
//
// A skipped test is not a passing test. On windows-latest the gate reported
// GREEN for the exact attack it exists to stop, and the branch's own ticket
// (requirement 4) explicitly calls for index-built objects or an EPERM
// fallback rather than per-test suppression.
//
// The key insight: these tests assert on what is COMMITTED, and git's index can
// hold a mode-120000 entry whose blob is the link target string — no filesystem
// symlink is ever created, so no privilege is required and the behaviour is
// identical on every platform. `git update-index --cacheinfo` is the documented
// plumbing for exactly this.

import { execFileSync } from 'node:child_process';

/** Run a git command in `dir`, returning trimmed stdout. */
function git(dir, args, opts = {}) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
}

/**
 * Write `content` as a loose blob and return its object id.
 * @param {string} dir  repo root
 * @param {string} content
 * @returns {string} blob sha
 */
export function hashObject(dir, content) {
  return execFileSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: dir, encoding: 'utf8', input: content, stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Stage `path` as a SYMLINK (mode 120000) pointing at `target`, using the index
 * directly. Portable: never touches the filesystem, so it works on Windows
 * without symlink privilege.
 *
 * @param {string} dir     repo root
 * @param {string} path    repo-relative path to stage
 * @param {string} target  the link target string (git stores this as the blob)
 */
export function stageSymlink(dir, path, target) {
  const blob = hashObject(dir, target);
  git(dir, ['update-index', '--add', '--cacheinfo', `120000,${blob},${path}`]);
  return blob;
}

/**
 * Stage `path` as an EXECUTABLE regular file (mode 100755).
 *
 * Windows has no execute bit, so `chmod +x` is a no-op there and a test relying
 * on it silently asserts nothing. Setting the mode in the index is exact and
 * platform-independent.
 */
export function stageExecutable(dir, path, content) {
  const blob = hashObject(dir, content);
  git(dir, ['update-index', '--add', '--cacheinfo', `100755,${blob},${path}`]);
  return blob;
}

/** Stage `path` as an ordinary regular file (mode 100644). */
export function stageRegular(dir, path, content) {
  const blob = hashObject(dir, content);
  git(dir, ['update-index', '--add', '--cacheinfo', `100644,${blob},${path}`]);
  return blob;
}

/**
 * Commit whatever is staged. Separate from the stage* helpers so a fixture can
 * build several entries into one commit.
 */
export function commitIndex(dir, message) {
  git(dir, ['commit', '-qm', message]);
}

/**
 * Create a WORKING-TREE symlink, or return false when the platform refuses.
 *
 * A few cases genuinely need a symlink on disk (the gate reads the working tree,
 * not a commit), and the index trick cannot express that. Those callers get an
 * honest boolean instead of a blanket platform skip, so the test still RUNS on
 * Windows and only opts out when the OS actually denies the operation.
 *
 * @returns {boolean} whether the symlink was created
 */
export function tryWorktreeSymlink(symlinkSync, target, path) {
  try {
    symlinkSync(target, path);
    return true;
  } catch (err) {
    // EPERM/EACCES: no SeCreateSymbolicLinkPrivilege and Developer Mode off.
    if (err?.code === 'EPERM' || err?.code === 'EACCES') return false;
    throw err;
  }
}
