// spawn-safe.test.mjs — the repo-local command-hijack defense (#352 cross-model
// review findings F1/F2).
//
// The defect these guard against is not hypothetical: the windows-compat work
// spawned a BARE `agy.cmd` / `copilot.cmd` under `shell: true`, and cmd.exe
// resolves a bare name against the CURRENT DIRECTORY before PATH. Both call
// sites run with cwd set to the repository under analysis, so a repo that
// merely contained a file with that name would have it executed.
//
// Every assertion here drives the real functions with an injected `exists`
// probe and an explicit platform, so both the win32 and POSIX halves are
// exercised on any host.

import test from 'node:test';
import assert from 'node:assert/strict';
// POSIX flavour explicitly for the POSIX cases and win32 flavour for the win32
// ones, so the expectations are correct on any host (a Mac's `join` would build
// `C:\tools/agy.cmd`, which is not what Windows resolution produces).
import { posix, win32 } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
const { delimiter, join } = posix;

import { resolveOnPath, binCandidates, quoteWinCmdArg, winCmdArgs, winShell, winSystemExe, isRunnableFile, normalizePathKey, foldWinSeparators, hasCmdMetacharacters } from '../lib/spawn-safe.mjs';

/** An `exists` probe that answers true for exactly the given absolute paths. */
const existsIn = (...paths) => {
  const set = new Set(paths);
  return (p) => set.has(p);
};

// ---------------------------------------------------------------- resolveOnPath

test('resolveOnPath returns the absolute path of the first PATH hit', () => {
  const hit = join('/opt/bin', 'agy');
  const resolved = resolveOnPath('agy', {
    env: { PATH: ['/usr/bin', '/opt/bin'].join(delimiter) },
    platform: 'linux',
    exists: existsIn(hit),
  });
  assert.equal(resolved, hit);
});

test('resolveOnPath honours PATH ORDER (earlier directory wins)', () => {
  const first = join('/usr/bin', 'agy');
  const second = join('/opt/bin', 'agy');
  const resolved = resolveOnPath('agy', {
    env: { PATH: ['/usr/bin', '/opt/bin'].join(delimiter) },
    platform: 'linux',
    exists: existsIn(first, second),
  });
  assert.equal(resolved, first);
});

// THE HIJACK, POSIX HALF. An EMPTY component in PATH means "current directory"
// to a shell — `PATH=/usr/bin:` searches cwd. Joining it would resolve the
// attacker's file; skipping it is the whole point.
test('resolveOnPath SKIPS empty PATH components (an empty entry means cwd)', () => {
  const cwdPlant = join(process.cwd(), 'agy');
  for (const path of [`/usr/bin${delimiter}`, `${delimiter}/usr/bin`, `/usr/bin${delimiter}${delimiter}/opt/bin`]) {
    const resolved = resolveOnPath('agy', {
      env: { PATH: path },
      platform: 'linux',
      // ONLY the cwd plant exists — a resolver that honoured the empty
      // component would find it. Correct behaviour is to find nothing.
      exists: existsIn(cwdPlant),
    });
    assert.equal(resolved, null, `empty component in ${JSON.stringify(path)} must not resolve to cwd`);
  }
});

test('resolveOnPath SKIPS relative PATH components (also cwd-anchored)', () => {
  const relPlant = join('node_modules/.bin', 'agy');
  const resolved = resolveOnPath('agy', {
    env: { PATH: ['node_modules/.bin', '../elsewhere'].join(delimiter) },
    platform: 'linux',
    exists: existsIn(relPlant),
  });
  assert.equal(resolved, null);
});

test('resolveOnPath returns null when the command is absent — callers FAIL CLOSED', () => {
  const resolved = resolveOnPath('agy', {
    env: { PATH: '/usr/bin' },
    platform: 'linux',
    exists: () => false,
  });
  assert.equal(resolved, null, 'must be null, never the bare name');
});

