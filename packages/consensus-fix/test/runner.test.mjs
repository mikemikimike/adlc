/**
 * Tests for runner.mjs logic — candidate validation, command running,
 * and end-to-end engine with injectable completeFn.
 * No network calls. Uses tmp dirs for file fixtures.
 *
 * Issue #279: candidates return hunks, not full file content. Every fixture
 * file here is a single line, so `{startLine: 1, endLine: 1, replacement: X}`
 * is the hunk-based equivalent of the old `{content: X}` full replace —
 * same semantics, same test intent, new wire shape.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runCommand, validateCandidate, runConsensusFix, resolveTargetPath } from '../lib/runner.mjs';
import { applyChanges } from '../lib/snapshot.mjs';

function makeTmp() {
  return mkdtempSync(join(tmpdir(), 'consensus-fix-runner-test-'));
}
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** One full-line-replace hunk, for single-line fixture files. */
function replaceLine1(replacement) {
  return [{ startLine: 1, endLine: 1, replacement }];
}

/** JSON body for a single-file, single-hunk candidate response. */
function fixResponse(file, replacement) {
  return JSON.stringify({ changes: [{ file, hunks: replaceLine1(replacement) }] });
}

// ─── runCommand ──────────────────────────────────────────────────────────────

test('runCommand captures exit 0', () => {
  const result = runCommand('exit 0');
  assert.equal(result.exitCode, 0);
});

test('runCommand captures non-zero exit code', () => {
  const result = runCommand('exit 42');
  assert.equal(result.exitCode, 42);
});

test('runCommand captures stdout output', () => {
  const result = runCommand('echo hello_world');
  assert.ok(result.output.includes('hello_world'));
});

// ─── validateCandidate ───────────────────────────────────────────────────────

test('validateCandidate accepts valid candidate', () => {
  const result = validateCandidate(
    { changes: [{ file: 'src/a.mjs', hunks: replaceLine1('new content') }] },
    ['src/a.mjs']
  );
  assert.equal(result.valid, true);
  assert.equal(result.changes.length, 1);
});

test('validateCandidate rejects non-object', () => {
  const r = validateCandidate(null, ['a.mjs']);
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes('not an object'));
});

test('validateCandidate rejects missing changes array', () => {
  const r = validateCandidate({ changes: 'oops' }, ['a.mjs']);
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes('"changes"'));
});

test('validateCandidate rejects file not in allowed list', () => {
  const r = validateCandidate(
    { changes: [{ file: 'evil.mjs', hunks: replaceLine1('x') }] },
    ['allowed.mjs']
  );
  assert.equal(r.valid, false);
  assert.ok(r.reason.includes('not in the provided list'));
});

test('validateCandidate rejects change missing hunks', () => {
  const r = validateCandidate(
    { changes: [{ file: 'a.mjs' }] },
    ['a.mjs']
  );
  assert.equal(r.valid, false);
});

test('validateCandidate rejects a change with an empty hunks array', () => {
  const r = validateCandidate(
    { changes: [{ file: 'a.mjs', hunks: [] }] },
    ['a.mjs']
  );
  assert.equal(r.valid, false);
  assert.match(r.reason, /empty "hunks"/);
});

test('validateCandidate rejects a malformed hunk (non-integer startLine)', () => {
  const r = validateCandidate(
    { changes: [{ file: 'a.mjs', hunks: [{ startLine: 'one', endLine: 1, replacement: 'x' }] }] },
    ['a.mjs']
  );
  assert.equal(r.valid, false);
  assert.match(r.reason, /malformed hunk/);
});

test('validateCandidate rejects a malformed hunk (non-string replacement)', () => {
  const r = validateCandidate(
    { changes: [{ file: 'a.mjs', hunks: [{ startLine: 1, endLine: 1, replacement: 42 }] }] },
    ['a.mjs']
  );
  assert.equal(r.valid, false);
  assert.match(r.reason, /malformed hunk/);
});

test('validateCandidate accepts empty changes array', () => {
  const r = validateCandidate({ changes: [] }, ['a.mjs']);
  assert.equal(r.valid, true);
  assert.equal(r.changes.length, 0);
});

// ─── runConsensusFix (full engine, no network) ────────────────────────────────

