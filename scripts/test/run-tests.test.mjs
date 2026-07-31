// scripts/test/run-tests.test.mjs — coverage for run-tests.mjs's own glob
// expansion (#352 windows-compat) AND its ambient trust-root env scrubbing
// (T-01KYQMPBEKCDCZ60FZKDC1WNF7, spec .adlc/specs/manifest-key-hermeticity.md
// Layer 1). Two independent features landed on this file in parallel and both
// need real, non-hollow coverage here.
//
// GLOB EXPANSION: Node's `node --test dir/*.test.mjs` glob is expanded by the
// SHELL on POSIX; cmd.exe on Windows never expands it, so a literal
// `*.test.mjs` argument reached node --test and matched nothing. This file
// exercises the fix — expandGlobTarget/runSegment resolving the glob
// themselves before spawning — directly, in-process.
//
// Same-basename convention (scripts/foo.mjs <-> scripts/test/foo.test.mjs):
// this is also what makes mutation-gate.mjs take run-tests.mjs down the FAST
// path instead of falling back to the full monorepo suite as its baseline —
// a fallback documented (in mutation-gate.mjs's own header) as unsafe in the
// mutation-gate CI job, which never provisions the codex/opencode/pi CLIs
// several full-suite segments need. Without this file, ANY PR that touches
// run-tests.mjs hits that mismatch.
//
// ENV SCRUBBING: an exported ADLC_MANIFEST_KEY flips key-present/key-absent
// branches deep in library code (measured 2026-07-29: gate-manifest + tickets
// segments 0/2 with the key exported, 2/2 without), and an exported
// RAILS_BASE retargets rails-guard tests at branches the scratch repos don't
// contain (75/80 bootstrap tests failed). The failure names a package, not a
// variable — so the runner deletes non-empty values of the sensitive set from
// every segment's env and says so once. Presence-vs-emptiness is load-bearing:
// an explicitly-empty ADLC_MANIFEST_KEY='' is a deliberate fail-closed that
// beats the .env.local file loader (packages/prosecute/lib/load-env-local.mjs
// rule 2). DELETING it would convert "never fall back to a file key" into
// absence and re-enable file fallback in spawned bins — so '' is PRESERVED,
// and only non-empty values are deleted.
//
// Fast and self-contained: no live CLI, no network, one throwaway temp dir
// (plus a handful of real subprocess runs of the runner itself for the
// scrub-notice/exit-code behavioral tests).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join, dirname, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

// NODE_TEST_CONTEXT must be gone from process.env BEFORE run-tests.mjs is
// imported: its SEGMENT_ENV is a one-time `{...process.env}` snapshot taken at
// module load, and runSegment's spawned children inherit it. This file itself
// runs under `node --test`, which sets that var — inherited by a nested
// `node --test` child, it trips Node's own recursive-invocation guard and
// makes the child silently report zero tests / exit 0, faking a pass no
// matter what the fixture actually asserts (the same failure mode
// hollow-test/lib/runner.mjs's childEnv() strips this for). Production
// run-tests.mjs never sees this: hollow-test's own runner already strips it
// before spawning `node scripts/run-tests.mjs` as the mutation-gate baseline.
delete process.env.NODE_TEST_CONTEXT;
const { expandGlobTarget, runSegment, buildSegmentEnv, SCRUBBED_ENV_VARS } = await import('../run-tests.mjs');

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function fixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-fixture-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

// -------------------------------------------------------------- expandGlobTarget

