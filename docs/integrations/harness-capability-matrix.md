# ADLC capability × harness matrix

How each native integration implements the ADLC contract, side by side.
Compiled 2026-07-20 from the integration docs in this directory, the plugin
sources under `plugins/`, and (for Copilot) the July-2026 research in
[`../copilot-integration-plan.md`](../copilot-integration-plan.md).

**Columns:** CC = Claude Code · Codex · OC = OpenCode · Pi · Cursor · agy =
Antigravity · Copilot = **planned, pre-probe** (nothing shipped).

**Legend:** ✅ native/enforcing · ⚠️ partial, advisory, or unproven · ❌ absent
· 🧪 planned/unverified (Copilot column, and any claim pending a live probe).

Shared invariants are not repeated per row: every integration delegates
rail/glob/ticket/shell primitives to `@adlc/core` (nothing re-implemented),
resolves the active ticket via `ADLC_TICKET` / `.adlc/current-ticket.json`
(conflict fails closed), scopes enforcement to `ADLC_P4_ENFORCEMENT=1`,
freezes the trust-root files, resolves symlink aliases, and relies on the same
commit-time CI diff gate (`rails-guard-ci.mjs`) as the real control — with the
universal caveat that the CI gate only enforces if actually configured as a
**required** check (impossible on private free-plan repos; fold into an
existing required job instead).

## A. Distribution & install

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Native plugin install | ✅ marketplace | ✅ git marketplace | ⚠️ npm pkg registered in `opencode.json` by scaffolder (no marketplace) | ✅ `pi install npm:@adlc/pi` | ✅ marketplace (publish step pending) | ⚠️ local-path only (3rd-party marketplace rejected by CLI) | 🧪 `.github/plugin/marketplace.json` + `copilot plugin install` |
| `npx plugins add` universal-installer target | ✅ | ✅¹ | ❌ | ❌ | ✅ | ❌ (planned) | ✅ (target exists) |
| Install smoke script in CI | ✅ offline | ✅ offline + live | ✅ offline + live matrix | ✅ live + weekly version matrix | ✅ offline | ✅ offline | 🧪 |

¹ A `plugins`-installer Codex target exists, but the adlc docs recommend the native Codex marketplace path.

## B. In-session rail enforcement (P3/P4)

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Structured-edit deny (Write/Edit) | ✅ enforcing | ✅ enforcing | ✅ enforcing by default | ✅ enforcing | ⚠️ deny emitted; host reliability unproven (the GA gate) | ⚠️ advisory (host fails open) | 🧪 deny documented (exit 2 / `permissionDecision`); probe pending |
| Hook-crash failure mode | ⚠️ fail-open (only exit 2 blocks) | ⚠️ same convention² | ✅ fail-closed (throw aborts; unknown mutating tool denied) | ⚠️ n/d² | ⚠️ fail-open by config (`failClosed:false`) | ⚠️ fail-open (verified: non-zero exit ⇒ tool proceeds) | 🧪 fail-closed on non-zero; fail-open on **timeout** only |
| Shell (Bash) gating in-session | ❌ intentional (CI catches) | ✅ shell classifier (vendored core copy, sync-pinned) | ✅ classifier + chained-command splitting | ✅ codex-parity ladder | ⚠️ advisory string-match, never denies | ❌ | 🧪 probe; unique option: `--deny-tool=shell` removes shell entirely for fleet workers |
| Reactive write-restore backstop (tool-independent) | ❌ | ❌ | ✅ `file.edited` quarantine-restore | ✅ pre-tool snapshot restore (never `HEAD`) | ⚠️ `afterFileEdit` audit only, no restore | ❌ | ❌ (no equivalent event known) |
| Build-gate (context-rot backstop) | ✅ enforcing | ✅ hook shipped | ✅ + disables post-compaction autocontinue | ✅ | ⚠️ advisory, default-off | ❌ | 🧪 |

² CC's documented hook semantics: non-2 exit codes are non-blocking. Codex and Pi crash behavior is not pinned in this repo's docs — treat as unverified rather than assumed safe.

## C. Context defense

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ticket context re-injection | ✅ 5 events (SessionStart/PreCompact/PostCompact/Subagent*/Stop) | ✅ 8 events | ✅ per-turn system transform + rail names in tool descriptions | ✅ per-turn system-prompt append | ⚠️ `beforeSubmitPrompt` ships; narrower scope | ❌ (PreToolUse only) | 🧪 events exist (`sessionStart`, `preCompact`, `subagent*`) |
| Compaction survival defense | ✅ | ✅ | ✅ compaction-prompt append + autocontinue disable | ✅ | ❌ | ❌ | 🧪 `preCompact` exists |
| Flail detection | ✅ advisory | ✅ failure-signature recorder | ✅ advisory | ✅ | ✅ reminder | ❌ | 🧪 `postToolUse` exists |
| Live ticket statusline/footer | ❌ | ❌ | ✅ toast statusline | ✅ footer pill + verdict widget | ❌ | ❌ | ❌ |

