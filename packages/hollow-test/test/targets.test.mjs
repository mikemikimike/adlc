// targets.test.mjs — path CLASSIFICATION, which decides whether the mutation
// gate has anything to do at all. A misclassification here does not fail
// loudly; it makes the gate exit 0 having mutated nothing.

import test from 'node:test';
import assert from 'node:assert/strict';
import { isMutableSource } from '../lib/targets.mjs';


// THE FALSE PASS THIS GUARDS. `test\critical.mjs` is a legal POSIX filename —
// one file, whose name contains a backslash. Folding separators unconditionally
// turned it into `test/critical.mjs`, which EXCLUDE_DIR_RE classifies as test
// code; hollow-test then had nothing to mutate and the gate exited 0. A gate
// that silently passes is the worst possible failure, so this asserts the
// classification directly and fails the moment the platform guard is dropped.
test('a POSIX file whose NAME contains a backslash is SOURCE, not test code', () => {
  assert.equal(
    isMutableSource('src/test\\critical.mjs', { platform: 'linux' }),
    true,
    'unconditional folding makes this look like src/test/critical.mjs and the gate passes with nothing to mutate',
  );
  // The same string on win32 genuinely IS a path into a test/ directory.
  assert.equal(isMutableSource('src/test\\critical.mjs', { platform: 'win32' }), false);
});

test('a real test/ directory is still excluded on both platforms', () => {
  for (const platform of ['linux', 'win32']) {
    assert.equal(isMutableSource('src/test/critical.mjs', { platform }), false, platform);
  }
});
