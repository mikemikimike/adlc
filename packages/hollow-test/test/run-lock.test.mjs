// The run lock is what stops two hollow-test runs sharing one worktree.
//
// That is not a tidiness concern: both runs can clear the dirty-tree check during
// the baseline window, after which each one's test command observes the other's
// mutant — so mutants get scored against source neither run wrote — and whichever
// finishes first clears the other's in-flight record, stranding a mutant with no
// way back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireRunLock, lockPathFor, readLockPid, LOCK_BASENAME } from '../lib/run-lock.mjs';

function scratch() {
  return mkdtempSync(join(tmpdir(), 'hollow-lock-'));
}

test('lockPathFor puts the lock in the git dir, where it is never committable', () => {
  assert.equal(lockPathFor('/repo/.git'), join('/repo/.git', LOCK_BASENAME));
});

test('the first run takes the lock and records its pid', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'run.lock');
    const lock = acquireRunLock(path, { pid: 111, probe: () => 'dead' });
    assert.equal(lock.ok, true);
    assert.equal(existsSync(path), true);
    assert.equal(readLockPid(path), 111);
    lock.release();
    assert.equal(existsSync(path), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a second run is REFUSED while the first is alive', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'run.lock');
    const first = acquireRunLock(path, { pid: 111, probe: () => 'dead' });
    assert.equal(first.ok, true);

    const second = acquireRunLock(path, { pid: 222, probe: () => 'alive' });
    assert.equal(second.ok, false, 'two runs must never hold this worktree at once');
    assert.equal(second.ownerPid, 111);
    // The live owner's lock must survive the refusal.
    assert.equal(readLockPid(path), 111);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an owner whose state is UNKNOWN is never displaced', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'run.lock');
    acquireRunLock(path, { pid: 111, probe: () => 'dead' });
    const second = acquireRunLock(path, { pid: 222, probe: () => 'unknown' });
    assert.equal(second.ok, false, 'only a DEFINITELY dead owner may be reclaimed');
    assert.equal(readLockPid(path), 111);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a lock left by a dead run is reclaimed rather than wedging the tool forever', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'run.lock');
    acquireRunLock(path, { pid: 111, probe: () => 'dead' });
    // 111 was SIGKILLed and never released. Refusing here would mean the operator
    // has to delete a lockfile by hand — the same "clean up after us" failure this
    // whole change exists to remove.
    const next = acquireRunLock(path, { pid: 222, probe: () => 'dead' });
    assert.equal(next.ok, true);
    assert.equal(readLockPid(path), 222);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('release only ever drops OUR lock, never one reclaimed from under a live run', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'run.lock');
    const mine = acquireRunLock(path, { pid: 111, probe: () => 'dead' });
    assert.equal(mine.ok, true);

    // Someone else now owns it (as if we had been reclaimed as stale).
    writeFileSync(path, JSON.stringify({ pid: 999 }));
    mine.release();

    assert.equal(existsSync(path), true, 'released a lock belonging to another run');
    assert.equal(readLockPid(path), 999);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unreadable lock reports no pid rather than a bogus one', () => {
  const dir = scratch();
  try {
    const path = join(dir, 'run.lock');
    writeFileSync(path, 'not json');
    assert.equal(readLockPid(path), null);
    assert.equal(readFileSync(path, 'utf8'), 'not json', 'reading must not mutate the lock');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an unwritable lock path is reported, not thrown', () => {
  const result = acquireRunLock('/definitely/not/a/dir/run.lock', { pid: 1, probe: () => 'dead' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /run lock/);
});