## D. P5 prosecution

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 5-lens + verifier fresh-context fan-out | ✅ subagents | ✅ 6 agent TOMLs | ✅ isolated child sessions | ✅ child sessions (shared core lens roster) | ⚠️ sequential, one context (weakest independence) | ⚠️ single `prosecutor` agent, deterministic gates only | 🧪 custom agents exist; in-session fan-out is a probe |
| Deterministic first-party P5 runner (code loop, not prose) | ⚠️ model-driven command; helpers unit-tested | ⚠️ MCP `adlc_prosecute` workflow | ✅ native tool (most deterministic of the six) | ✅ native tool | ❌ | ❌ | 🧪 |
| Read-only enforcement on lenses | ✅ read-only tool lists | ✅ read-only TOMLs | ✅ wildcard-deny-first tools map | ✅ write-disabled children | ❌ | ⚠️ | 🧪 `tools:` allowlist exists |
| Formal `adlc run p5` provenance | ⚠️ CLI runner path, not wired e2e | ✅ authoritative fixture | ⚠️ runner path | ⚠️ runner path | ⚠️ runner path | ⚠️ runner path | 🧪 |
| P5 live proof in CI | ❌ | ⚠️ (install/hook/MCP live proof; not a deny/convergence proof) | ✅ seeded-defect convergence + write-disable, required | ✅ required (Node 22 leg) | ❌ | ❌ | 🧪 |

## E. Gate access

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Model-callable gate tool | ✅ MCP (`adlc_gate`/`adlc_prosecute`) | ✅ MCP | ✅ native plugin tool | ✅ native tool | ❌ commands only | ❌ skill/CLI only | 🧪 MCP planned (headless-MCP caveat: issue #633) |
| Keyless LLM-backed gates | ✅ `--prompt-only` | ✅ `--prompt-only` | ✅ live keyless child-session bridge | ✅ keyless via session model | ✅ `--prompt-only` | ✅ `--prompt-only` | 🧪 `--prompt-only` |
| Commands / phase suite | ✅ `/adlc:*` (5) | ✅ `$adlc*` skills (6) | ✅ `/adlc-*` full suite | ✅ `/adlc-*` + `/ticket` + accept/rollback | ✅ `/adlc-*` full suite | ⚠️ commands auto-convert to skills | 🧪 plugin `commands` key exists; format is a probe (fallback: skills as `/` commands) |

## F. Headless & fleet

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Fleet worker adapter | ✅ | ✅ | ✅ | ✅ | ✅ (`cursor-agent -p`) | ✅ | 🧪 `copilot -p` (text output only — no JSON mode) |
| Headless in-session enforcement verified | ❌ not exercised | ⚠️ hook execution proven from installed cache | ✅ headless live-deny in CI | ✅ `pi --mode rpc` live-deny in CI | ❌ | ✅ probed (`--print` blocked a rail write) | 🧪 docs silent on `-p` hooks — load-bearing probe |

## G. Governance

| Capability | CC | Codex | OC | Pi | Cursor | agy | Copilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Unbypassable commit-time CI gate | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (same gate; governs the cloud coding agent's PRs) |
| Admin/org-level in-session enforcement | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | 🧪 **unique**: machine `policy.d` hook tier + enterprise-managed plugins (always-on hooks) + `strictKnownMarketplaces` |

## Reading the matrix — tiers

1. **OpenCode & Pi — deepest deterministic enforcement.** Both gate shell
   in-session, carry a reactive restore backstop, run P5 as first-party code
   with write-disabled fresh contexts, and prove the deny live in required CI.
   OpenCode edges ahead on fail-closed posture (unknown mutating tools denied);
   Pi on TUI-native surface (footer pill, accept/rollback commands).
2. **Codex & Claude Code — full surface, weaker proofs.** Complete hook/agent/
   MCP coverage; Codex adds shell gating and the only formal `adlc run p5`
   fixture. CC's gaps: no shell gating (intentional), no live deny proof in CI,
   fail-open hook crashes.
3. **Cursor — surface parity, enforcement unproven.** Full command suite but
   the deny's host reliability is the open GA gate, P5 runs in one context,
   and the shell/audit hooks are advisory.
4. **Antigravity — advisory tier.** Fail-open host contract, single-lens P5,
   no build-gate or context defense; leans hardest on the CI gate (by design).
5. **Copilot (projected) — Codex/CC tier at launch, plus two firsts.** The
   documented deny contract is stronger than agy/Cursor's (fail-closed on
   crash), and it would be the only harness with admin-pushed, non-disableable
   enforcement and a hooks-free shell-removal option for fleet workers. All 🧪
   until the probe spike in the plan doc runs against a real binary.

## Maintenance note

Update this file when an integration ships a capability change (the same PR
that changes `plugins/<harness>/` or its integration doc), and re-verify the
Copilot column against the probe results before the build ticket closes.
