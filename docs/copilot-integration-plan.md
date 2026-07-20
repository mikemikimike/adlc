# Plan: Installing & Integrating ADLC into GitHub Copilot

> Analysis of a 7th native integration (`plugins/adlc-copilot`), companion to
> [claude-code.md](./integrations/claude-code.md), [codex.md](./integrations/codex.md),
> [cursor.md](./integrations/cursor.md), [antigravity.md](./integrations/antigravity.md),
> [opencode.md](./integrations/opencode.md), and [pi.md](./integrations/pi.md).
> Written 2026-07-20 against the July-2026 Copilot documentation surface.
> Status: **analysis / pre-ticket** — no code exists yet.
> Side-by-side comparison of all seven harnesses:
> [`integrations/harness-capability-matrix.md`](./integrations/harness-capability-matrix.md).

## 1. Verdict up front

GitHub Copilot is now **top-tier integrable** — the Copilot CLI ships a
near-superset of Claude Code's extension surface and is deliberately
cross-compatible with it (it reads `.claude/skills`, `CLAUDE.md`, and even
`.claude/settings.json` hooks). Every primitive the ADLC contract needs exists
natively:

| ADLC primitive | Copilot CLI surface | Tier |
| --- | --- | --- |
| Rails-guard (deny a frozen-rail edit) | `preToolUse` hook — **deterministic deny** via exit 2 or stdout `{"permissionDecision":"deny"}`; non-zero exit **fails closed** | **Stronger than agy/Cursor** (both fail open) |
| Plugin distribution | Native `plugin.json` bundling `agents/`, `skills/`, `commands/`, `hooks`, `mcpServers`; marketplace = repo with `.github/plugin/marketplace.json` (`copilot plugin marketplace add OWNER/REPO`, then `copilot plugin install NAME@MARKETPLACE`). Docs state the format is **shared between VS Code, Copilot CLI, and Claude Code** | Same shape as Codex/Claude Code — possibly the *same artifact* |
| Phase-router + commands | Agent Skills (Anthropic-open-standard `SKILL.md`, user-invocable as `/` commands) | Skills drop in **unchanged** |
| P5 prosecutor subagents | Custom agents (`*.agent.md`, `tools:` allowlist) run in isolated subagent contexts; VS Code `agents:` frontmatter spawns subagents | Verify fan-out (see §6) |
| MCP (`adlc_gate`/`adlc_prosecute`) | `.mcp.json` in plugin / `~/.copilot/mcp-config.json` | Ships as-is |
| Headless fleet worker | `copilot -p` + `--allow-tool`/`--deny-tool`/`--agent` | Easy adapter; no JSON output mode |
| Commit-time guarantee | `rails-guard-ci.mjs` required check | **Already GitHub-native — covers the cloud coding agent too** |

Two structural facts make this integration *cheaper* than agy or Cursor were:

1. **The hook contract is Claude-Code-shaped.** Hook stdin is
   `{tool_name, tool_input, tool_use_id}` (verified for VS Code hooks), the deny
   schema is `permissionDecision`, and exit 2 denies — the existing
   `@adlc/core` rails engine and the adlc-claude-code hook adapters port with
   thin field-mapping, not a rewrite.
2. **The unbypassable layer needs zero new *code*, but does need the same
   verification every sibling doc already flags.** ADLC's real control is the
   CI diff gate on GitHub — and Copilot's async cloud coding agent can *only*
   act through PRs from `copilot/*` branches, treated as an outside
   contributor, subject to branch protection and required checks. Our existing
   `docs/ci/rails-guard.yml` gate therefore *can* govern the one Copilot
   surface that has **no hooks at all** — but only once it is actually
   configured as a **required** status check. `ci.yml` itself notes there is
   no automated check that `rails-guard` was added as a required check, and on
   a **private repo on GitHub's free plan it cannot be made blocking at all**
   (see [`rails-guard-private-repo-fallback.md`](./ci/rails-guard-private-repo-fallback.md))
   — a maintainer or admin-merge can go straight past a red run. Same caveat,
   same fallback (fold the rail-freeze step into an already-required job), as
   every sibling integration doc.

