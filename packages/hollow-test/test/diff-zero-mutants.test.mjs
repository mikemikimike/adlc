// hollow-test/test/diff-zero-mutants.test.mjs
// Issue #658: a diff-derived target that generates zero mutants (or cannot
// be read) must fail closed (exit 1, opError), matching the explicit
// --target/--rails behaviour — never a silent warn-then-pass(exit 0).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const BIN = resolve(new URL('.', import.meta.url).pathname, '../bin/hollow-test.mjs');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function initRepo(dir) {
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'test@test.com'], dir);
  git(['config', 'user.name', 'Test'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  git(['config', 'gpg.format', 'openpgp'], dir);
}

function commitAll(dir, msg = 'init') {
  git(['add', '-A'], dir);
  git(['commit', '-m', msg], dir);
}

function runCli(args, cwd) {
  return spawnSync('node', [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 60000,
  });
}

// A function body with NO comparison, boolean literal, return-with-value,
// numeric literal, ternary, guard clause, or array literal — nothing any
// mutation operator recognizes (verified against packages/core/lib/mutate.mjs's
// operator list: invert-comparison, bool-flip, null-return, off-by-one,
// logic-swap, negate-guard-subclause, array-literal-shrink, ternary-swap).
const ZERO_MUTANT_FUNCTION = [
  'export function announce() {',
  "  console.log('called');",
  '}',
  '',
].join('\n');

// ── AC1: diff-derived file with content that yields zero mutants ───────────

describe('CLI: diff-derived file generates zero mutants overall', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-diffzero-'));
    initRepo(dir);
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src', 'math.mjs'), [
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'test', 'math.test.mjs'), [
      "import { describe, it } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/math.mjs';",
      "describe('add', () => {",
      "  it('sums', () => { assert.strictEqual(add(2, 3), 5); });",
      '});',
      '',
    ].join('\n'));
    commitAll(dir, 'init');

    // Second commit adds a whole new exported function with a zero-mutant
    // body, no test file changes — the exact issue #658 repro shape.
    writeFileSync(join(dir, 'src', 'math.mjs'), [
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      '',
      ZERO_MUTANT_FUNCTION,
    ].join('\n'));
    commitAll(dir, 'add announce()');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1 (not 0), refusing to report a pass', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1'],
      dir
    );
    assert.equal(result.status, 1,
      `Expected exit 1 (diff-derived zero mutants), got ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /refusing to report a pass/,
      `Expected 'refusing to report a pass' in stderr, got: ${result.stderr}`);
    assert.match(result.stderr, /math\.mjs/,
      `Expected the offending file named in stderr, got: ${result.stderr}`);
    assert.match(result.stderr, /no mutable line was found/,
      `Expected the zero-mutant reason in stderr, got: ${result.stderr}`);
  });

  it('--json mode exits 1 and prints no vacuous pass document', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1', '--json'],
      dir
    );
    assert.equal(result.status, 1,
      `Expected exit 1, got ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    // No JSON report document on stdout — this path never reaches printJson().
    assert.equal(result.stdout.trim(), '',
      `Expected empty stdout (no report printed before the fail-closed error), got: ${result.stdout}`);
  });
});

// ── AC2: diff-derived file that cannot be read (dangling symlink) ──────────
// A symlink COMMITTED pointing at a nonexistent target reproduces "cannot be
// read" deterministically and without dirtying the working tree: git tracks
// the symlink's target STRING as its blob content (it never validates the
// target resolves), so the commit itself is exactly what's on disk — no
// working-tree modification, isDirty() stays false — while readFileSafe()
// genuinely hits ENOENT resolving it, precisely like a file deleted between
// diff computation and mutation.

