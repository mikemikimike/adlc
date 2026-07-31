# Windows compatibility — learnings from the abandoned `windows-compat` branch

**Status:** seed document for a dedicated Windows-compatibility effort.
**Provenance:** PR #405 (`windows-compat`, issue #352) was abandoned after 14 rounds
of cross-model adversarial review plus a P5 prosecution. The branch is not worth
rebasing — it accumulated too much unrelated hardening and diverged from `main`
repeatedly. What it *produced* is worth keeping, and that is what this file is.

Related: issue #421 (the repo-wide spawn-safety sweep).

---

## 1. Why the branch failed, honestly

Not because Windows support is hard. Because the work had no boundary.

It began as "make the suites green on win32". Fixing that surfaced a real
security class (below), fixing *that* surfaced more of the same class, and each
round of fixes introduced new defects that the next round found. Fourteen review
rounds, and the review was still finding real problems in the *fixes* at roughly
the rate it found them in the original code.

Two structural mistakes are worth naming so the next attempt avoids them:

1. **Security hardening was done inside a compatibility PR.** The moment
   `agy.cmd` turned out to be a command-hijack, that should have become its own
   ticket. Instead it grew inside #405 until the diff was 139 files and the
   original subject was a minority of the change.
2. **Fixes were verified by reading, not by breaking.** Every defect that
   survived into a later round was caught by *mutating production and watching a
   test go red* — never by review. See §5.

---

## 2. The actual Windows incompatibilities (technical inventory)

These are real and independently verified. Each is a candidate ticket.

### 2.1 `CreateProcess` cannot execute a `.mjs` file

Windows has no shebang handling. A command ending in `.mjs` must be spawned as
`node <script>.mjs`. Affects any injected `adlcBin` / worker command.

*Seen in:* `packages/fleet/lib/spawn-async.mjs` (`isWinMjsCommand`), and its call
sites in `gates.mjs` (`defaultExec`) and `live-deps.mjs` (`defaultIo().adlc`).

### 2.2 `git show REV:path` fails on long paths

git-for-windows stats the combined `REV:path` string as a filesystem path and
fails with "Filename too long" for ULID-length ticket shards, even though the
blob exists. Use `git cat-file -p <oid>` against the object id instead.

*Seen in:* `packages/tickets/lib/stores/git-tree.mjs`.

### 2.3 Shell globs are not expanded

`node --test dir/*.test.mjs` relies on the POSIX shell to expand the glob.
cmd.exe does not, so the literal `*.test.mjs` reaches `node --test` and matches
nothing — **the suite reports success having run no tests**. Expand in-process.

*Seen in:* `scripts/run-tests.mjs`.

### 2.4 `process.env` keys are case-insensitive

`Path` and `PATH` are the *same* variable on Windows. Code that normalises by
assigning `PATH` and then deleting the variant **deletes the value it just
wrote**, leaving the process with no PATH at all. Read → delete → assign.

### 2.5 No execute bit; mode is by extension

`chmodSync(f, 0o755)` is a no-op on NTFS. A test asserting executability via
chmod asserts nothing there. Conversely, requiring `X_OK` when resolving a
binary would reject every legitimately installed `.cmd`/`.exe`.

### 2.6 Filesystem symlinks need privilege

`symlinkSync` throws `EPERM` without Developer Mode or
`SeCreateSymbolicLinkPrivilege`. This is why nine trust-root security tests were
skipped on win32 — see §3.2 for the fix.

### 2.7 A backslash is a legal POSIX filename character

Folding `\` → `/` unconditionally aliases two genuinely different POSIX files.
This is the single most-repeated defect on the branch; see §4.1.

---

## 3. Techniques that work (reuse these)

### 3.1 Resolve every command to an absolute path before spawning

**The rule:** no unqualified path component — *binary or interpreter* — reaches a
spawn without being proven absolute, and nothing crosses cmd.exe unquoted.

Why it matters: **cmd.exe resolves a bare command name against the current
directory before PATH**, and these tools run with `cwd` set to the repository
under analysis — attacker-controlled in exactly the scenarios they exist for
(reviewing an untrusted change, driving a gate over a fetched branch). A repo
that merely *contains* `agy.cmd` gets it executed.

The POSIX half is quieter but real: an **empty component** in `PATH`
(`PATH=/usr/bin:`, or a leading/doubled `:`) means "current directory" to
`execvp`.

The branch built `packages/core/lib/spawn-safe.mjs` for this. It is the single
most salvageable artifact — see §6. Its surface:

| export | contract |
|---|---|
| `resolveOnPath(name, {env, platform, exists})` | absolute path from PATH only; skips empty **and relative** components; requires drive-qualified or UNC on win32; requires `X_OK` on POSIX; **returns `null`, never a bare name** |
| `winShell(env)` | always-absolute interpreter; `ComSpec` only if absolute, else `%SystemRoot%\System32\cmd.exe` |
| `winSystemExe(name, env)` | absolute path to a System32 tool (`where.exe` etc.) |
| `winCmdArgs(bin, args)` | `/d /s /c` line with every element quoted; pair with `windowsVerbatimArguments: true` |
| `hasCmdMetacharacters(v)` | the one denylist (`\r\n & | < > ^ % ;`) |
| `foldWinSeparators(v, platform)` | separator fold, **win32 only** |
| `normalizePathKey(env)` | collapse a case-variant PATH key, in the safe order |

**Known defect to fix before reuse:** `quoteWinCmdArg` escapes an embedded `"`
as `\"`, which is the CRT/`CommandLineToArgvW` convention. **cmd.exe does not
honour backslash escapes** — it toggles quote state on every `"`. So an argument
containing `"` ends the quoted region and the remainder is parsed unquoted, where
`& | < > ^ %` regain meaning. Either reject `"` outright (it cannot appear in a
Windows path) or apply the two-phase rule: CRT-escape for the target program,
then `^`-escape every cmd metacharacter *including* `"`. Add `"` to
`hasCmdMetacharacters` in the same change.