## 2. The three Copilot surfaces (and how much ADLC each gets)

### 2.1 Copilot CLI (`copilot`) — full native integration (the target)

Everything in the contract lands here:

- **Hooks** (14 events): `preToolUse` (rails-guard + build-gate),
  `sessionStart` (preflight + ticket-context), `preCompact`,
  `subagentStart`/`subagentStop` (ticket-context re-injection),
  `postToolUse` (flail-detection), `agentStop` (gate-manifest audit +
  adversarial-review trigger). Config: JSON `{"version":1,"hooks":{...}}` in
  the plugin's `hooks.json`, repo `.github/hooks/*.json`, or user
  `~/.copilot/hooks/`.
- **Deny contract** (better than agy's): exit code 2 = deny (overrides
  stdout); any other non-zero = **fail-closed deny**; stdout JSON
  `{"permissionDecision":"deny","permissionDecisionReason":"..."}`.
  ⚠️ The one fail-open path is **timeout** — the rails decision is a local
  JSON read (fast), so set a generous `timeoutSec` and keep the hook
  dependency-free, same zero-dependency guarantee as the CC plugin hooks.
- **Skills**: the `adlc` phase-router, `adlc-init`, `adlc-ticket`,
  `adlc-prosecute`, `adlc-distill`, `adlc-maintain` ship as `SKILL.md` skills.
  Copilot CLI has no standalone `.prompt.md` slash commands, but the **plugin
  manifest has a `commands` component key** (CLI plugin reference), so
  plugin-bundled commands may work natively — probe the expected command-file
  format (§6). Fallback if not: skills are user-invocable as `/` commands, so
  "commands become skills" (the same collapse the agy integration made, in the
  other direction).
- **Custom agents**: the six prosecution lenses
  (`adlc-prosecutor-{correctness,security,contract,diff,tests,verifier}`) as
  `agents/*.agent.md` with read-only `tools:` allowlists.
- **MCP**: the plugin's `.mcp.json` launches `adlc mcp-server` exposing
  `adlc_gate`/`adlc_prosecute`, identical to Codex/CC.
- **Install**: `copilot plugin marketplace add voodootikigod/adlc` +
  `copilot plugin install adlc-copilot@adlc` (native; the marketplace is a
  `.github/plugin/marketplace.json` in this repo — a third marketplace manifest
  alongside `.claude-plugin/` and `.cursor-plugin/`). Direct local-path and
  Git-URL installs also work (installed under
  `~/.copilot/installed-plugins/<marketplace>/<name>` or `…/_direct/<source>/`).
  Alternatively `npx plugins add voodootikigod/adlc` — the vendor-neutral
  `plugins` installer (≥1.3.4) supports Copilot CLI as a target.
- **Portability**: `${PLUGIN_ROOT}` is the documented token for referencing
  paths inside the plugin dir (Copilot format); VS Code additionally expands
  `${CLAUDE_PLUGIN_ROOT}` for Claude-format plugins. No agy-style `$HOME`
  workaround needed.

### 2.2 VS Code Copilot agent mode — same repo files, Preview hooks

VS Code reads the same `.github/hooks/*.json`, `.github/agents/*.agent.md`,
`.github/skills/`, and `.github/copilot-instructions.md`, and its `PreToolUse`
hook deny (`hookSpecificOutput.permissionDecision: "deny"`) is documented as
deterministic. Two caveats keep this a **secondary** surface:

- VS Code hooks are **Preview** ("format and behavior might change") — fine to
  ship files that light up there, wrong to make it the enforcement story.
- IDE-side governance is local settings, not GitHub org policy.

Design consequence: put the repo-facing artifacts (`.github/hooks`, agents,
skills, instructions) in what `adlc init --harness copilot` scaffolds, so one
scaffold serves both CLI and VS Code, and treat VS Code as advisory-plus until
hooks GA.

### 2.3 Copilot coding agent (cloud, issue→PR) — CI-gate-only by design

