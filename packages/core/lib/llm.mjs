// LLM provider detection and completion. Zero dependencies, native fetch.
//
// Tiers: 'cheap' | 'mid' | 'frontier'. Defaults below are overridable:
//   ADLC_PROVIDER        force provider: anthropic | openai | gemini | agy
//   ADLC_MODEL_CHEAP     model id for the cheap tier
//   ADLC_MODEL_MID       model id for the mid tier
//   ADLC_MODEL_FRONTIER  model id for the frontier tier
//
// The 'agy' provider runs completions through the Antigravity CLI
// (`agy --print`) instead of an HTTP API — quota comes from the user's
// Antigravity plan, no API key. Opt-in: set ADLC_AGY=1 (or a path to the
// agy binary) or force with ADLC_PROVIDER=agy. Extra knobs:
//   ADLC_AGY_TIMEOUT   print-timeout passed to agy (default 300s)
//   ADLC_AGY_SANDBOX   set to 1 to pass --sandbox

import { spawn } from 'node:child_process';
import { resolveOnPath, winCmdArgs, winShell } from './spawn-safe.mjs';

// agy's timeout marker is its ENTIRE output on failure. Matching it as a
// bare substring would false-trip whenever a model quotes the phrase in a
// legitimate answer, so require it to be the only meaningful content (last
// non-empty line, output short). Exported for tests.
export function isAgyTimeout(out) {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  const last = lines.at(-1) ?? '';
  return /^Error: timed out waiting for response\.?$/.test(last) && out.length < 200;
}

// Env values that explicitly DISABLE a feature flag. 'false'/'0' are truthy
// strings in JS, so a plain existence check would enable on ADLC_AGY=false.
function envEnabled(v) {
  return v !== undefined && v !== '' && !['0', 'false', 'no', 'off', 'disabled'].includes(v.toLowerCase());
}

// cmd.exe (`&|<>^%`) plus POSIX shell command separators (`;`) — path
// overrides must be rejected on every platform, not only when shell:true.
const CMD_META = /[\r\n&|<>^%;]/;

function agySend({ apiKey, model, system, prompt }, env = process.env) {
  // apiKey carries the binary path ('1'/'true' mean the trusted default).
  const isDefault = apiKey === '1' || apiKey === 'true';
  // VALIDATE BEFORE RESOLVING. Every check below is a property of the CALLER'S
  // INPUT, so it must not be gated behind whether a binary happens to be
  // installed: putting resolution first made a machine without agy report
  // "not found" for an input that should have been refused outright, which both
  // hides the real fault and makes the refusal depend on the host.
  if (!isDefault && CMD_META.test(apiKey)) {
    return Promise.reject(new Error('ADLC_AGY contains shell metacharacters'));
  }
  const timeout = env.ADLC_AGY_TIMEOUT ?? '300s';
  // CONSERVATIVE and resolution-INDEPENDENT: on Windows the resolved binary may
  // turn out to be a `.cmd` (a bare `ADLC_AGY=agy` legitimately resolves to
  // `agy.cmd`), so the env-chosen timeout/model can reach a cmd.exe line no
  // matter what the raw input looked like. Deciding this from the raw input
  // would skip the denylist for exactly that case; deciding it from the RESOLVED
  // path would make input validation depend on what happens to be installed.
  // Validating whenever a shell is POSSIBLE is strictly safer and does neither.
  if (process.platform === 'win32') {
    if (CMD_META.test(String(timeout))) {
      return Promise.reject(new Error('ADLC_AGY_TIMEOUT contains shell metacharacters'));
    }
    if (CMD_META.test(String(model))) {
      return Promise.reject(new Error('model contains shell metacharacters'));
    }
  }
  // RESOLVE TO AN ABSOLUTE PATH — for the override too, not just the default.
  // cmd.exe resolves a bare or `.\`-prefixed name against the CURRENT DIRECTORY
  // before PATH, and cwd here is the repository under analysis, so `agy.cmd`
  // sitting in that repo would be executed with the prompt on its stdin. The
  // metacharacter denylist above does not stop that: `agy.cmd` contains no
  // metacharacters. An override naming a bare command is therefore resolved
  // through PATH as well, and an absolute override is kept as given.
  // Fails closed — never falls back to the unresolved name (see spawn-safe.mjs).
  const bin = isDefault ? resolveOnPath('agy', { env }) : resolveOnPath(apiKey, { env });
  if (!bin) {
    return Promise.reject(new Error(
      isDefault ? 'agy not found on PATH' : `ADLC_AGY does not resolve to an executable: ${apiKey}`,
    ));
  }
  // Decided from the RESOLVED path: a bare `agy` resolves to `agy.cmd` on
  // Windows, and a batch file spawned without cmd.exe simply fails to launch.
  const needsWinShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const args = ['--print', '--print-timeout', timeout, '--model', model];
  if (env.ADLC_AGY_SANDBOX === '1') args.push('--sandbox');
  const input = system ? `${system}\n\n---\n\n${prompt}` : prompt;
  return new Promise((resolve, reject) => {
    const opts = { stdio: ['pipe', 'pipe', 'pipe'] };
    // `.cmd`/`.bat` need cmd.exe, but NOT Node's `shell: true`: that joins argv
    // with spaces and no quoting, so an argument containing `>` is reparsed as a
    // redirection. Drive cmd.exe ourselves with every element quoted, and pass
    // windowsVerbatimArguments so Node does not re-quote the line we built.
    const p = needsWinShell
      ? spawn(winShell(env), winCmdArgs(bin, args), { ...opts, windowsVerbatimArguments: true })
      : spawn(bin, args, opts);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error(`agy spawn failed: ${e.message}`)));
    p.stdin.end(input);
    p.on('close', (code) => {
      // agy exits 0 even on print-timeout; the error surfaces in the output.
      if (code !== 0) return reject(new Error(`agy exit ${code}: ${(err || out).slice(-400)}`));
      if (isAgyTimeout(out)) {
        return reject(new Error('agy: timed out waiting for response'));
      }
      // agy is a subprocess CLI, not a metered API call — it never reports
      // real token counts. usage stays null rather than a fabricated
      // estimate; callers that need a number fall back to chars/4 themselves.
      resolve({ text: out.replace(/\s+$/, ''), usage: null });
    });
  });
}