test('runConsensusFix throws when test already passes', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'target.mjs');
    writeFileSync(f, 'export const x = 1;');

    await assert.rejects(
      () => runConsensusFix({
        testCmd: 'exit 0',
        files: [f],
        n: 2,
        tier: 'mid',
        completeFn: async () => '{"changes": []}',
      }),
      (err) => {
        assert.ok(err.isOpError);
        assert.ok(err.message.includes('already passes'));
        return true;
      }
    );
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix discards candidate with invalid JSON', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'target.mjs');
    writeFileSync(f, 'export const x = 1;');

    let callCount = 0;
    const result = await runConsensusFix({
      testCmd: 'exit 1',
      files: [f],
      n: 2,
      tier: 'mid',
      completeFn: async () => {
        callCount++;
        return 'not json at all';
      },
    });

    assert.equal(callCount, 2);
    assert.equal(result.discarded.length, 2);
    assert.equal(result.survivors.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix discards candidate referencing file outside list', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'allowed.mjs');
    writeFileSync(f, 'export const x = 1;');

    const result = await runConsensusFix({
      testCmd: 'exit 1',
      files: [f],
      n: 1,
      tier: 'mid',
      completeFn: async () => fixResponse('/etc/passwd', 'bad'),
    });

    assert.equal(result.discarded.length, 1);
    assert.ok(result.discarded[0].reason.includes('not in the provided list'));
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix discards a candidate whose hunk fails to apply cleanly — only that candidate, not the run', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'source.mjs');
    writeFileSync(f, 'original'); // 1 line

    let call = 0;
    const completeFn = async () => {
      call++;
      if (call === 1) {
        // endLine 9 is out of bounds for a 1-line file — must fail to apply.
        return JSON.stringify({ changes: [{ file: f, hunks: [{ startLine: 1, endLine: 9, replacement: 'x' }] }] });
      }
      return fixResponse(f, 'good fix');
    };

    const testCmd = `node -e "if (require('fs').readFileSync(process.argv[1], 'utf8') === 'original') process.exit(1)" "${f}"`;
    const result = await runConsensusFix({ testCmd, files: [f], n: 2, tier: 'mid', completeFn });

    assert.equal(result.discarded.length, 1);
    assert.match(result.discarded[0].reason, /hunk apply failed/);
    assert.equal(result.discarded[0].index, 0);
    // The OTHER candidate still ran normally and survived — one bad hunk
    // must not abort the whole run.
    assert.equal(result.survivors.length, 1);
    assert.equal(result.survivors[0].index, 1);

    assert.equal(readFileSync(f, 'utf8'), 'original', 'a failed apply must never leave the file mutated');
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix: surviving candidate passes test, files restored after', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'broken.mjs');
    // File starts with broken content; fix makes test pass.
    writeFileSync(f, 'BROKEN');

    const sentinelFile = join(dir, 'sentinel.txt');
    writeFileSync(sentinelFile, 'no');

    // Test command: check if sentinel file contains 'yes'.
    const testCmd = `node -e "if (require('fs').readFileSync(process.argv[1], 'utf8') !== 'yes') process.exit(1)" "${sentinelFile}"`;

    const result = await runConsensusFix({
      testCmd,
      files: [f],
      n: 1,
      tier: 'mid',
      completeFn: async () => {
        // The "fix" writes 'yes' to the sentinel via a side effect...
        // but we can't do that from changes (changes only affect listed files).
        // Instead: make the test always pass by writing the sentinel outside changes.
        writeFileSync(sentinelFile, 'yes');
        return fixResponse(f, 'FIXED');
      },
    });

    // After run, the snapshot should be restored.
    assert.equal(readFileSync(f, 'utf8'), 'BROKEN');
    // The fix candidate should have passed (sentinel was 'yes' during its run).
    // But sentinel gets restored? No — sentinel is not in the snapshot.
    // So the test will pass during the candidate run.
    assert.equal(result.survivors.length, 1);
    assert.equal(result.survivors[0].passed, true);
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix restores files even when candidate test fails', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'file.mjs');
    writeFileSync(f, 'original content');

    const result = await runConsensusFix({
      testCmd: 'exit 1',  // always fails
      files: [f],
      n: 1,
      tier: 'mid',
      completeFn: async () => fixResponse(f, 'attempted fix'),
    });

    // File should be restored to original.
    assert.equal(readFileSync(f, 'utf8'), 'original content');
    assert.equal(result.failed.length, 1);
    assert.equal(result.survivors.length, 0);
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix groups and selects winner across multiple candidates', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'source.mjs');
    writeFileSync(f, 'original');

    let call = 0;
    const completeFn = async () => {
      call++;
      // Candidates 1 and 3 return the same fix; candidate 2 returns different.
      if (call === 2) {
        return fixResponse(f, 'minority fix');
      }
      return fixResponse(f, 'majority fix');
    };

    // We need the test to pass.  We'll use a test that checks what's in the file.
    // The check: if file contains 'majority fix' or 'minority fix' → exit 0.
    const testCmd = `node -e "if (require('fs').readFileSync(process.argv[1], 'utf8') === 'original') process.exit(1)" "${f}"`;

    const result = await runConsensusFix({
      testCmd,
      files: [f],
      n: 3,
      tier: 'mid',
      completeFn,
    });

    assert.equal(result.survivors.length, 3);
    assert.equal(result.groups.size, 2);  // two distinct fix texts
    const sel = result.selectionResult;
    assert.ok(sel);
    assert.equal(sel.largestGroupSize, 2);
    // Winner should come from the majority group (indices 0 and 2).
    assert.ok([0, 2].includes(sel.winner.index));

    // Files restored.
    assert.equal(readFileSync(f, 'utf8'), 'original');
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix all-divergent flag set correctly', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'source.mjs');
    writeFileSync(f, 'original');

    let call = 0;
    const completeFn = async () => {
      call++;
      // Every candidate returns a unique fix.
      return fixResponse(f, `fix${call}`);
    };

    const testCmd = `node -e "if (require('fs').readFileSync(process.argv[1], 'utf8') === 'original') process.exit(1)" "${f}"`;

    const result = await runConsensusFix({
      testCmd,
      files: [f],
      n: 3,
      tier: 'mid',
      completeFn,
    });

    assert.equal(result.survivors.length, 3);
    assert.equal(result.allDivergent, true);
  } finally {
    cleanup(dir);
  }
});