### 3.2 Build adversarial git objects through the index, not the filesystem

To test that a gate denies a committed symlink (mode `120000`) **without needing
symlink privilege**:

```js
const blob = execFileSync('git', ['hash-object', '-w', '--stdin'],
  { cwd: dir, input: linkTarget, encoding: 'utf8' }).trim();
execFileSync('git', ['update-index', '--add', '--cacheinfo', `120000,${blob},${path}`], { cwd: dir });
execFileSync('git', ['commit', '-qm', 'msg'], { cwd: dir });
```

The committed object is byte-identical to what `symlinkSync` + `git add` would
produce — `git show` returns the link target string — and it works on every
platform. Same trick with `100755` for the execute bit.

Verified: the staged entry reports mode `120000`, and `git show HEAD:<path>`
returns the whitespace target that defeats a content-only check.

**Two traps:**

1. **`git add -A` stages a DELETION** for a path with no file on disk, silently
   undoing an index-staged entry. Any test harness needs a hook that runs
   *after* the add and before the commit. Without it these become tests of
   nothing — the exact failure being fixed.
2. When the gate reads the **working tree** (not a commit), the index trick
   cannot express the fixture. Use a best-effort helper that returns a sentinel
   on `EPERM` instead of a blanket platform skip — **and make the caller honour
   the sentinel.** The branch shipped one whose caller compared the sentinel to
   an exit code, so it would have failed on precisely the unprivileged Windows
   host it was written for.

### 3.3 Make platform-conditional code testable off-platform

`process.platform`'s property descriptor is `configurable: true`:

```js
const original = Object.getOwnPropertyDescriptor(process, 'platform');
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
try { /* synchronous only — the override is process-global */ }
finally { Object.defineProperty(process, 'platform', original); }
```

**Better:** take `platform` as a parameter with `process.platform` as the
default. Mocking has a sharp edge — forcing `win32` also switches `path`
resolution to Windows semantics while the host filesystem and `PATH` remain
POSIX, so a *real* resolve can never succeed under the mock. Several tests on
the branch failed for exactly that reason and had to inject resolution instead.

Path helpers must follow the **platform argument**, not the host: use
`path.win32` / `path.posix` explicitly. `path.isAbsolute('C:\tools')` is `false`
on a Mac.

---

## 4. Defect classes to sweep for

### 4.1 Unconditional separator folding

`.replaceAll('\\', '/')` applied on every platform. Produced three distinct
defects:

- a **wrong-file write** in `consensus-fix` (evaluated one file, applied to another);
- a source file named `test\critical.mjs` classified as **test code**, so
  `mutation-gate` exited 0 reporting "nothing to mutate" — *a gate silently passing*;
- mis-attributed merge-forecast conflict signals.

Sweep: `grep -rn "replaceAll('\\\\\\\\', '/')" packages/*/lib scripts/`.
Known remaining at time of writing: `packages/core/lib/revision.mjs`.

### 4.2 Bare command + shell

Sweep for `spawn*`/`execFile*` where the first argument is an unqualified name
and any `shell:` value is set. `scripts/test/no-unresolved-shell-spawn.test.mjs`
on the branch does this mechanically, with a planted-offender self-test so it
cannot rot to a permanent green.

**Its documented blind spot:** the detector reads the first argument *literally*,
so `const cmd = isWin ? 'npx.cmd' : 'npx'; spawn(cmd, …, {shell})` is invisible
to it. Closing that needs an AST pass — `acorn` is already a devDependency.

### 4.3 Security tests disabled by platform

`{ skip: process.platform === 'win32' }` on a test that protects a trust
boundary means the gate reports **green without running** on that platform. Nine
such tests existed. Use §3.2 instead. Only skip for a genuine capability gap
(e.g. NTFS has no execute bit) — and say so in the skip reason.

---