test('expandGlobTarget matches files against the glob and ignores the rest', () => {
  const dir = fixtureDir({
    'a.test.mjs': '',
    'b.test.mjs': '',
    'notes.md': '',
  });
  try {
    const found = expandGlobTarget(`${dir}/*.test.mjs`).sort();
    assert.deepEqual(found, [join(dir, 'a.test.mjs'), join(dir, 'b.test.mjs')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// REGRESSION GUARD: the pattern's literal dots must stay literal dots, not
// become "any character". A regex built from '*.test.mjs' without escaping
// the dots would also match e.g. 'aXtestXmjs' — silently sweeping in files
// the glob was never meant to select, and hiding real name-mismatch bugs.
test('expandGlobTarget escapes literal dots in the pattern (does not match any-char)', () => {
  const dir = fixtureDir({
    'a.test.mjs': '',
    'aXtestXmjs': '', // same length/shape as a.test.mjs but with dots swapped for X
  });
  try {
    const found = expandGlobTarget(`${dir}/*.test.mjs`);
    assert.deepEqual(found, [join(dir, 'a.test.mjs')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expandGlobTarget returns empty when the glob matches nothing', () => {
  const dir = fixtureDir({ 'notes.md': '' });
  try {
    assert.deepEqual(expandGlobTarget(`${dir}/*.test.mjs`), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expandGlobTarget returns empty when the glob\'s directory does not exist', () => {
  assert.deepEqual(expandGlobTarget('/does/not/exist/*.test.mjs'), []);
});

test('expandGlobTarget resolves a non-glob path that exists', () => {
  const dir = fixtureDir({ 'only.test.mjs': '' });
  try {
    assert.deepEqual(expandGlobTarget(join(dir, 'only.test.mjs')), [join(dir, 'only.test.mjs')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('expandGlobTarget returns empty for a non-glob path that does not exist', () => {
  assert.deepEqual(expandGlobTarget('/does/not/exist/only.test.mjs'), []);
});

// -------------------------------------------------------------- runSegment

test('runSegment runs matched glob targets through node --test and reports pass', () => {
  const dir = fixtureDir({
    'ok.test.mjs': "import test from 'node:test'; import assert from 'node:assert/strict'; test('ok', () => assert.ok(true));\n",
  });
  try {
    const result = runSegment(`node --test ${dir}/*.test.mjs`, process.env);
    assert.equal(result.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSegment propagates a failing test inside the glob as a non-zero status', () => {
  const dir = fixtureDir({
    'fail.test.mjs': "import test from 'node:test'; import assert from 'node:assert/strict'; test('fail', () => assert.ok(false));\n",
  });
  try {
    const result = runSegment(`node --test ${dir}/*.test.mjs`, process.env);
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSegment falls back to spawning a non-"node --test" command via the shell', () => {
  const result = runSegment('node -e "process.exit(0)"', process.env);
  assert.equal(result.status, 0);
  const failing = runSegment('node -e "process.exit(7)"', process.env);
  assert.equal(failing.status, 7);
});

test('runSegment runs a non-glob node --test target directly', () => {
  const dir = fixtureDir({
    'only.test.mjs': "import test from 'node:test'; import assert from 'node:assert/strict'; test('ok', () => assert.ok(true));\n",
  });
  try {
    const result = runSegment(`node --test ${join(dir, 'only.test.mjs')}`, process.env);
    assert.equal(result.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// -------------------------------------------------------------- buildSegmentEnv

test('the sensitive set is exactly the six ambient trust-root/override variables', () => {
  assert.deepEqual([...SCRUBBED_ENV_VARS].sort(), ['ADLC_BUILD_GATE_BYPASS', 'ADLC_GATE_MOCK_RESPONSE', 'ADLC_MANIFEST_KEY', 'ADLC_RAILS_BYPASS', 'BASE_REF', 'RAILS_BASE']);
});

test('non-empty sensitive values are ABSENT from the segment env and reported', () => {
  const { env, scrubbed } = buildSegmentEnv({
    HOME: '/h',
    ADLC_MANIFEST_KEY: 'leaked-key',
    RAILS_BASE: 'chore/somewhere',
    BASE_REF: 'main',
  });
  for (const name of SCRUBBED_ENV_VARS) {
    assert.equal(Object.hasOwn(env, name), false, `${name} must be deleted, not emptied`);
  }
  assert.deepEqual([...scrubbed].sort(), ['ADLC_MANIFEST_KEY', 'BASE_REF', 'RAILS_BASE']);
  assert.equal(env.HOME, '/h', 'unrelated vars pass through');
});

test("an explicitly-empty KEY is PRESERVED; empty OTHER variables are scrubbed", () => {
  // '' preservation is a key-specific contract (presence blocks the .env.local
  // loader). The rest have presence-checked consumers — ADLC_GATE_MOCK_RESPONSE=''
  // could still select a mock path — so present-but-empty is scrubbed for them.
  const { env, scrubbed } = buildSegmentEnv({ ADLC_MANIFEST_KEY: '', RAILS_BASE: '', ADLC_GATE_MOCK_RESPONSE: '' });
  assert.equal(env.ADLC_MANIFEST_KEY, '', "'' key must survive: it blocks .env.local fallback by PRESENCE");
  assert.equal(Object.hasOwn(env, 'RAILS_BASE'), false);
  assert.equal(Object.hasOwn(env, 'ADLC_GATE_MOCK_RESPONSE'), false, "an empty mock seam must not reach segments");
  assert.deepEqual([...scrubbed].sort(), ['ADLC_GATE_MOCK_RESPONSE', 'RAILS_BASE']);
});

test('unset variables stay absent and produce no notice', () => {
  const { env, scrubbed } = buildSegmentEnv({ HOME: '/h' });
  for (const name of SCRUBBED_ENV_VARS) assert.equal(Object.hasOwn(env, name), false);
  assert.deepEqual(scrubbed, []);
});

test('mixed input: a set key is scrubbed while an EMPTY key is the only preserved form', () => {
  const { env, scrubbed } = buildSegmentEnv({ ADLC_MANIFEST_KEY: 'k', RAILS_BASE: '' });
  assert.equal(Object.hasOwn(env, 'ADLC_MANIFEST_KEY'), false);
  assert.equal(Object.hasOwn(env, 'RAILS_BASE'), false, 'empty non-key variables are scrubbed too');
  assert.deepEqual([...scrubbed].sort(), ['ADLC_MANIFEST_KEY', 'RAILS_BASE']);
});

test('the runner PATH prepend is preserved by the helper', () => {
  const { env } = buildSegmentEnv({ PATH: '/usr/bin' });
  assert.ok(env.PATH.startsWith(join(REPO_ROOT, 'node_modules', '.bin') + delimiter),
    'node_modules/.bin must stay first on PATH (mutation-gate baseline runs the runner directly)');
});

// Behavioral, process-boundary: the notice appears exactly once when a non-empty key is
// exported, and never when the environment is clean. Uses the cheapest real segment.
// The assertion greps for the variable name plus the word "scrub" rather than pinning
// the full sentence — the notice is prose, and prose must stay reword-able.
function runRunner(extraEnv) {
  const env = { ...process.env, ...extraEnv };
  // Start from a clean slate for EVERY scrubbed variable — this test file itself may
  // be running under a deliberately leaked env (that is T1's whole premise). Case-fold
  // on win32 for the same reason buildSegmentEnv does: an ambient mixed-case spelling
  // would survive a canonical-only delete there and trip the no-notice assertion.
  const fold = process.platform === 'win32';
  for (const name of SCRUBBED_ENV_VARS) {
    for (const k of Object.keys(env)) {
      if (k === name || (fold && k.toUpperCase() === name)) delete env[k];
    }
  }
  Object.assign(env, extraEnv);
  return execFileSync(process.execPath, ['scripts/run-tests.mjs', 'generated-reader'], {
    cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env,
  });
}

test('spawned runner prints the scrub notice exactly once with a leaked key', () => {
  const out = runRunner({ ADLC_MANIFEST_KEY: 'leak-test' });
  const notices = out.split('\n').filter((l) => /ADLC_MANIFEST_KEY/.test(l) && /scrub/i.test(l));
  assert.equal(notices.length, 1, `expected exactly one notice line, got:\n${out}`);
});

test('spawned runner prints no notice when the environment is clean', () => {
  const out = runRunner({});
  assert.ok(!/scrub/i.test(out), `expected no scrub notice, got:\n${out}`);
});

test('an unknown segment filter is an OPERATIONAL error: exit 1, never the gate-fail code 2', () => {
  // Exit codes are load-bearing across ADLC: 1 = operational error, 2 = a gate
  // failed. A runner that exits 2 for a typo'd segment name would read as a real
  // test failure to any caller that distinguishes the two.
  let status = 0, stderr = '';
  try {
    execFileSync(process.execPath, ['scripts/run-tests.mjs', 'no-such-segment-xyz'], {
      cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) { status = err.status; stderr = String(err.stderr); }
  assert.equal(status, 1);
  assert.match(stderr, /no test segment matches/);
});

test('win32: differently-cased spellings are scrubbed too (env names are case-insensitive there)', () => {
  const { env, scrubbed } = buildSegmentEnv(
    { adlc_manifest_key: 'k', Rails_Base: 'b', BASE_REF: 'main', HOME: '/h' },
    { platform: 'win32' },
  );
  assert.equal(Object.hasOwn(env, 'adlc_manifest_key'), false);
  assert.equal(Object.hasOwn(env, 'Rails_Base'), false);
  assert.equal(Object.hasOwn(env, 'BASE_REF'), false);
  assert.deepEqual([...scrubbed].sort(), ['ADLC_MANIFEST_KEY', 'BASE_REF', 'RAILS_BASE'], 'reported names are canonical');
  assert.equal(env.HOME, '/h');
});

test('posix: a differently-cased spelling is a DIFFERENT variable and is preserved', () => {
  const { env, scrubbed } = buildSegmentEnv(
    { adlc_manifest_key: 'unrelated', ADLC_MANIFEST_KEY: 'k' },
    { platform: 'linux' },
  );
  assert.equal(env.adlc_manifest_key, 'unrelated', 'lowercase variant is untouched on POSIX');
  assert.equal(Object.hasOwn(env, 'ADLC_MANIFEST_KEY'), false);
  assert.deepEqual(scrubbed, ['ADLC_MANIFEST_KEY']);
});

test("win32: an explicitly-empty canonical value still blocks scrubbing of ITSELF but a non-empty variant is removed", () => {
  const { env, scrubbed } = buildSegmentEnv(
    { ADLC_MANIFEST_KEY: '', adlc_manifest_key: 'k' },
    { platform: 'win32' },
  );
  assert.equal(env.ADLC_MANIFEST_KEY, '', "explicit '' preserved");
  assert.equal(Object.hasOwn(env, 'adlc_manifest_key'), false, 'the non-empty variant is scrubbed');
  assert.deepEqual(scrubbed, ['ADLC_MANIFEST_KEY']);
});

test('gate-bypass and mock-seam variables are scrubbed like the key', () => {
  const { env, scrubbed } = buildSegmentEnv({
    ADLC_RAILS_BYPASS: '1',
    ADLC_BUILD_GATE_BYPASS: '1',
    ADLC_GATE_MOCK_RESPONSE: '{"verdict":"pass"}',
  });
  for (const name of ['ADLC_RAILS_BYPASS', 'ADLC_BUILD_GATE_BYPASS', 'ADLC_GATE_MOCK_RESPONSE']) {
    assert.equal(Object.hasOwn(env, name), false, `${name} must not reach test segments ambiently`);
  }
  assert.equal(scrubbed.length, 3);
});