// ─── rails (regression gate) ──────────────────────────────────────────────────

test('runConsensusFix: candidate passing test-cmd but failing rails is NOT a survivor', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'source.mjs');
    writeFileSync(f, 'original');

    // The repro gate (testCmd) passes whenever the file is no longer 'original'.
    const testCmd = `node -e "if (require('fs').readFileSync(process.argv[1], 'utf8') === 'original') process.exit(1)" "${f}"`;
    // The rails gate (railsCmd) passes ONLY when the file contains 'good fix'.
    // A candidate that writes anything else games the repro but reddens rails.
    const railsCmd = `node -e "if (require('fs').readFileSync(process.argv[1], 'utf8') !== 'good fix') process.exit(1)" "${f}"`;

    let call = 0;
    const completeFn = async () => {
      call++;
      // Candidate 1: gaming fix — passes repro, fails rails.
      if (call === 1) {
        return fixResponse(f, 'gaming fix');
      }
      // Candidates 2 and 3: honest fix — passes both gates.
      return fixResponse(f, 'good fix');
    };

    const result = await runConsensusFix({
      testCmd,
      railsCmd,
      files: [f],
      n: 3,
      tier: 'mid',
      completeFn,
    });

    assert.equal(result.railsChecked, true);
    // Only the two honest candidates survive; the gaming one is rejected.
    assert.equal(result.survivors.length, 2);
    assert.ok(result.survivors.every((s) => s.index !== 0));

    // The gaming candidate passed the repro but failed the rails — it lands in
    // `failed`, not `survivors`.
    const gaming = result.failed.find((r) => r.index === 0);
    assert.ok(gaming, 'gaming candidate should be in failed');
    assert.equal(gaming.testPassed, true);
    assert.equal(gaming.railsPassed, false);
    assert.equal(gaming.passed, false);

    // The winner comes from the honest group (indices 1 or 2), never index 0.
    assert.ok(result.selectionResult);
    assert.notEqual(result.selectionResult.winner.index, 0);

    assert.equal(readFileSync(f, 'utf8'), 'original');
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix: competing candidate that passes both gates wins over a smaller-diff gaming fix', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'source.mjs');
    writeFileSync(f, 'original');

    const testCmd = `node -e "if (require('fs').readFileSync(process.argv[1], 'utf8') === 'original') process.exit(1)" "${f}"`;
    const railsCmd = `node -e "if (!require('fs').readFileSync(process.argv[1], 'utf8').includes('RAILS_OK')) process.exit(1)" "${f}"`;

    let call = 0;
    const fn = async () => {
      call++;
      // Candidate 1: tiny diff that games the repro but lacks the rails token.
      if (call === 1) {
        return fixResponse(f, 'x');
      }
      // Candidate 2: larger diff that satisfies the rails gate.
      return fixResponse(f, 'RAILS_OK fix line one');
    };

    const result = await runConsensusFix({
      testCmd,
      railsCmd,
      files: [f],
      n: 2,
      tier: 'mid',
      completeFn: fn,
    });

    // Only the rails-passing candidate survives — even though the gaming fix
    // has the smaller diff, the smallest-diff tiebreaker never sees it.
    assert.equal(result.survivors.length, 1);
    assert.equal(result.survivors[0].index, 1);
    assert.equal(result.selectionResult.winner.index, 1);

    assert.equal(readFileSync(f, 'utf8'), 'original');
  } finally {
    cleanup(dir);
  }
});