/**
 * Normalize a provider's raw usage block to { inputTokens, outputTokens,
 * cachedTokens }. Each provider reports usage differently (or not at all);
 * missing/malformed fields default to 0 rather than throwing — usage is
 * observability, not something a completion should fail over.
 */
function usageFromAnthropic(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    inputTokens: raw.input_tokens ?? 0,
    outputTokens: raw.output_tokens ?? 0,
    // Anthropic splits cache reads and cache writes; both count as "cached"
    // for our purposes (cheaper-than-fresh-input), tracked separately isn't
    // needed at this granularity.
    cachedTokens: (raw.cache_read_input_tokens ?? 0) + (raw.cache_creation_input_tokens ?? 0),
  };
}

function usageFromOpenAI(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    inputTokens: raw.prompt_tokens ?? 0,
    outputTokens: raw.completion_tokens ?? 0,
    cachedTokens: raw.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

function usageFromGemini(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    inputTokens: raw.promptTokenCount ?? 0,
    outputTokens: raw.candidatesTokenCount ?? 0,
    cachedTokens: raw.cachedContentTokenCount ?? 0,
  };
}

const PROVIDERS = [
  {
    name: 'anthropic',
    envKey: 'ANTHROPIC_API_KEY',
    models: {
      cheap: 'claude-haiku-4-5',
      mid: 'claude-sonnet-4-6',
      frontier: 'claude-opus-4-8',
    },
    async send({ apiKey, model, system, prompt, maxTokens, cacheable }) {
      // Prompt caching (issue #273): only worth marking when the SAME
      // {system, prompt} pair will be sent again — a cache write costs more
      // than a plain input token, and only pays off on a later read. fan()
      // is the caller that resamples one prompt N times against the SAME
      // provider and sets this; complete() defaults to false (a one-off
      // call has no reuse to amortize the write cost against), and
      // fanProviders() also leaves it false (each provider gets exactly one
      // call — no repetition to hit a cache with).
      //
      // Below Anthropic's per-model minimum cacheable length, the API
      // silently ignores cache_control on a block rather than erroring, so
      // there is no need to size-check the prompt here.
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          ...(system
            ? { system: cacheable ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] : system }
            : {}),
          messages: [{
            role: 'user',
            content: cacheable ? [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }] : prompt,
          }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const text = (data.content ?? []).map((b) => b.text ?? '').join('');
      return { text, usage: usageFromAnthropic(data.usage) };
    },
  },
  {
    name: 'openai',
    envKey: 'OPENAI_API_KEY',
    models: {
      cheap: 'gpt-5-mini',
      mid: 'gpt-5.1',
      frontier: 'gpt-5.1',
    },
    async send({ apiKey, model, system, prompt, maxTokens }) {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          max_completion_tokens: maxTokens,
          messages: [
            ...(system ? [{ role: 'system', content: system }] : []),
            { role: 'user', content: prompt },
          ],
        }),
      });
      if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content ?? '';
      return { text, usage: usageFromOpenAI(data.usage) };
    },
  },
  {
    name: 'gemini',
    envKey: 'GEMINI_API_KEY',
    models: {
      cheap: 'gemini-2.5-flash',
      mid: 'gemini-2.5-pro',
      frontier: 'gemini-2.5-pro',
    },
    async send({ apiKey, model, system, prompt, maxTokens }) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: maxTokens },
        }),
      });
      if (!res.ok) throw new Error(`gemini ${res.status}: ${await res.text()}`);
      const data = await res.json();
      const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      return { text, usage: usageFromGemini(data.usageMetadata) };
    },
  },
  {
    // Antigravity CLI subprocess provider. Last in the list so API-key
    // providers win during auto-detection; force with ADLC_PROVIDER=agy.
    name: 'agy',
    envKey: 'ADLC_AGY',
    models: {
      cheap: 'Gemini 3.5 Flash (Medium)',
      mid: 'Claude Sonnet 4.6 (Thinking)',
      frontier: 'Claude Opus 4.6 (Thinking)',
    },
    send: agySend,
  },
];

