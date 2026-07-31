import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signedRunnerCopyBasename } from '../lib/ci/bootstrap.mjs';

test('signedRunnerCopyBasename preserves .exe/.cmd and sniffs PE', () => {
  if (process.platform !== 'win32') {
    assert.equal(signedRunnerCopyBasename('C:\\x\\adlc-runner.exe', Buffer.from('MZ')), 'adlc-runner');
    return;
  }
  assert.equal(signedRunnerCopyBasename('C:\\x\\adlc-runner.exe', Buffer.from('MZ....')), 'adlc-runner.exe');
  assert.equal(signedRunnerCopyBasename('C:\\x\\adlc-runner.cmd', Buffer.from('@echo off')), 'adlc-runner.cmd');
  assert.equal(signedRunnerCopyBasename('C:\\x\\adlc-runner.bat', Buffer.from('@echo off')), 'adlc-runner.bat');
  assert.equal(signedRunnerCopyBasename('C:\\x\\adlc-runner', Buffer.from([0x4d, 0x5a, 0x00])), 'adlc-runner.exe');
  assert.equal(signedRunnerCopyBasename('C:\\x\\adlc-runner', Buffer.from('@echo off')), 'adlc-runner.cmd');
});
