// release.test.mjs — the lockstep release is the moment version drift creeps in
// (a bump that misses a package.json, or leaves package-lock.json stale), so the
// release helper gets a committed regression test. Drives releaseMain against a
// throwaway fake repo with an injected lockfile-regen spy (no real npm, offline,
// leaves no trace).
//
// Regression context: v1.1.0 was bumped across packages/* + root but the bump
// (a) never regenerated package-lock.json (it stayed at 1.0.2 → npm ci broke) and
// (b) skipped plugins/adlc-pi (stranded at 1.0.2). These tests pin BOTH gaps shut.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { releaseMain, repinInternalDependencies, packagePublishOrder, findVersionDrift, publishTargets, findPublishMetadataProblems, npmInvocation } from '../release.mjs';

/** Build a throwaway repo with package and Codex-manifest version surfaces. */
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'adlc-release-'));
  const packagesDir = join(root, 'packages');
  const pluginsDir = join(root, 'plugins');
  mkdirSync(packagesDir);
  mkdirSync(pluginsDir);
  const write = (p, obj) => writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
  // Every non-private publish target must carry a repository.url or npm provenance
  // 422s mid-publish (findPublishMetadataProblems guards this).
  const repository = { type: 'git', url: 'git+https://github.com/voodootikigod/adlc.git' };
  write(join(root, 'package.json'), { name: 'adlc', version: '1.0.0', private: true });
  mkdirSync(join(packagesDir, 'core'));
  write(join(packagesDir, 'core', 'package.json'), { name: '@adlc/core', version: '1.0.0', repository });
  mkdirSync(join(packagesDir, 'cli'));
  write(join(packagesDir, 'cli', 'package.json'), {
    name: '@adlc/cli',
    version: '1.0.0',
    repository,
    dependencies: { '@adlc/core': '1.0.0' }, // packages pin exactly
  });
  mkdirSync(join(pluginsDir, 'adlc-pi'));
  write(join(pluginsDir, 'adlc-pi', 'package.json'), {
    name: '@adlc/pi',
    version: '1.0.0',
    private: true,
    dependencies: { '@adlc/core': '^1.0.0' }, // plugin uses a caret range
  });
  // A plugin directory with NO package.json (e.g. adlc-claude-code) must be skipped.
  mkdirSync(join(pluginsDir, 'adlc-claude-code'));
  mkdirSync(join(pluginsDir, 'adlc-codex', '.codex-plugin'), { recursive: true });
  write(join(pluginsDir, 'adlc-codex', 'package.json'), {
    name: '@adlc/codex',
    version: '1.0.0',
    repository,
    dependencies: { '@adlc/cli': '1.0.0' },
  });
  write(join(pluginsDir, 'adlc-codex', '.codex-plugin', 'plugin.json'), {
    name: 'adlc-codex',
    version: '1.0.0',
  });
  mkdirSync(join(pluginsDir, 'adlc-cursor', '.cursor-plugin'), { recursive: true });
  write(join(pluginsDir, 'adlc-cursor', 'package.json'), {
    name: '@adlc/cursor',
    version: '1.0.0',
    repository,
    dependencies: { '@adlc/cli': '1.0.0' },
  });
  write(join(pluginsDir, 'adlc-cursor', '.cursor-plugin', 'plugin.json'), {
    name: 'adlc-cursor',
    version: '1.0.0',
  });
  // Two plugin entries — a marketplace fix that only updates plugins[0] must be
  // caught, not just a fix that updates *a* entry (see the split drift tests below).
  mkdirSync(join(root, '.cursor-plugin'), { recursive: true });
  write(join(root, '.cursor-plugin', 'marketplace.json'), {
    name: 'adlc',
    metadata: { description: 'fixture marketplace', version: '1.0.0' },
    plugins: [
      { name: 'adlc-cursor', source: './plugins/adlc-cursor', version: '1.0.0' },
      { name: 'adlc-second', source: './plugins/adlc-second', version: '1.0.0' },
    ],
  });
  return { root, packagesDir, pluginsDir };
}

const ver = (p) => JSON.parse(readFileSync(p, 'utf8')).version;