// ─── providerNames (--providers) ──────────────────────────────────────────────
// Issue #63: draw one candidate per requested provider family instead of N
// samples of one auto-detected provider. completeFn receives (prompt, providerName)
// so the injected fn can route to the right provider without a real network call.

test('runConsensusFix: providerNames issues exactly one completeFn call per named provider, in order', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'source.mjs');
    writeFileSync(f, 'original');
    const testCmd = `node -e "if (require('fs').readFileSync(process.argv[1], 'utf8') === 'original') process.exit(1)" "${f}"`;

    const seenProviders = [];
    const completeFn = async (_prompt, providerName) => {
      seenProviders.push(providerName);
      return fixResponse(f, `fix-from-${providerName}`);
    };

    const result = await runConsensusFix({
      testCmd,
      files: [f],
      n: 3, // --n is ignored/overridden when providerNames is supplied
      tier: 'mid',
      providerNames: ['anthropic', 'openai', 'gemini'],
      completeFn,
    });

    assert.deepEqual(seenProviders, ['anthropic', 'openai', 'gemini']);
    assert.equal(result.survivors.length, 3);
    // Each survivor's changeset is genuinely distinct (three different providers).
    assert.equal(result.groups.size, 3);
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix: providerNames results record which provider produced which candidate', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'source.mjs');
    writeFileSync(f, 'original');
    const testCmd = `node -e "if (require('fs').readFileSync(process.argv[1], 'utf8') === 'original') process.exit(1)" "${f}"`;

    const completeFn = async (_prompt, providerName) => fixResponse(f, `fix-from-${providerName}`);

    const result = await runConsensusFix({
      testCmd,
      files: [f],
      providerNames: ['anthropic', 'openai'],
      tier: 'mid',
      completeFn,
    });

    assert.deepEqual(
      result.survivors.map((s) => s.provider).sort(),
      ['anthropic', 'openai']
    );
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix: providerNames + a failing provider surfaces as a discarded candidate, not a thrown error', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'source.mjs');
    writeFileSync(f, 'original');
    const testCmd = `node -e "if (require('fs').readFileSync(process.argv[1], 'utf8') === 'original') process.exit(1)" "${f}"`;

    const completeFn = async (_prompt, providerName) => {
      if (providerName === 'openai') throw new Error('provider "openai" is not available');
      return fixResponse(f, `fix-from-${providerName}`);
    };

    const result = await runConsensusFix({
      testCmd,
      files: [f],
      providerNames: ['anthropic', 'openai'],
      tier: 'mid',
      completeFn,
    });

    assert.equal(result.discarded.length, 1);
    assert.match(result.discarded[0].reason, /openai/);
    assert.equal(result.survivors.length, 1);
    assert.equal(result.survivors[0].provider, 'anthropic');
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix: without providerNames, behavior is unchanged (n resamples, no provider field)', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'source.mjs');
    writeFileSync(f, 'original');
    const testCmd = `node -e "if (require('fs').readFileSync(process.argv[1], 'utf8') === 'original') process.exit(1)" "${f}"`;

    let callCount = 0;
    const completeFn = async (_prompt, providerName) => {
      callCount++;
      assert.equal(providerName, undefined, 'no per-invocation provider override by default');
      return fixResponse(f, 'same fix');
    };

    const result = await runConsensusFix({
      testCmd,
      files: [f],
      n: 2,
      tier: 'mid',
      completeFn,
    });

    assert.equal(callCount, 2);
    assert.equal(result.survivors.length, 2);
    assert.ok(result.survivors.every((s) => s.provider === undefined));
  } finally {
    cleanup(dir);
  }
});