describe('CLI: diff-derived file cannot be read', { skip: process.platform === 'win32' ? 'POSIX symlinks' : false }, () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-diffunreadable-'));
    initRepo(dir);
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src', 'real.mjs'), [
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'test', 'real.test.mjs'), [
      "import { describe, it } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/real.mjs';",
      "describe('add', () => {",
      "  it('sums', () => { assert.strictEqual(add(2, 3), 5); });",
      '});',
      '',
    ].join('\n'));
    commitAll(dir, 'init');

    // Second commit ADDS a symlink at src/broken.mjs pointing at a target
    // that never exists — a genuine, valid, committable git object; the
    // working tree is clean at HEAD, nothing to stash or commit.
    symlinkSync('./does-not-exist.mjs', join(dir, 'src', 'broken.mjs'));
    commitAll(dir, 'add dangling symlink broken.mjs');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 1, distinguishing "could not be read" from "no mutable line"', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1'],
      dir
    );
    assert.equal(result.status, 1,
      `Expected exit 1 (unreadable diff-derived target), got ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /refusing to report a pass/,
      `Expected 'refusing to report a pass' in stderr, got: ${result.stderr}`);
    assert.match(result.stderr, /broken\.mjs/,
      `Expected the offending file named in stderr, got: ${result.stderr}`);
    assert.match(result.stderr, /could not be read/,
      `Expected the unreadable reason (distinct from 'no mutable line'), got: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /no mutable line was found/,
      `Unreadable file must not be reported as "no mutable line" — distinct reasons, got: ${result.stderr}`);
  });
});

// ── AC3 (regression): explicit --target zero-mutants behaviour unchanged ───

describe('CLI: explicit --target zero-mutants message is unchanged', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-explicitzero-'));
    initRepo(dir);
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src', 'silent.mjs'), ZERO_MUTANT_FUNCTION);
    writeFileSync(join(dir, 'test', 'placeholder.test.mjs'), [
      "import { describe, it } from 'node:test';",
      "describe('placeholder', () => { it('runs', () => {}); });",
      '',
    ].join('\n'));
    commitAll(dir, 'init');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('still exits 1 with the explicit-target message shape (opError, "refusing to report a pass")', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--target', 'src/silent.mjs'],
      dir
    );
    assert.equal(result.status, 1,
      `Expected exit 1 (explicit target, zero mutants), got ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
    assert.match(result.stderr, /explicit --target\/--rails file\(s\) produced zero mutants/,
      `Expected the UNCHANGED explicit-target message, got: ${result.stderr}`);
  });
});

// ── AC4 (regression): mixed diff — some files mutated, one starved ─────────
// Out of scope per #657 (--max budget starvation): a diff where SOME files
// produced mutants and OTHERS did not must still exit 0/2 normally, not
// newly fail closed just because one individual diff file was starved.

describe('CLI: mixed diff (one file with mutants, one with none) still exits normally', () => {
  let dir;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'hollow-mixeddiff-'));
    initRepo(dir);
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'test'));
    writeFileSync(join(dir, 'src', 'a.mjs'), [
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'src', 'b.mjs'), ZERO_MUTANT_FUNCTION);
    writeFileSync(join(dir, 'test', 'a.test.mjs'), [
      "import { describe, it } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add } from '../src/a.mjs';",
      "describe('add', () => {",
      "  it('sums', () => { assert.strictEqual(add(2, 3), 5); });",
      '});',
      '',
    ].join('\n'));
    commitAll(dir, 'init');

    // Second (and only other) commit changes BOTH src/a.mjs (mutable,
    // well-tested) and src/b.mjs (zero-mutant body) in the SAME diff, so
    // `--base HEAD~1` sees both files changed at once.
    writeFileSync(join(dir, 'src', 'a.mjs'), [
      'export function add(a, b) {',
      '  return a + b;',
      '}',
      '',
      'export function mul(a, b) {',
      '  return a * b;',
      '}',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'test', 'a.test.mjs'), [
      "import { describe, it } from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { add, mul } from '../src/a.mjs';",
      "describe('add', () => {",
      "  it('sums', () => { assert.strictEqual(add(2, 3), 5); });",
      '});',
      "describe('mul', () => {",
      "  it('multiplies', () => { assert.strictEqual(mul(2, 3), 6); });",
      '});',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'src', 'b.mjs'), `// comment\n${ZERO_MUTANT_FUNCTION}`);
    commitAll(dir, 'add mul(), touch b.mjs comment');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 0 — a.mjs contributed real, all-killed mutants; b.mjs starvation is issue #657, out of scope here', () => {
    const result = runCli(
      ['--test-cmd', 'node --test test/*.test.mjs', '--base', 'HEAD~1'],
      dir
    );
    assert.equal(result.status, 0,
      `Expected exit 0 (mixed diff, real file has all-killed mutants), got ${result.status}\n` +
      `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  });
});