The concept docs say the cloud agent consumes plugins, but hook *execution*
there is unverified (documented runtimes are CLI + VS Code only — probe §6.9).
Plan on no in-session layer; none is needed for the rails guarantee:

- The agent pushes only to `copilot/*` and opens PRs as an outside
  contributor → the **required `rails-guard` check + branch protection is the
  entire enforcement story** — provided the check is actually made required
  (verify, don't assume; see the private/free-plan caveat in §1).
- Advisory lifecycle presence via `.github/copilot-instructions.md` /
  `AGENTS.md` (phase-router summary, "run `adlc` gates before opening the PR")
  and the same `.github/agents` + skills.
- `copilot-setup-steps.yml` can preinstall `@adlc/cli` so the agent can
  actually run gates — but note a failed setup step does **not** stop the
  agent (not a gate).
- P5: prosecute the agent's PR from the *outside* (a maintainer runs
  `/adlc-prosecute` on the branch, or a future CI prosecution job) — same
  posture as any human contributor's PR.

## 3. Primitive mapping (ADLC phases → Copilot)

| Phase | Copilot CLI surface | Mechanism |
| --- | --- | --- |
| P0 Triage | `adlc-ticket` skill | `.adlc/tickets.json` via `adlc` CLI |
| P1 Interrogate | `adlc` router skill → `spec-lint`/`premortem`/`parallax` | `--prompt-only` (Copilot is the model — no API keys) |
| P2 Decompose | `coldstart`/`model-router`/`merge-forecast` | `adlc` CLI |
| **P3 Rail** | **`preToolUse` hook (deny)** + CI diff gate | `@adlc/core` rails engine; fail-closed on hook error |
| P4 Build | `postToolUse` flail hook; build-gate in `preToolUse` | same dispatcher-order rule as Cursor: rails decision first, build-gate second |
| P5 Prosecute | `adlc-prosecute` skill + six lens agents | fan-out if CLI subagent invocation supports it (§6 probe); else sequential-with-cross-model fallback (Cursor tier) |
| P6 Integrate | human gate | `adlc gate-manifest` evidence |
| P7 Distill | `adlc-distill` skill | `lesson-foundry`/`rejection-mining` |
| Maintenance | `adlc-maintain` skill + CI cron | unchanged |

Shared invariants carried over verbatim (engine is `@adlc/core`, not
re-implemented): active-ticket resolution (`ADLC_TICKET` vs
`.adlc/current-ticket.json`, conflict fails closed), `ADLC_P4_ENFORCEMENT=1`
phase scoping, trust-root rails, symlink resolution, Bash-not-gated-in-session
(CI catches it), rails-must-be-tracked-files.

## 4. What we build

### 4.0 Format decision: Copilot-format plugin vs reusing the Claude plugin

The docs state the plugin format is **shared between VS Code, Copilot CLI, and
Claude Code**, and VS Code auto-detects manifests at `.plugin/plugin.json`,
`plugin.json`, `.github/plugin/plugin.json`, and `.claude-plugin/plugin.json`.
That opens Option A: point Copilot at the existing `plugins/adlc-claude-code`
artifact and skip a 7th plugin entirely. Recommend **Option B — a thin native
`plugins/adlc-copilot`** anyway, because (a) hook *file layout* differs by
format (Copilot: root `hooks.json`; Claude: `hooks/hooks.json`) and event names
differ on the CLI (camelCase, `agentStop`), (b) the CC plugin's hooks assume
Claude Code's stdin/stdout contract — close but unverified-identical on the
Copilot CLI, and (c) sibling integrations each own their verified-contract
appendix and smoke proofs. Share everything shareable (skills byte-identical,
lens-agent content, `@adlc/core` engine, MCP entry) and keep the adapter layer
per-harness — the established pattern. Revisit Option A if the live probe shows
the CC plugin loads and denies correctly as-is.

