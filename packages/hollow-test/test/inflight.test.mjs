// Unit tests for the in-flight record's liveness probe.
//
// These exist because the two properties that matter are invisible to the
// integration tests in hollow-test.test.mjs:
//
//   * "signal 0, never anything else" cannot be observed by watching a real
//     process, because a killed CHILD of the test process becomes a zombie and
//     keeps answering kill(pid, 0) until it is reaped — so a probe that actually
//     delivered SIGHUP would still look alive.
//   * EPERM needs a process owned by another user, which no test can create.
//
// They are also cheap, which matters: the mutation gate re-runs this package's
// tests once per mutant, so pinning behaviour here instead of with another
// spawned run keeps that gate affordable.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pidAlive } from '../lib/inflight.mjs';

function killError(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

test('probes with signal 0, which delivers nothing', () => {
  const calls = [];
  pidAlive(4242, (pid, signal) => { calls.push({ pid, signal }); });

  assert.deepEqual(calls, [{ pid: 4242, signal: 0 }]);
  // Any other signal number is DELIVERED. Signal 1 is SIGHUP, which would
  // terminate the concurrent hollow-test run this probe exists to protect.
  assert.notEqual(calls[0].signal, 1);
});

test('a pid that can be signalled is alive', () => {
  assert.equal(pidAlive(4242, () => {}), true);
});

test('ESRCH means the owner is gone, so its record is recoverable', () => {
  assert.equal(pidAlive(4242, () => { throw killError('ESRCH'); }), false);
});

test('EPERM means the owner EXISTS but is not ours — still alive, do not touch its file', () => {
  // Must be exactly true, not merely truthy: the caller uses this in a && chain
  // where a nullish return would read as "dead" and clobber a live run's file.
  assert.equal(pidAlive(4242, () => { throw killError('EPERM'); }), true);
});

test('an unrecognised kill failure is treated as gone, not as alive', () => {
  assert.equal(pidAlive(4242, () => { throw killError('EINVAL'); }), false);
});