test('resolveOnPath refuses a RELATIVE explicit path but accepts an absolute one', () => {
  const abs = '/opt/tools/agy';
  assert.equal(
    resolveOnPath(abs, { env: { PATH: '' }, platform: 'linux', exists: existsIn(abs) }),
    abs,
  );
  // `./agy` and `sub/agy` are cwd-anchored — the same reachability as a bare name.
  for (const rel of ['./agy', 'sub/agy', '..\\agy']) {
    assert.equal(
      resolveOnPath(rel, { env: { PATH: '/usr/bin' }, platform: 'linux', exists: () => true }),
      null,
      `${rel} is cwd-relative and must be refused`,
    );
  }
});

// The DEFAULT probe must reject a directory. `existsSync` answers true for one,
// so a directory named `agy.cmd` sitting earlier on PATH would be "resolved" and
// handed to spawn, shadowing the real executable further along — a denial of
// service at best, and on Windows a way to steer resolution at worst. Driven
// against the real filesystem because the point is the DEFAULT probe, which an
// injected boolean `exists` would bypass.
test('resolveOnPath skips a DIRECTORY and keeps searching for a real file', () => {
  const root = mkdtempSync(join(tmpdir(), 'spawn-safe-'));
  try {
    const shadowDir = join(root, 'first');
    const realDir = join(root, 'second');
    mkdirSync(join(shadowDir, 'agy'), { recursive: true }); // a DIRECTORY named `agy`
    mkdirSync(realDir, { recursive: true });
    const realBin = join(realDir, 'agy');
    // 0755: the probe requires an execute bit on POSIX, so a fixture without one
    // would be skipped and this test would pass for the wrong reason.
    writeFileSync(realBin, '#!/bin/sh\n', { mode: 0o755 });

    const resolved = resolveOnPath('agy', {
      env: { PATH: [shadowDir, realDir].join(delimiter) },
      platform: 'linux',
      // no `exists` override — exercising the production probe
    });
    assert.equal(resolved, realBin, 'the directory must not shadow the real executable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveOnPath returns null for an empty name', () => {
  assert.equal(resolveOnPath('', { env: { PATH: '/usr/bin' }, exists: () => true }), null);
  assert.equal(resolveOnPath(undefined, { env: { PATH: '/usr/bin' }, exists: () => true }), null);
});

test('resolveOnPath reads a case-variant PATH key on win32 (env names fold there)', () => {
  const hit = win32.join('C:\\tools', 'agy.cmd');
  const resolved = resolveOnPath('agy', {
    env: { Path: 'C:\\tools' },
    platform: 'win32',
    exists: existsIn(hit),
  });
  assert.equal(resolved, hit);
});

// A win32 PATH entry like `C:\tools` must be recognised as ABSOLUTE. Resolving
// with the host's path flavour on a POSIX machine classifies it as relative and
// skips it — which would make the resolver return null for every real Windows
// install and send callers down their fail-closed path in production.
test('resolveOnPath treats a drive-letter PATH entry as absolute on win32', () => {
  const hit = win32.join('C:\\tools', 'agy.cmd');
  assert.equal(
    resolveOnPath('agy', { env: { PATH: 'C:\\tools;C:\\other' }, platform: 'win32', exists: existsIn(hit) }),
    hit,
  );
});

test('resolveOnPath splits win32 PATH on ";" not ":" (a drive colon is not a separator)', () => {
  const hit = win32.join('C:\\second', 'agy.cmd');
  assert.equal(
    resolveOnPath('agy', { env: { PATH: 'C:\\first;C:\\second' }, platform: 'win32', exists: existsIn(hit) }),
    hit,
  );
});

// ---------------------------------------------------------------- binCandidates

test('binCandidates tries the batch shim before the executable on win32', () => {
  assert.deepEqual(binCandidates('agy', 'win32'), ['agy.cmd', 'agy.exe', 'agy.bat', 'agy']);
});

test('binCandidates leaves an explicit extension alone', () => {
  assert.deepEqual(binCandidates('agy.cmd', 'win32'), ['agy.cmd']);
});

test('binCandidates does not invent extensions off win32', () => {
  assert.deepEqual(binCandidates('agy', 'linux'), ['agy']);
  assert.deepEqual(binCandidates('agy', 'darwin'), ['agy']);
});

// ---------------------------------------------------------------- quoting

// THE OTHER HALF OF F2. Node's `shell: true` joins argv with spaces and no
// quoting, so an argument containing `>` reaches cmd.exe as a REDIRECTION —
// the deny prompt contains `>`, which silently became a file write.
test('quoteWinCmdArg keeps redirection and chaining metacharacters literal', () => {
  for (const meta of ['>', '<', '&', '|', '^']) {
    const quoted = quoteWinCmdArg(`prompt ${meta} tail`);
    assert.ok(quoted.startsWith('"') && quoted.endsWith('"'), `${meta} must be enclosed in quotes`);
    assert.ok(quoted.includes(meta), 'the character itself is preserved, not stripped');
  }
});

test('quoteWinCmdArg doubles % so cmd.exe cannot expand %VAR%', () => {
  assert.equal(quoteWinCmdArg('%PATH%'), '"%%PATH%%"');
});

test('quoteWinCmdArg escapes embedded double quotes', () => {
  assert.equal(quoteWinCmdArg('say "hi"'), '"say \\"hi\\""');
});

test('winCmdArgs builds a /d /s /c line with every element quoted', () => {
  const argv = winCmdArgs('C:\\tools\\agy.cmd', ['--print', 'a > b']);
  assert.deepEqual(argv.slice(0, 3), ['/d', '/s', '/c']);
  const line = argv[3];
  assert.ok(line.startsWith('"') && line.endsWith('"'), 'the whole line is wrapped for /s');
  assert.ok(line.includes('"C:\\tools\\agy.cmd"'), 'the binary is quoted');
  assert.ok(line.includes('"a > b"'), 'an argument containing > stays one quoted argument');
});

test('winShell prefers an ABSOLUTE ComSpec (either casing)', () => {
  assert.equal(winShell({ ComSpec: 'C:\\Windows\\System32\\cmd.exe' }), 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(winShell({ COMSPEC: 'C:\\alt\\cmd.exe' }), 'C:\\alt\\cmd.exe');
});

// THE INTERPRETER IS PART OF THE ATTACK SURFACE. Resolving the target binary to
// an absolute path accomplishes nothing if the SHELL used to launch it is itself
// an unqualified name: Windows searches the current directory before the system
// directories, so a checkout containing `cmd.exe` would supply the interpreter
// for every one of these invocations. An earlier version of this test asserted
// `winShell({}) === 'cmd.exe'` — it pinned the vulnerable fallback as correct,
// which is how a hollow test converts a hole into a guarantee.
// EVERY env-derived component must be checked, not just the first one. Round 4
// validated ComSpec and then joined SystemRoot unchecked, so `{SystemRoot: '.'}`
// still produced a relative `System32\cmd.exe` — the same cwd-resolved
// interpreter, reached by a different door. The relative/empty SystemRoot cases
// below are exactly the ones that omission left uncovered.
test('winShell NEVER returns a bare or relative interpreter', () => {
  const envs = [
    {},
    { ComSpec: 'cmd.exe' },
    { ComSpec: '.\\cmd.exe' },
    { COMSPEC: 'sub\\cmd.exe' },
    { SystemRoot: '.' },
    { SystemRoot: '' },
    { SystemRoot: 'relative\\win' },
    { ComSpec: 'cmd.exe', SystemRoot: '..' },
  ];
  for (const env of envs) {
    const shell = winShell(env);
    assert.ok(win32.isAbsolute(shell), `${JSON.stringify(env)} produced non-absolute ${shell}`);
    assert.notEqual(shell, 'cmd.exe');
  }
});

test('winShell falls back to %SystemRoot%\\System32\\cmd.exe when it is absolute', () => {
  assert.equal(winShell({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\cmd.exe');
  assert.equal(winShell({}), 'C:\\Windows\\System32\\cmd.exe');
  // A non-absolute SystemRoot is DISCARDED, not joined.
  assert.equal(winShell({ SystemRoot: '.' }), 'C:\\Windows\\System32\\cmd.exe');
});

test('winSystemExe resolves any system tool absolutely, discarding a relative root', () => {
  assert.equal(winSystemExe('where.exe', { SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\where.exe');
  assert.equal(winSystemExe('where.exe', {}), 'C:\\Windows\\System32\\where.exe');
  for (const root of ['.', '', 'rel\\path', '..']) {
    assert.ok(win32.isAbsolute(winSystemExe('where.exe', { SystemRoot: root })), `SystemRoot=${JSON.stringify(root)}`);
  }
});

// A regular file is not necessarily RUNNABLE on POSIX. A mode-0644 `agy` earlier
// on PATH would otherwise be resolved and then spawned, failing EACCES instead
// of falling through to the real 0755 one — the same shadowing the directory
// check closed, one permission bit over. Driven against the real filesystem
// because the production probe is the subject.
test('resolveOnPath skips a NON-EXECUTABLE regular file on POSIX', { skip: process.platform === 'win32' ? 'POSIX permission bits' : false }, () => {
  const root = mkdtempSync(join(tmpdir(), 'spawn-safe-mode-'));
  try {
    const firstDir = join(root, 'first');
    const secondDir = join(root, 'second');
    mkdirSync(firstDir, { recursive: true });
    mkdirSync(secondDir, { recursive: true });
    const notExec = join(firstDir, 'agy');
    const realExec = join(secondDir, 'agy');
    writeFileSync(notExec, '#!/bin/sh\n', { mode: 0o644 });
    writeFileSync(realExec, '#!/bin/sh\n', { mode: 0o755 });

    const resolved = resolveOnPath('agy', {
      env: { PATH: [firstDir, secondDir].join(delimiter) },
      platform: 'linux',
    });
    assert.equal(resolved, realExec, 'a non-executable file must not shadow the real binary');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Windows has no execute bit — selection is by EXTENSION. Requiring X_OK there
// would reject every legitimately installed `.cmd`/`.exe`.
test('the probe does not demand an execute bit on win32', () => {
  // Driven through isRunnableFile rather than resolveOnPath, because a POSIX
  // tmpdir path is DRIVE-RELATIVE under win32 rules and is (correctly) refused
  // by the fully-qualified check before the probe is ever consulted. The rule
  // under test is the permission one: Windows has no execute bit, so requiring
  // X_OK there would reject every legitimately installed .cmd/.exe.
  const root = mkdtempSync(join(tmpdir(), 'spawn-safe-win-'));
  try {
    const bin = join(root, 'agy.cmd');
    writeFileSync(bin, '@echo off\n', { mode: 0o644 }); // no +x, as on a real NTFS checkout
    assert.equal(isRunnableFile(bin, 'win32'), true, 'win32 selects by extension, not permission');
    assert.equal(isRunnableFile(bin, 'linux'), false, 'POSIX still requires the execute bit');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// `path.win32.isAbsolute('\\tools\\agy.cmd')` is true, but a single leading
// separator is DRIVE-RELATIVE on Windows — it inherits the process's current
// drive, which is precisely the cwd-dependence this module exists to remove.
test('resolveOnPath refuses a DRIVE-RELATIVE win32 path but accepts drive-qualified and UNC', () => {
  const opts = { env: { PATH: '' }, platform: 'win32', exists: () => true };
  assert.equal(resolveOnPath('\\tools\\agy.cmd', opts), null, 'single leading separator is drive-relative');
  assert.equal(resolveOnPath('C:\\tools\\agy.cmd', opts), 'C:\\tools\\agy.cmd');
  assert.equal(resolveOnPath('\\\\server\\share\\agy.cmd', opts), '\\\\server\\share\\agy.cmd', 'UNC is anchored');
});

test('winShell and winSystemExe reject a DRIVE-RELATIVE ComSpec/SystemRoot', () => {
  assert.equal(winShell({ ComSpec: '\\attacker\\cmd.exe' }), 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(winSystemExe('where.exe', { SystemRoot: '\\attacker' }), 'C:\\Windows\\System32\\where.exe');
  // A drive-qualified SystemRoot is still honoured.
  assert.equal(winSystemExe('where.exe', { SystemRoot: 'D:\\Windows' }), 'D:\\Windows\\System32\\where.exe');
});

// An install shipping only `copilot.exe` (or an extensionless shim) must not be
// reported missing. Pinning the default to `copilot.cmd` did exactly that,
// because an explicit extension is resolved verbatim rather than expanded.
test('binCandidates expands a BARE win32 name so .exe-only installs resolve', () => {
  const cands = binCandidates('copilot', 'win32');
  assert.ok(cands.includes('copilot.exe'), 'an .exe-only install must be reachable');
  assert.ok(cands.includes('copilot.cmd'));
  assert.ok(cands.includes('copilot'), 'an extensionless shim must be reachable');
});

// ---------------------------------------------------------------- normalizePathKey

// Windows env keys are CASE-INSENSITIVE, so `Path` and `PATH` are one variable.
// Assigning PATH and then deleting the variant therefore deletes what was just
// written, leaving the process with NO PATH — copilot-live-deny's version probe
// then reported an installed binary as missing.
//
// This drives the REAL exported function. The previous attempt copied the three
// statements into the test body, so reverting production to the broken order
// left it green — a test that asserts its own copy proves nothing.
const winEnv = (initial) => {
  const store = new Map(Object.entries(initial));
  const keyFor = (k) => [...store.keys()].find((s) => s.toUpperCase() === String(k).toUpperCase());
  return new Proxy({}, {
    get: (_t, k) => (typeof k === 'string' ? store.get(keyFor(k)) : undefined),
    set: (_t, k, v) => { const e = keyFor(k); if (e) store.delete(e); store.set(String(k), v); return true; },
    deleteProperty: (_t, k) => { const e = keyFor(k); if (e) store.delete(e); return true; },
    has: (_t, k) => keyFor(k) !== undefined,
    ownKeys: () => [...store.keys()],
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  });
};

test('normalizePathKey preserves the value when collapsing a case variant', () => {
  const env = winEnv({ Path: 'C:\\tools;C:\\Windows\\System32' });
  assert.equal(normalizePathKey(env), true, 'a variant was present');
  assert.equal(env.PATH, 'C:\\tools;C:\\Windows\\System32', 'PATH must survive — the probe depends on it');
});

test('normalizePathKey is a no-op when the key is already canonical', () => {
  const env = winEnv({ PATH: '/usr/bin' });
  assert.equal(normalizePathKey(env), false);
  assert.equal(env.PATH, '/usr/bin');
});

test('normalizePathKey leaves an env with no PATH alone', () => {
  const env = winEnv({ HOME: '/h' });
  assert.equal(normalizePathKey(env), false);
  assert.equal(env.HOME, '/h');
});

// ---------------------------------------------------------------- foldWinSeparators

// MUTATION-SENSITIVE BY CONSTRUCTION. Reverting any call site to an
// unconditional `.replaceAll('\\','/')` must fail a test, or the fix silently
// rots back — which is exactly what round 12 found: the round-11 folding fixes
// were correct but nothing bound them. These assertions fail the instant the
// platform guard is dropped.
test('foldWinSeparators does NOT fold on POSIX (a backslash is a real filename char)', () => {
  assert.equal(foldWinSeparators('test\\critical.mjs', 'linux'), 'test\\critical.mjs');
  assert.equal(foldWinSeparators('test\\critical.mjs', 'darwin'), 'test\\critical.mjs');
  assert.notEqual(
    foldWinSeparators('test\\critical.mjs', 'linux'),
    'test/critical.mjs',
    'folding here is what made a SOURCE file classify as a TEST, so mutation-gate reported nothing to mutate',
  );
});

test('foldWinSeparators DOES fold on win32, where the two spellings are one file', () => {
  assert.equal(foldWinSeparators('test\\critical.mjs', 'win32'), 'test/critical.mjs');
});

// EVERY character individually. A mutation that drops one from the class (the
// mutation operator turns `<>` into `>=>`) must fail a test — a survived mutant
// here means an operator-supplied path carrying that character reaches cmd.exe.
test('hasCmdMetacharacters flags each shell metacharacter on its own', () => {
  for (const ch of ['\r', '\n', '&', '|', '<', '>', '^', '%', ';']) {
    assert.equal(hasCmdMetacharacters(`C:\\tools\\copilot${ch}payload`), true,
      `${JSON.stringify(ch)} must be rejected`);
  }
});

test('hasCmdMetacharacters allows characters legal in a real path', () => {
  // Whitespace especially: `C:\Program Files\...` must stay usable.
  for (const ok of ['C:\\Program Files\\copilot.cmd', '/usr/local/bin/copilot', 'C:\\dir=1\\copilot']) {
    assert.equal(hasCmdMetacharacters(ok), false, `${ok} must be allowed`);
  }
});