/** Names of all known providers, in auto-detect priority order. */
export const PROVIDER_NAMES = PROVIDERS.map((p) => p.name);

/**
 * Detect the first available provider (or the one forced).
 *
 * `forceProvider` is a per-invocation override (e.g. a CLI `--provider` flag)
 * and, when given, takes precedence over the `ADLC_PROVIDER` env var — it is
 * additive to the env override, not a replacement for it: omit it and
 * behavior is unchanged (env override, then auto-detect by cost/latency
 * order per ADR-0007).
 *
 * Returns { name, apiKey, models } or null when no key is present (or the
 * override/env name doesn't match a known provider).
 */
export function detectProvider(env = process.env, forceProvider) {
  const forced = forceProvider || env.ADLC_PROVIDER;
  const candidates = forced ? PROVIDERS.filter((p) => p.name === forced) : PROVIDERS;
  for (const p of candidates) {
    const apiKey = env[p.envKey];
    // agy is gated on a feature flag (truthy-but-not-"false"); API-key
    // providers are gated on a non-empty key.
    if (p.name === 'agy') {
      if (envEnabled(apiKey)) return { ...p, apiKey };
      if (forced === 'agy') return { ...p, apiKey: '1' }; // explicit force needs no key
    } else if (apiKey) {
      return { ...p, apiKey };
    }
  }
  return null;
}

/** Resolve a tier ('cheap'|'mid'|'frontier') or explicit model id to a model id. */
export function resolveModel(provider, { tier = 'mid', model } = {}, env = process.env) {
  if (model) return model;
  const override = env[`ADLC_MODEL_${tier.toUpperCase()}`];
  if (override) return override;
  const resolved = provider.models[tier];
  if (!resolved) throw new Error(`unknown tier: ${tier}`);
  return resolved;
}

/**
 * Single completion. Throws on missing provider or HTTP error. Returns the
 * completion text as a plain string (unchanged contract — every caller in
 * the toolkit does `const text = await complete(...)`).
 *
 * opts: { tier, model, system, prompt, maxTokens, provider, onUsage }
 *   opts.provider — optional per-invocation override (e.g. a CLI `--provider`
 *   flag), mirroring ADLC_PROVIDER but scoped to this one call; takes
 *   precedence over ADLC_PROVIDER. Omit it and single-provider auto-detect
 *   remains the default (cost/latency per ADR-0007) — additive only.
 *   opts.onUsage — optional `(usage) => void` side-channel, fired
 *   synchronously right before `complete` returns, with
 *   `{ inputTokens, outputTokens, cachedTokens, provider, model, tier }`.
 *   Additive: omit it and behavior is byte-identical to before usage
 *   accounting existed. agy has no metered usage — `onUsage` is not called
 *   for it (there is nothing real to report; a fabricated estimate would be
 *   worse than silence). Callers that need a number for agy should fall
 *   back to their own chars/4 estimate.
 *   opts.cacheable — optional, default false (issue #273). Marks the
 *   system/prompt as a prompt-cache candidate on providers that support
 *   explicit cache breakpoints (currently: anthropic). Only set this when
 *   the SAME {system, prompt} pair will genuinely be sent again — a cache
 *   write costs more than a plain input token and only pays off on a later
 *   read. `fan()` sets it automatically (that is exactly what it does:
 *   resample one prompt N times against one provider); a bare `complete()`
 *   call or `fanProviders()` (one call per DISTINCT provider, no repeat)
 *   leave it false unless the caller knows better.
 * env — defaults to process.env; overridable for tests.
 */
