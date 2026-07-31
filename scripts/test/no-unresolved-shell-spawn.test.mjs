// no-unresolved-shell-spawn.test.mjs — the regression guard for the defect class
// that six consecutive cross-model review rounds kept finding at a NEW call site
// (#352 / #421).
//
// THE INVARIANT
//
//   No unqualified command name — BINARY or INTERPRETER — reaches a spawn under
//   `shell: true`, because Windows resolves an unqualified name against the
//   CURRENT DIRECTORY before PATH, and these tools run with cwd set to the
//   repository under analysis.
//
// WHY A GREP GATE RATHER THAN MORE UNIT TESTS. Each round was fixed with a real
// behavioural test, and the next round found the same class one call site over:
// llm.mjs, copilot-live-deny (x3, at three different branches), consensus-fix,
// skill-rot, preflight, ceremony-drift, rails-guard bootstrap. Per-site tests
// cannot catch the site nobody thought of — only an exhaustive sweep can, and
// only if it runs on every change.
//
// WHAT IT ALLOWS. `shell: true` itself is fine when what is being launched is
// already an absolute path or a resolved interpreter. The rule is specifically
// about pairing it with a BARE NAME. Deliberate exceptions are listed in
// KNOWN_PRE_EXISTING with their tracking issue, so the gate is honest about what
// it is not yet enforcing rather than silently skipping it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Sites still carrying the pattern, tracked in #421 and deliberately NOT fixed
 * in the windows-compat branch because they are pre-existing on main. Listed
 * explicitly so this gate reports the real remaining surface instead of an
 * unqualified pass.
 */
const KNOWN_PRE_EXISTING = new Set([
  'scripts/release.mjs',             // bare `npm` (publish credentials) — #421
]);

// KNOWN BLIND SPOT, stated rather than hidden. The detector reads the spawn's
// FIRST ARGUMENT literally, so a command assigned to a variable first —
// `const cmd = isWindows ? 'npx.cmd' : 'npx'; spawnFn(cmd, …, { shell })`, which
// is exactly what packages/cli/lib/dispatch.mjs does — is invisible to it.
// Listing that file as a known-offender would be worse than useless: the
// staleness check below would fail, and "fixing" that by loosening the check
// would blind it. Closing this properly needs an AST pass (acorn is already a
// devDependency); tracked in #421 alongside the sites themselves.

/** Files whose `shell: true` runs a COMMAND STRING, a different contract entirely. */
const COMMAND_STRING_RUNNERS = new Set([
  'packages/hollow-test/lib/runner.mjs', // executes the operator's --test-cmd
  'scripts/run-tests.mjs',               // executes a segment command line
  'scripts/mutation-gate.mjs',           // ditto, via hollow-test
]);

function trackedSourceFiles() {
  const out = execFileSync('git', ['ls-files', '*.mjs'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return out.split('\n').filter(Boolean).filter((f) => !f.includes('/test/') && !f.endsWith('.test.mjs'));
}

// A bare name: quoted string with no path separator and no interpolation. An
// absolute path, a `join(...)`/variable expression, or anything containing a
// separator is fine — those are the resolved forms.
const BARE_NAME = /^['"][A-Za-z0-9_.-]+['"]$/;

/** Spawn calls in `text` whose first argument is a bare quoted name. */
function bareNameSpawns(text) {
  const hits = [];
  const pattern = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*([^,)]+)/g;
  let m;
  while ((m = pattern.exec(text)) !== null) {
    const firstArg = m[1].trim();
    if (!BARE_NAME.test(firstArg)) continue;
    // Only the SAME call's options. A generous fixed window bleeds into the NEXT
    // call and inherits its `shell:` — that produced a false positive on a
    // `shell: false` site whose neighbour used a shell. Stop at the next spawn.
    const rest = text.slice(m.index + m[0].length);
    const nextCall = rest.search(/\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(/);
    const tail = rest.slice(0, nextCall === -1 ? 400 : Math.min(nextCall, 400));

    const shellOpt = /shell\s*:\s*([^,}\n]+)/.exec(tail);
    if (!shellOpt) continue;
    const value = shellOpt[1].trim();
    if (/^false\b/.test(value)) continue;
    // `shell: '/bin/sh'` names an ABSOLUTE interpreter — that is the resolved
    // form this gate is asking for, not a violation. Only an implicitly-selected
    // shell (`true`, or a flag that resolves to it) leaves cmd.exe unqualified.
    if (/^['"][^'"]*[/\\][^'"]*['"]$/.test(value)) continue;
    {
      hits.push({ call: firstArg, at: text.slice(0, m.index).split('\n').length });
    }
  }
  return hits;
}

test('no source file pairs `shell: true` with a bare command name', () => {
  const offenders = [];
  for (const file of trackedSourceFiles()) {
    if (KNOWN_PRE_EXISTING.has(file) || COMMAND_STRING_RUNNERS.has(file)) continue;
    let text;
    try {
      text = readFileSync(join(REPO_ROOT, file), 'utf8');
    } catch {
      continue; // deleted between ls-files and read
    }
    for (const hit of bareNameSpawns(text)) {
      offenders.push(`${file}:${hit.at} spawns ${hit.call} with a shell`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'Resolve the command to an absolute path first — packages/core/lib/spawn-safe.mjs provides\n' +
      'resolveOnPath() / winShell() / winSystemExe() / winCmdArgs(). See #421.\n' +
      `Offenders:\n  ${offenders.join('\n  ')}`,
  );
});

// SELF-TEST. A grep gate that silently stops matching is worse than none — it
// reports green forever. This proves the detector still fires on the exact shape
// it exists to catch, without needing a real offender in the tree.
test('the guard itself detects a planted bare-name shell spawn (self-test)', () => {
  const planted = `
    import { spawnSync } from 'node:child_process';
    spawnSync('gh.cmd', args, { encoding: 'utf8', shell: true });
  `;
  assert.equal(bareNameSpawns(planted).length, 1, 'detector must flag a bare name + shell:true');
});

test('the guard does NOT flag a resolved absolute path or a variable', () => {
  const resolved = `
    spawnSync(winShell(env), winCmdArgs(bin, args), { windowsVerbatimArguments: true });
    spawnSync(resolvedPath, args, { shell: true });
    spawnSync('C:\\\\Windows\\\\System32\\\\cmd.exe', args, { shell: true });
  `;
  assert.deepEqual(bareNameSpawns(resolved), [], 'resolved forms must not be flagged');
});

test('the guard does NOT flag a bare name spawned WITHOUT a shell', () => {
  // Without a shell there is no cmd.exe cwd-first lookup; Node resolves via
  // PATH only. That is a different (and much weaker) exposure, deliberately out
  // of this gate's scope.
  const noShell = `spawnSync('git', ['status'], { encoding: 'utf8' });`;
  assert.deepEqual(bareNameSpawns(noShell), []);
});

// The exception list must stay HONEST: an entry that no longer carries the
// pattern is stale and should be removed, or the list quietly grants permission
// nobody re-examines.
test('every KNOWN_PRE_EXISTING entry still actually carries the pattern', () => {
  for (const file of KNOWN_PRE_EXISTING) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    assert.ok(
      bareNameSpawns(text).length > 0,
      `${file} no longer pairs a bare name with a shell — remove it from KNOWN_PRE_EXISTING (#421)`,
    );
  }
});