test('runConsensusFix: without --rails, emits a warning and survivors are repro-only', async () => {
  const dir = makeTmp();
  try {
    const f = join(dir, 'source.mjs');
    writeFileSync(f, 'original');

    const testCmd = `node -e "if (require('fs').readFileSync(process.argv[1], 'utf8') === 'original') process.exit(1)" "${f}"`;

    const messages = [];
    const result = await runConsensusFix({
      testCmd,
      // no railsCmd
      files: [f],
      n: 1,
      tier: 'mid',
      completeFn: async () => fixResponse(f, 'any fix'),
      onProgress: (m) => messages.push(m),
    });

    assert.equal(result.railsChecked, false);
    // A warning about the missing rails gate is surfaced (no silent caps).
    assert.ok(
      messages.some((m) => /WARNING/.test(m) && /--rails/.test(m)),
      'expected a WARNING mentioning --rails'
    );
    // The candidate still survives on the repro gate alone.
    assert.equal(result.survivors.length, 1);
    assert.equal(result.survivors[0].railsPassed, true);
    assert.equal(result.survivors[0].railsChecked, false);

    assert.equal(readFileSync(f, 'utf8'), 'original');
  } finally {
    cleanup(dir);
  }
});

// ─── candidate filename → caller's original path (Windows separator mismatch) ──
//
// validateCandidate compares separator-NORMALIZED paths, so a model may answer
// `src/file.mjs` for a `--files src\file.mjs` run and pass validation. The
// snapshot and the write are both keyed by the CALLER'S original string, so the
// bin has to map back. Getting this wrong is not a clean failure: the apply loop
// writes as it goes, so with several files the run dies on `undefined` only
// AFTER earlier files are already modified — a partially written tree.

test('resolveTargetPath maps a candidate\'s separators back to the caller\'s path', () => {
  const callerPaths = ['src\\alpha.mjs', 'src\\beta.mjs'];
  assert.equal(resolveTargetPath('src/alpha.mjs', callerPaths, 'win32'), 'src\\alpha.mjs');
  assert.equal(resolveTargetPath('src/beta.mjs', callerPaths, 'win32'), 'src\\beta.mjs');
});

test('resolveTargetPath is identity when the candidate already matches the caller', () => {
  const callerPaths = ['src/alpha.mjs', 'nested/dir/beta.mjs'];
  assert.equal(resolveTargetPath('src/alpha.mjs', callerPaths), 'src/alpha.mjs');
  assert.equal(resolveTargetPath('nested/dir/beta.mjs', callerPaths), 'nested/dir/beta.mjs');
});

test('resolveTargetPath falls back to the candidate when nothing matches', () => {
  // The caller has already rejected any file outside the allowed list, so the
  // fallback cannot introduce a path the operator did not name — it just keeps
  // the error message pointing at what the model actually said.
  assert.equal(resolveTargetPath('src/unknown.mjs', ['src/alpha.mjs']), 'src/unknown.mjs');
});

// THE PREVIOUS VERSION OF THIS TEST PINNED A WRONG-FILE WRITE. It asserted that
// `src/a.mjs` resolves to `src\a.mjs` when both are supplied — which on POSIX,
// where those are two DIFFERENT files, means evaluating a candidate against one
// file and writing the other. Asserting "deterministic" was not enough: the
// deterministic answer it locked in was the unsafe one.
test('resolveTargetPath prefers an EXACT match over a separator-normalized one', () => {
  // Both spellings present, candidate matches one of them verbatim → that one.
  assert.equal(resolveTargetPath('src/a.mjs', ['src\\a.mjs', 'src/a.mjs'], 'linux'), 'src/a.mjs');
  assert.equal(resolveTargetPath('src\\a.mjs', ['src/a.mjs', 'src\\a.mjs'], 'linux'), 'src\\a.mjs');
  // Exact match wins on win32 too.
  assert.equal(resolveTargetPath('src/a.mjs', ['src\\a.mjs', 'src/a.mjs'], 'win32'), 'src/a.mjs');
});