export async function complete(opts, env = process.env) {
  const provider = detectProvider(env, opts.provider);
  if (!provider) {
    throw new Error(
      opts.provider
        ? `provider "${opts.provider}" is not available — set its API key ` +
          `(or ADLC_AGY for agy), or omit --provider to auto-detect`
        : 'no LLM provider configured — set ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY (or use --prompt-only)'
    );
  }
  const model = resolveModel(provider, opts, env);
  const { text, usage } = await provider.send(
    {
      apiKey: provider.apiKey,
      model,
      system: opts.system,
      prompt: opts.prompt,
      maxTokens: opts.maxTokens ?? 4096,
      cacheable: opts.cacheable ?? false,
    },
    env
  );
  if (typeof opts.onUsage === 'function' && usage) {
    opts.onUsage({ ...usage, provider: provider.name, model, tier: opts.tier });
  }
  return text;
}

/**
 * Fan out N independent completions of the same prompt (fresh "contexts" by
 * construction — each call is stateless). Settles all; returns array of
 * { ok, value | error } in order.
 *
 * This samples the SAME (auto-detected or opts.provider-forced) provider N
 * times. For N distinct provider families instead, use `fanProviders`.
 *
 * opts.onUsage, if present, is forwarded to every one of the N `complete`
 * calls and so fires once per resample (each with that resample's own
 * usage) — no separate wiring needed here.
 *
 * opts.cacheable defaults to true here (issue #273) — unlike a bare
 * complete() call, fan() exists specifically to resend one identical prompt
 * N times against one provider, which is exactly the shape a prompt-cache
 * write pays for itself on: the first call writes the cache, the remaining
 * N-1 read it. Pass `cacheable: false` explicitly to opt out.
 */
export async function fan(opts, n, env = process.env) {
  const fanOpts = { cacheable: true, ...opts };
  const results = await Promise.allSettled(
    Array.from({ length: n }, () => complete(fanOpts, env))
  );
  return results.map((r) =>
    r.status === 'fulfilled' ? { ok: true, value: r.value } : { ok: false, error: String(r.reason) }
  );
}

/**
 * Fan a single prompt across N DISTINCT named providers — one completion per
 * requested provider family, instead of N resamples of one auto-detected
 * provider (see `fan`). Per ADR-0007, cross-family diversity catches blind
 * spots a single model family shares; this is the primitive that gives
 * consumers (e.g. consensus-fix, gate-fuzzing) access to that diversity via a
 * `--providers <a,b,c>` flag.
 *
 * Each entry in `providerNames` is passed to `complete` as a per-call
 * `provider` override, so a name with no configured API key surfaces as a
 * normal `{ ok: false }` result for THAT entry — it never aborts the other
 * providers' calls.
 *
 * @param {object} opts - same shape as `complete` (without `provider`)
 * @param {string[]} providerNames - e.g. ['anthropic', 'openai', 'gemini']
 * @param {object} [env] - defaults to process.env; overridable for tests
 * @returns {Promise<Array<{ok:boolean, value?:string, error?:string, provider:string}>>}
 */
export async function fanProviders(opts, providerNames, env = process.env) {
  const results = await Promise.allSettled(
    providerNames.map((name) => complete({ ...opts, provider: name }, env))
  );
  return results.map((r, i) =>
    r.status === 'fulfilled'
      ? { ok: true, value: r.value, provider: providerNames[i] }
      : { ok: false, error: String(r.reason), provider: providerNames[i] }
  );
}

/**
 * Extract the first JSON value ({...} or [...]) from model output.
 * Strips code fences, balances braces while respecting strings.
 * Throws if nothing parseable is found.
 */
export function extractJson(text) {
  if (typeof text !== 'string') throw new Error('extractJson: input is not a string');
  const cleaned = text.replace(/```(?:json)?/g, '');
  const start = cleaned.search(/[[{]/);
  if (start === -1) throw new Error('extractJson: no JSON object or array found');
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1));
    }
  }
  throw new Error('extractJson: unbalanced JSON in model output');
}
