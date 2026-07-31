// The entry-point guard decides whether importing this module ALSO runs its CLI
// (argv parsing, process.exit, gateFail). It used to lowercase both sides of the
// path comparison unconditionally; on a case-sensitive filesystem `Fleet.mjs` and
// `fleet.mjs` are DIFFERENT files, so the fold could make an import of one dispatch
// the other. The fold is correct on win32 and wrong everywhere else, so these tests
// assert BOTH platforms — a test that only ran the host's platform could not tell a
// correctly gated fold from an unconditional one.
//
// fleet-entry.test.mjs covers the other side of the guard (a real direct run must
// still dispatch) as a subprocess; that file deliberately does not import the bin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isEntryPoint } from '../bin/fleet.mjs';
import { withPlatform, withWin32Platform } from './platform-mock.mjs';

const BIN_URL = new URL('../bin/fleet.mjs', import.meta.url).href;
const BIN = fileURLToPath(BIN_URL);
// Same directory, differently-cased basename. On win32 this names the same file;
// on a case-sensitive filesystem it names a different one.
const MISCASED = join(dirname(BIN), 'FLEET.mjs');
const POSIX_PLATFORMS = ['linux', 'darwin'];

test('running the bin itself is the entry point on every platform', () => {
  for (const platform of [...POSIX_PLATFORMS, 'win32']) {
    assert.equal(isEntryPoint(BIN_URL, BIN, platform), true, platform);
  }
});

test('a differently-cased path is NOT the entry point on case-sensitive platforms', () => {
  for (const platform of POSIX_PLATFORMS) {
    assert.equal(isEntryPoint(BIN_URL, MISCASED, platform), false,
      `${platform}: FLEET.mjs is a different file than fleet.mjs — importing it must not dispatch`);
  }
  // Also via the real process.platform, so the guard is exercised as production reads it.
  withPlatform('linux', () => {
    assert.equal(isEntryPoint(BIN_URL, MISCASED), false);
  });
});

test('a differently-cased path IS the entry point on win32, where paths are case-insensitive', () => {
  assert.equal(isEntryPoint(BIN_URL, MISCASED, 'win32'), true);
  withWin32Platform(() => {
    assert.equal(isEntryPoint(BIN_URL, MISCASED), true,
      'win32 spells the same file many ways; a direct run must still dispatch');
  });
});

test('an unrelated entry path is never the entry point', () => {
  for (const platform of [...POSIX_PLATFORMS, 'win32']) {
    assert.equal(isEntryPoint(BIN_URL, join(dirname(BIN), 'other.mjs'), platform), false, platform);
    assert.equal(isEntryPoint(BIN_URL, join(dirname(BIN), '..', 'lib', 'fleet.mjs'), platform), false, platform);
  }
});

test('a missing argv[1] (e.g. the REPL) is not the entry point', () => {
  assert.equal(isEntryPoint(BIN_URL, undefined), false);
  assert.equal(isEntryPoint(BIN_URL, ''), false);
});

test('a relative argv[1] is resolved before comparison, not compared raw', () => {
  const cwd = process.cwd();
  try {
    process.chdir(dirname(BIN));
    assert.equal(isEntryPoint(BIN_URL, 'fleet.mjs', 'linux'), true,
      '`node fleet.mjs` from the bin directory is still a direct run');
  } finally {
    process.chdir(cwd);
  }
});