test('resolveTargetPath does NOT treat \\ and / as equivalent on POSIX', () => {
  // A backslash is an ordinary filename character on POSIX. Silently rewriting
  // the candidate to a different caller path is a wrong-file write, so the
  // candidate is returned unchanged and the caller's "not in snapshot" check
  // reports it honestly.
  assert.equal(resolveTargetPath('src/a.mjs', ['src\\a.mjs'], 'linux'), 'src/a.mjs');
  assert.equal(resolveTargetPath('src\\a.mjs', ['src/a.mjs'], 'linux'), 'src\\a.mjs');
});

test('resolveTargetPath DOES map separators on win32, where they name one file', () => {
  assert.equal(resolveTargetPath('src/a.mjs', ['src\\a.mjs'], 'win32'), 'src\\a.mjs');
  assert.equal(resolveTargetPath('src\\a.mjs', ['src/a.mjs'], 'win32'), 'src/a.mjs');
});

// WIRING, not just the helper. The previous tests exercised resolveTargetPath()
// directly, so reverting the production call sites left them green — exactly the
// hollow shape this repo's gates exist to reject. This drives applyChanges (the
// EVALUATION path) against a snapshot whose keys use a different separator from
// the candidate, and asserts the real file on disk changed. Before the fix,
// evaluation resolved via a Map (which keeps the LAST duplicate) while --apply
// used the first match, so the two could target DIFFERENT files on a POSIX box
// where `a\b.mjs` and `a/b.mjs` are genuinely distinct paths.
test('applyChanges resolves a separator-mismatched candidate to the snapshot key', () => {
  const dir = mkdtempSync(join(tmpdir(), 'consensus-fix-wiring-'));
  try {
    const real = join(dir, 'target.mjs');
    writeFileSync(real, 'line1\nline2\n');
    const snapshot = { [real]: 'line1\nline2\n' };
    // The candidate names the same file with the OTHER separator style.
    const candidateName = real.replaceAll('/', '\\');
    // Separator mapping is win32-only (on POSIX those are different files), so
    // the platform is forced here — the point of this test is the WIRING, that
    // applyChanges consults resolveTargetPath at all, not which platform rule
    // applies. Synchronous callback: the override is process-global.
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    let res;
    try {
      res = applyChanges(
        [{ file: candidateName, hunks: [{ startLine: 1, endLine: 1, replacement: 'PATCHED' }] }],
        snapshot,
      );
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
    assert.equal(res.ok, true, res.error);
    assert.match(readFileSync(real, 'utf8'), /PATCHED/, 'the real snapshot-keyed file must be the one written');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// VALIDATION AND APPLICATION MUST AGREE. They used different equivalence rules:
// validateCandidate folded separators on every platform while resolveTargetPath
// folds only on win32. On POSIX a candidate naming `src/a.mjs` for
// `--files src\a.mjs` therefore PASSED validation and then threw inside
// applyChanges — and runConsensusFix has no catch around that call, so a single
// malformed candidate aborted the whole ensemble instead of being discarded.
// The invariant: anything validation ACCEPTS, application must be able to place.
test('validateCandidate and resolveTargetPath use the SAME equivalence rule', () => {
  const callerPaths = ['src\\a.mjs'];
  const candidate = { changes: [{ file: 'src/a.mjs', hunks: [{ startLine: 1, endLine: 1, replacement: 'x' }] }] };

  for (const platform of ['linux', 'darwin', 'win32']) {
    const { valid } = validateCandidate(candidate, callerPaths, platform);
    if (!valid) continue; // rejected up front — nothing to place, and that is fine
    const target = resolveTargetPath('src/a.mjs', callerPaths, platform);
    assert.ok(
      callerPaths.includes(target),
      `${platform}: validation accepted the candidate but application resolved to ${JSON.stringify(target)}, which is not a caller path`,
    );
  }
});

test('POSIX validation REJECTS a separator-mismatched candidate outright', () => {
  // Rejecting it as "not in the provided list" is the honest answer on POSIX,
  // where the two spellings are different files — and it discards one candidate
  // rather than aborting the ensemble downstream.
  const { valid, reason } = validateCandidate(
    { changes: [{ file: 'src/a.mjs', hunks: [{ startLine: 1, endLine: 1, replacement: 'x' }] }] },
    ['src\\a.mjs'],
    'linux',
  );
  assert.equal(valid, false);
  assert.match(reason, /not in the provided list/);
});