```
plugins/adlc-copilot/
├── plugin.json               # name, version, component pointers
├── hooks.json                # preToolUse/sessionStart/postToolUse/agentStop/…
├── hooks/                    # zero-dependency .mjs adapters over @adlc/core
│   ├── adlc-rails-guard.mjs  # stdin field-map → rails decision → permissionDecision/exit 2
│   └── …
├── skills/                   # adlc, adlc-init, adlc-ticket, adlc-prosecute, adlc-distill, adlc-maintain
├── agents/                   # adlc-prosecutor-*.agent.md (read-only tools:)
├── .mcp.json                 # adlc mcp-server → adlc_gate / adlc_prosecute
└── test/                     # contract tests incl. deny-shape + fail-closed pins
```

Plus repo ceremony (the standard 7th-integration checklist):

- `.github/plugin/marketplace.json` — the Copilot marketplace manifest for
  this repo (documented location), listing `adlc-copilot` →
  `./plugins/adlc-copilot`.
- `scripts/copilot-install-smoke.mjs` (offline manifest/hook/skill/agent/MCP
  contract) + a live-install leg gated behind `ADLC_COPILOT_LIVE_INSTALL=1`,
  mirroring `codex-install-smoke.mjs`, wired into `ci.yml`.
- `packages/fleet/lib/adapters/copilot.mjs` — `copilot -p <prompt>` +
  explicit `--allow-tool`/`--deny-tool` posture (no JSON output mode; text
  `mapResult` like the cursor adapter).
- `adlc init --harness copilot` — scaffold `.github/hooks/`, `.github/agents/`,
  `.github/skills/`, instructions block, `copilot-setup-steps.yml` snippet.
- `docs/integrations/copilot.md` + ADR + `docs/package-reference.md` entry.

