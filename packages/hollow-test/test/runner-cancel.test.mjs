// Cancellation reaches the test command itself.
//
// The trial loop can only be interrupted if something can actually terminate the
// child running the suite. Killing the shell alone is not enough: the test runner
// beneath it would be orphaned and keep writing to the very tree the signal
// handler is about to restore, so termination targets the whole PROCESS GROUP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runTest, terminateActiveTest } from '../lib/runner.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('reports that there is nothing to terminate when no test is running', () => {
  // Must be honest rather than optimistic: the signal handler uses this before
  // restoring, and a bare `true` here would claim a child was stopped that never
  // existed.
  assert.equal(terminateActiveTest(), false);
});

test('terminates the running test command and settles the trial', async () => {
  const pending = runTest('sleep 30', 60_000, process.cwd());
  // Give spawn a moment to produce a pid.
  for (let i = 0; i < 100; i += 1) {
    if (terminateActiveTest('SIGTERM')) break;
    await sleep(20);
  }

  const result = await pending;
  // classifyTestResult reads a SIGTERM death as a timeout — either way this must
  // NOT look like a completed suite, or a cancelled trial would be scored.
  assert.equal(result.status, null);
  assert.equal(result.timedOut, true);

  // State is cleared, so a later cancellation cannot signal a dead pid.
  assert.equal(terminateActiveTest(), false);
});

test('a test command that exits on its own is not reported as cancellable afterwards', async () => {
  const result = await runTest('exit 0', 60_000, process.cwd());
  assert.equal(result.status, 0);
  assert.equal(result.timedOut, false);
  assert.equal(terminateActiveTest(), false);
});