test('releaseMain bumps packages, versioned plugins, and root in lockstep', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    let regen = 0;
    const rc = releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile: () => regen++ });
    assert.equal(rc, 0);
    assert.equal(ver(join(root, 'package.json')), '1.2.0');
    assert.equal(ver(join(packagesDir, 'core', 'package.json')), '1.2.0');
    assert.equal(ver(join(packagesDir, 'cli', 'package.json')), '1.2.0');
    assert.equal(ver(join(pluginsDir, 'adlc-pi', 'package.json')), '1.2.0'); // NOT stranded
    assert.equal(ver(join(pluginsDir, 'adlc-codex', 'package.json')), '1.2.0');
    assert.equal(ver(join(pluginsDir, 'adlc-codex', '.codex-plugin', 'plugin.json')), '1.2.0');
    assert.equal(ver(join(pluginsDir, 'adlc-cursor', 'package.json')), '1.2.0');
    assert.equal(ver(join(pluginsDir, 'adlc-cursor', '.cursor-plugin', 'plugin.json')), '1.2.0');
    const marketplace = JSON.parse(readFileSync(join(root, '.cursor-plugin', 'marketplace.json'), 'utf8'));
    assert.equal(marketplace.metadata.version, '1.2.0');
    assert.equal(marketplace.plugins[0].version, '1.2.0');
    assert.equal(marketplace.plugins[1].version, '1.2.0'); // every entry, not just index 0
    assert.equal(regen, 1); // lockfile regenerated exactly once
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseMain repins internal @adlc deps, preserving range prefixes', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    const cli = JSON.parse(readFileSync(join(packagesDir, 'cli', 'package.json'), 'utf8'));
    assert.equal(cli.dependencies['@adlc/core'], '1.2.0'); // exact stays exact
    const pi = JSON.parse(readFileSync(join(pluginsDir, 'adlc-pi', 'package.json'), 'utf8'));
    assert.equal(pi.dependencies['@adlc/core'], '^1.2.0'); // caret preserved, version moved
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findVersionDrift flags a stranded plugin package', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    const drift = findVersionDrift('1.2.0', { root, packagesDir, pluginsDir });
    assert.ok(drift.length >= 1);
    assert.ok(drift.some((d) => d.includes('adlc-pi')), `expected a plugin entry, got: ${drift.join(' | ')}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findVersionDrift flags a stale Codex manifest independently of package.json', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    const manifest = join(pluginsDir, 'adlc-codex', '.codex-plugin', 'plugin.json');
    writeFileSync(manifest, '{"name":"adlc-codex","version":"1.1.0"}\n');
    const drift = findVersionDrift('1.2.0', { root, packagesDir, pluginsDir });
    assert.ok(drift.some((entry) => entry.includes('.codex-plugin')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Regression: a lockstep bump left plugins/adlc-cursor/.cursor-plugin/plugin.json
// and the root .cursor-plugin/marketplace.json (both entry.version and
// metadata.version) stranded at the prior version, because releaseMain only ever
// walked Codex plugin manifests. cursor-install-smoke.mjs's T47 lockstep check
// caught it; this pins the fix shut the same way the Codex-manifest test does.
test('findVersionDrift flags a stale Cursor manifest independently of package.json', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    const manifest = join(pluginsDir, 'adlc-cursor', '.cursor-plugin', 'plugin.json');
    writeFileSync(manifest, '{"name":"adlc-cursor","version":"1.1.0"}\n');
    const drift = findVersionDrift('1.2.0', { root, packagesDir, pluginsDir });
    assert.ok(drift.some((entry) => entry.includes('.cursor-plugin')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Isolates the metadata.version invariant: both plugin entries are current, only
// metadata.version is stale. A drift check that only walks `plugins[]` (and never
// looks at `metadata`) would wrongly report no drift here.
test('findVersionDrift flags a stale marketplace metadata.version even when every plugin entry is current', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    const marketplacePath = join(root, '.cursor-plugin', 'marketplace.json');
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
    marketplace.metadata.version = '1.1.0'; // stale metadata; both plugin entries stay at 1.2.0
    writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n');
    const drift = findVersionDrift('1.2.0', { root, packagesDir, pluginsDir });
    assert.ok(drift.some((entry) => entry.includes('marketplace.json') && entry.includes('metadata.version')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Isolates the per-entry invariant on the SECOND entry specifically: metadata and
// plugins[0] are current, only plugins[1] is stale. A drift check hardcoded to
// plugins[0] (an index-0-only regression) would wrongly report no drift here.
test('findVersionDrift flags a stale non-first marketplace plugin entry with metadata current', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    const marketplacePath = join(root, '.cursor-plugin', 'marketplace.json');
    const marketplace = JSON.parse(readFileSync(marketplacePath, 'utf8'));
    marketplace.plugins[1].version = '1.1.0'; // stale second entry; metadata + plugins[0] stay at 1.2.0
    writeFileSync(marketplacePath, JSON.stringify(marketplace, null, 2) + '\n');
    const drift = findVersionDrift('1.2.0', { root, packagesDir, pluginsDir });
    assert.ok(drift.some((entry) => entry.includes('marketplace.json') && entry.includes('adlc-second')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findVersionDrift returns empty once releaseMain has bumped everything', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    releaseMain(['1.2.0'], { root, packagesDir, pluginsDir, regenerateLockfile() {} });
    assert.deepEqual(findVersionDrift('1.2.0', { root, packagesDir, pluginsDir }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('releaseMain rejects an invalid version (and does not regenerate the lockfile)', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    let regen = 0;
    const rc = releaseMain(['not-semver'], { root, packagesDir, pluginsDir, regenerateLockfile: () => regen++ });
    assert.equal(rc, 1);
    assert.equal(regen, 0);
    assert.equal(ver(join(root, 'package.json')), '1.0.0'); // untouched
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The three default npm impls (lockfile regen, pack, publish) all shell out to
// `npm`, which is `npm.cmd` on Windows — CreateProcess cannot run it, so
// execFileSync needs `shell: true` there and must NOT get it anywhere else
// (a shell reintroduces metacharacter interpretation on the arguments). Those
// impls are the injectable DEFAULTS, so every releaseMain test replaces them and
// none of them exercises the platform test; asserting the flag directly is the
// only coverage it has. Both directions are pinned: a check inverted to
// `!== 'win32'` breaks npm on Windows AND shells out on POSIX.
test('npmInvocation resolves npm ABSOLUTELY and never hands a bare name to a shell', () => {
  // origin/main spawned `npm` with no shell. This branch briefly added
  // `shell: process.platform === 'win32'`, which lets cmd.exe resolve the bare
  // name against the CURRENT DIRECTORY first — with publish credentials in
  // scope. The contract now is: an absolute command, or a throw.
  const { cmd, args, opts } = npmInvocation(['publish'], 'linux');
  assert.ok(cmd.startsWith('/') || /^[A-Za-z]:/.test(cmd), `expected an absolute npm, got ${cmd}`);
  assert.deepEqual(args, ['publish']);
  assert.equal(opts.shell, undefined, 'no shell on POSIX');
  assert.notEqual(cmd, 'npm', 'a bare name must never be returned');
});

test('packagePublishOrder keeps core first and cli last', () => {
  assert.deepEqual(packagePublishOrder(['cli', 'rails-guard', 'core']), ['core', 'rails-guard', 'cli']);
});

test('repinInternalDependencies leaves non-@adlc deps alone', () => {
  const out = repinInternalDependencies(
    { name: 'x', version: '1.0.0', dependencies: { '@adlc/core': '1.0.0', chalk: '^5.0.0' } },
    '2.0.0'
  );
  assert.equal(out.version, '2.0.0');
  assert.equal(out.dependencies['@adlc/core'], '2.0.0');
  assert.equal(out.dependencies.chalk, '^5.0.0'); // untouched
});

// ---- T30: the publish step must include publishable (non-private) plugin packages ----
test('publishTargets: non-private plugin packages publish after packages/*; private plugins are skipped', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    // a publishable plugin (like @adlc/opencode after T30)
    mkdirSync(join(pluginsDir, 'adlc-opencode'));
    writeFileSync(join(pluginsDir, 'adlc-opencode', 'package.json'), JSON.stringify({
      name: '@adlc/opencode', version: '1.0.0',
      dependencies: { '@adlc/core': '1.0.0' },
    }, null, 2) + '\n');
    const targets = publishTargets({ packagesDir, pluginsDir });
    const names = targets.map((t) => t.name);
    assert.ok(names.includes('@adlc/opencode'), 'publishable plugin included');
    // dependency order: every packages/* entry precedes the plugin consumers
    assert.ok(names.indexOf('@adlc/core') < names.indexOf('@adlc/opencode'));
    // private plugins (adlc-pi fixture is private in makeRepo? assert on the actual fixture)
    for (const t of targets) assert.notEqual(t.private, true, `${t.name} must not be private`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('releaseMain --publish invokes publishImpl for plugin packages too', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    mkdirSync(join(pluginsDir, 'adlc-opencode'));
    writeFileSync(join(pluginsDir, 'adlc-opencode', 'package.json'), JSON.stringify({
      name: '@adlc/opencode', version: '1.0.0',
      repository: { type: 'git', url: 'git+https://github.com/voodootikigod/adlc.git' },
    }, null, 2) + '\n');
    const published = [];
    const rc = releaseMain(['1.2.0', '--publish'], {
      root, packagesDir, pluginsDir,
      regenerateLockfile() {},
      publishImpl: (_dir, name) => published.push(name),
    });
    assert.equal(rc, 0);
    assert.ok(published.includes('@adlc/opencode'), `published: ${published}`);
    assert.ok(published.includes('@adlc/core'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('findPublishMetadataProblems flags a publish target with missing/empty repository.url', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    assert.deepEqual(findPublishMetadataProblems({ packagesDir, pluginsDir }), []);
    // Empty repository.url — the exact @adlc/tickets condition that 422'd the
    // v1.4.0 provenance publish mid-flight.
    writeFileSync(join(packagesDir, 'core', 'package.json'), JSON.stringify({
      name: '@adlc/core', version: '1.0.0', repository: { url: '' },
    }, null, 2) + '\n');
    const problems = findPublishMetadataProblems({ packagesDir, pluginsDir });
    assert.equal(problems.length, 1);
    assert.match(problems[0], /@adlc\/core/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('releaseMain --publish fails closed and publishes NOTHING when a target lacks repository.url', () => {
  const { root, packagesDir, pluginsDir } = makeRepo();
  try {
    // Strip repository from a non-private target — a partial lockstep publish must
    // not be possible; the whole suite ships or none of it does.
    writeFileSync(join(packagesDir, 'core', 'package.json'), JSON.stringify({
      name: '@adlc/core', version: '1.0.0',
    }, null, 2) + '\n');
    const published = [];
    const rc = releaseMain(['1.2.0', '--publish'], {
      root, packagesDir, pluginsDir,
      regenerateLockfile() {},
      publishImpl: (_dir, name) => published.push(name),
    });
    assert.equal(rc, 1);
    assert.equal(published.length, 0, `nothing should publish; got: ${published}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