Reuse estimate: the skills are byte-identical to the CC plugin's (open
standard); the lens agents are content-identical (format conversion
`.md`→`.agent.md` frontmatter); the MCP config is identical; the hooks are the
CC hook logic behind a new stdin/stdout adapter (~the same delta as
adlc-antigravity's). Net-new work is the adapter layer, the smoke/live proofs,
and the docs.

## 5. Where Copilot is *stronger* than the siblings

1. **Fail-closed hook errors.** A crashed rails-guard hook denies instead of
   letting the write through (agy fails open; Cursor's deny has open
   reliability reports). Only timeout fails open.
2. **Three-tier enterprise enforcement.** No other integrated harness offers
   any of these, let alone all three — worth a dedicated "enterprise rails"
   section in the integration doc:
   - **Machine policy tier**: `/etc/github-copilot/policy.d/*.json` hooks
     cannot be disabled by user settings (`disableAllHooks`).
   - **Enterprise-managed plugins** (public preview 2026-05-06): admins
     auto-install plugins on authentication, with hooks and MCP configs that
     are *"always enabled across your enterprise"* — i.e. the ADLC rails-guard
     pushed to every developer's CLI as a non-disableable PreToolUse deny.
   - **`strictKnownMarketplaces`** (public preview 2026-06-25, VS Code + CLI):
     enterprise allowlist of plugin marketplaces, so untrusted plugins can't
     be installed around the gate.
3. **Hook-free category deny.** `--deny-tool=shell` (deny beats allow, even
   under `--yolo`) gives fleet workers a deterministic no-shell posture — the
   first harness where the "Bash can't be gated" gap can be closed by
   *removing shell* rather than parsing it, for workers that don't need it.
4. **The cloud agent is pre-gated.** The one agent surface without hooks is
   also the one that can only merge through our existing CI gate.
5. **Cross-tool config reads.** Copilot CLI reading `.claude/skills` and
   `.claude/settings.json` means repos already carrying ADLC-for-Claude-Code
   get partial Copilot coverage before the native plugin is even installed.

## 6. Verify-before-build probes (the honesty gates)

Ordered; each mirrors the agy appendix-V ritual — probe a real binary, pin the
facts in the integration doc:

1. **Live deny-proof**: does exit 2 / `permissionDecision:"deny"` actually
   abort a file write in the current `copilot` release? Pin the stdin payload
   field names for edit/write/shell tools (matcher tokens seen in docs:
   `bash|edit`) and whether target paths are absolute.
2. **Headless hooks**: do hooks fire under `copilot -p`? (agy's did — V6 —
   and it's load-bearing for fleet.)
3. **MCP under `-p`**: open issue (#633) reports MCP servers don't run in
   non-interactive mode — decides whether fleet workers get `adlc_gate` or
   shell-only.
4. **Subagent fan-out**: can the main CLI session invoke the six lens agents
   as isolated subagents in one prosecution loop (P5 full independence), or is
   it user-driven `/agent` only (→ Cursor-tier sequential fallback +
   `npx adversarial-review --providers` cross-model gate)?
5. **Plugin-root expansion in hooks**: `${PLUGIN_ROOT}` is documented (and
   `${CLAUDE_PLUGIN_ROOT}` in VS Code for Claude-format plugins), but the CLI
   reference shows it for LSP config — confirm it expands inside `hooks`
   command strings specifically.
6. **Timeout behavior bound**: measure worst-case rails-decision latency in a
   large repo vs `timeoutSec` to size the fail-open window honestly.
7. **Marketplace resolution**: confirm `copilot plugin marketplace add`
   accepts this repo with `.github/plugin/marketplace.json` pointing at a
   monorepo subdir plugin, and that `copilot plugin update` tracks it.
8. **Plugin `commands` component format**: the CLI plugin manifest supports a
   `commands` key but standalone `.prompt.md` files are VS-Code-only — probe
   what command-file format plugin commands expect (Claude-style command
   `.md`?); fall back to skills if unusable.
9. **Cloud-agent plugin hooks**: docs say plugins work with "Copilot CLI and
   Copilot cloud agent," but hook *execution* is documented only for CLI +
   VS Code — verify whether a plugin `preToolUse` deny fires in the async
   coding agent before claiming any in-session layer there (until then, the
   cloud story remains CI-gate-only, which is sufficient).
10. **Claude-plugin drop-in**: try installing `plugins/adlc-claude-code`
    directly (VS Code auto-detects `.claude-plugin/plugin.json`; CLI direct
    install) — if its hooks load and deny, Option A in §4.0 gets cheaper.

## 7. Gaps to document honestly (relative to doctrine)

- **Cloud coding agent has no verified in-session rails layer** — it consumes
  plugins, but hook execution there is unconfirmed; treat it as CI-gate-only.
  Same first-time-rail scope limit as everywhere (a rail introduced and edited
  in the same PR isn't caught until frozen on base).
- **The CI-gate-only story for the cloud agent depends on `rails-guard` being
  a required check, which is neither automatically verified nor always
  possible.** `ci.yml` has no automated check that `rails-guard` was added as
  a required status check, and on a private repo on GitHub's free plan it
  cannot be made blocking at all (admin-merge can go straight past a red run)
  — identical to the caveat every sibling integration doc already carries.
  Verify branch protection explicitly in the Copilot install docs; don't let
  "already built" read as "already enforced."
- **Timeout fail-open** on CLI hooks (unlike non-zero exit) — small, but it's
  the one in-session escape hatch; document it next to the Bash gap.
- **No structured JSON output in `-p`** — fleet result parsing is text-tier.
- **VS Code hooks are Preview** — repo files light up there, but enforcement
  claims are CLI + CI only until GA.
- **Build-gate**: same no-CI-backstop caveat as all siblings
  (`.adlc/current-ticket.json` is untracked local state).

## 8. Phased delivery sketch

1. **Probe phase** (spike, no ship): the §6 list against a real `copilot`
   binary (items 1–5, 8, 10 first; 9 needs a repo with the cloud agent
   enabled); write the verified-contract appendix first, agy-style.
2. **Plugin core**: hooks adapter + skills + agents + MCP + offline smoke.
3. **Distribution**: marketplace entry, `plugins`-installer verification,
   `adlc init --harness copilot`, live-install smoke in CI.
4. **Fleet adapter + docs**: `copilot.mjs` adapter, `docs/integrations/copilot.md`,
   ADR, cloud-coding-agent guidance (`copilot-setup-steps.yml` + required-check
   posture).
5. **P5 hardening**: fan-out if probe 4 confirms; else sequential + cross-model
   review parity with Cursor, and revisit when the CLI grows programmatic
   subagent orchestration.