## 5. Process rules (the expensive lessons)

These cost the most and generalise beyond Windows.

### 5.1 Verify a fix by mutating production, never the test

Four times on this branch a test was written that did not bind to the code it
claimed to protect:

- `winShell({}) === 'cmd.exe'` — **pinned the vulnerable fallback as correct**;
- `resolveTargetPath` asserted to resolve to the **wrong file**, justified as "deterministic";
- a test that **copied production's statements into itself**, so reverting production left it green;
- a module that **imported** a shared helper while still using a local copy, detaching it from the shared tests.

Two of these were "verified" by mutating the *test's own copy*, which proves
nothing. **The only check that works: change the production line, confirm a test
goes red, change it back.**

Watch for the tell: a test asserting *determinism* or *current behaviour* rather
than *required behaviour*. Determinism is not correctness — the deterministic
answer being locked in was the unsafe one, twice.

### 5.2 Prove a "pre-existing" claim before exempting anything

The branch's worst outcome: it **introduced** a command-hijack in the npm publish
path, then exempted it from its own regression guard as "pre-existing on main",
and the guard's staleness check certified that exemption as legitimate. The claim
was false and checkable in one command:

```sh
git show origin/main:scripts/release.mjs | grep "execFileSync('npm'"
```

`main` had no `shell` option at all. A gate that exempts the defect its own
change introduced is **weaker than no gate** — it converts a new hole into a
documented, test-asserted allowance. The same false claim reached a public issue.

Any exemption list needs (a) a staleness check that the entry still carries the
pattern, and (b) a recorded `git show origin/main:<file>` proving provenance.

### 5.3 One rule, one definition

The cmd-metacharacter class was written out **four** times; the separator fold
**four** times. Each copy needed its own test to prove completeness, and the
copies drifted (one denylist was missing `;`). A copy also silently detaches a
module from the shared tests. Consolidate first, then test once.

### 5.4 Fan-out review finds what diff-review cannot

Fourteen rounds of diff review missed the false-exemption entirely. A P5
prosecution security lens found it immediately — by running
`git show origin/main`, a step no amount of reading the diff would produce.
Prefer a lens that *checks the claim* over a reviewer that *evaluates the
reasoning*.

---

## 6. What to salvage from the branch

The branch (`windows-compat`, final SHA `9bd8117`) is not worth rebasing, but
these are worth lifting essentially as-is, each as its own small PR:

| Artifact | Notes |
|---|---|
| `packages/core/lib/spawn-safe.mjs` + its tests | highest value; **fix `quoteWinCmdArg` first** (§3.1) |
| `scripts/test/no-unresolved-shell-spawn.test.mjs` | the mechanical guard, with self-test and staleness check |
| `packages/rails-guard/test/helpers/git-fixtures.mjs` | index-staged fixtures; **make callers honour the sentinel** |
| `scripts/run-tests.mjs` glob expansion + its test | the original #352 fix; unblocks `mutation-gate`'s fast path |
| `packages/tickets/lib/stores/git-tree.mjs` `cat-file` change | small, self-contained |
| `packages/fleet/lib/spawn-async.mjs` `isWinMjsCommand` + call sites | small, self-contained |

**Do not lift** the lockfile changes (they promote 12 `@tailwindcss/oxide`
platform packages out of `dev` with no `package.json` justification — likely
churn from a different npm version) or the manifest entries (they attest a
revision 19 commits stale).

---

## 7. Suggested sequencing

1. **`spawn-safe.mjs` alone**, with the `quoteWinCmdArg` fix and full tests. No
   call-site changes. Small, reviewable, and everything else depends on it.
2. **The regression guard**, with an empty exemption list. Landing it *before*
   the call-site migrations means each subsequent PR is checked by it.
3. **One PR per call site**, migrating to the shared helpers. Each is small
   enough to review properly and to revert independently.
4. **The plain compatibility fixes** (§2.1–2.3) — independent of the security
   work, and individually tiny.
5. **The Windows test un-skips** (§3.2), once `git-fixtures.mjs` has landed.
6. **The separator-fold sweep** (§4.1) with a mechanical guard, mirroring step 2.

Keep security hardening and compatibility in **separate tickets**. Conflating
them is what made #405 unreviewable.

---

## 8. Verification checklist for any PR in this effort

- [ ] Every fix: production line mutated, a test went red, line restored (§5.1)
- [ ] No test asserts determinism or current behaviour in place of required behaviour
- [ ] Any "pre-existing" claim backed by recorded `git show origin/main:<file>` output (§5.2)
- [ ] No new copy of a rule that already exists somewhere (§5.3)
- [ ] Platform-conditional code takes `platform` as a parameter, and both branches are exercised
- [ ] No security test disabled by platform without a stated capability gap (§4.3)
- [ ] `node scripts/run-tests.mjs` green, and CI actually **ran** (an unmergeable PR builds no merge commit, so no workflow triggers at all — check, do not assume)
