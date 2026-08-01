// An exclusive per-worktree run lock.
//
// hollow-test mutates the working tree in place, so two runs in the same worktree
// are not merely wasteful — they corrupt each other. Both can pass the dirty-tree
// check during the clean baseline window, after which A mutates file X while B
// mutates file Y: each one's test command then observes the other's mutant, so
// mutants get scored against source neither run wrote, and whichever finishes
// first clears the shared in-flight record belonging to the other.
//
// The lock covers the whole run — recovery, the dirty check, the baseline, and
// every trial — because the damage starts at the dirty check, not at the first
// mutation.

import { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { probeOwner } from './inflight.mjs';

export const LOCK_BASENAME = 'adlc-hollow-test.lock';

export function lockPathFor(gitDir) {
  return join(gitDir, LOCK_BASENAME);
}

function writeLock(lockPath, pid) {
  // 'wx' is O_CREAT|O_EXCL: the existence check and the claim are one atomic
  // syscall, so two runs racing here cannot both believe they won.
  const fd = openSync(lockPath, 'wx');
  try {
    writeSync(fd, JSON.stringify({ pid }));
  } finally {
    closeSync(fd);
  }
}

/**
 * Take the run lock, or explain why not.
 *
 * A lock whose owner is DEFINITELY gone is reclaimed: a SIGKILLed run would
 * otherwise wedge the tool permanently, which is the same "operator must clean up
 * after us by hand" failure this work exists to remove. An owner that is alive —
 * or whose state cannot be established — is never displaced.
 *
 * @returns {{ok: true, release: () => void} | {ok: false, reason: string, ownerPid: number|null}}
 */
export function acquireRunLock(lockPath, { pid = process.pid, probe = probeOwner } = {}) {
  const claim = () => ({
    ok: true,
    release: () => {
      try {
        if (!existsSync(lockPath)) return;
        const held = readLockPid(lockPath);
        // Only ever drop OUR OWN lock: releasing one we reclaimed from underneath
        // a live run would hand the tree to two writers at once.
        if (held === null || held === pid) unlinkSync(lockPath);
      } catch { /* best effort */ }
    },
  });

  try {
    writeLock(lockPath, pid);
    return claim();
  } catch (err) {
    if (err.code !== 'EEXIST') {
      return { ok: false, reason: `could not create the run lock: ${err.message}`, ownerPid: null };
    }
  }

  const ownerPid = readLockPid(lockPath);
  const state = probe(ownerPid);
  if (state === 'alive') {
    return { ok: false, reason: 'another hollow-test run holds the lock', ownerPid };
  }
  if (state === 'unknown') {
    return {
      ok: false,
      reason: 'a run lock exists and its owner could not be identified',
      ownerPid,
    };
  }

  // Owner is definitely gone: the lock is a corpse, not a claim.
  try {
    unlinkSync(lockPath);
    writeLock(lockPath, pid);
    return claim();
  } catch (err) {
    // Lost a race to another run that reclaimed it first — correct to back off.
    return { ok: false, reason: `could not reclaim the stale run lock: ${err.message}`, ownerPid };
  }
}

export function readLockPid(lockPath) {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'));
    return typeof parsed?.pid === 'number' ? parsed.pid : null;
  } catch {
    return null;
  }
}
