#!/usr/bin/env node
// Lockstep release for the @adlc suite.
//
//   node scripts/release.mjs <version>            # set version on all packages (no publish)
//   node scripts/release.mjs <version> --publish  # set version, then publish core-first
//
// Publishing relies on npm provenance + trusted publishing (OIDC) in CI, or a
// temporary NPM_TOKEN for the bootstrap run. Every package carries
// publishConfig.access=public, so no per-call --access is required.

import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = join(ROOT, 'packages');
const PLUGINS = join(ROOT, 'plugins');

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Regenerate package-lock.json so it tracks the freshly-bumped versions. Pure
 * lockfile resolution (the suite is zero-dependency / workspace-only), so this is
 * offline and fast. Injectable via the `regenerateLockfile` option so the unit
 * tests can drive releaseMain without shelling out to npm.
 */
function defaultRegenerateLockfile(root) {
  execFileSync('npm', ['install', '--package-lock-only'], { cwd: root, stdio: 'inherit' });
}

export function packagePublishOrder(names) {
  const unique = Array.from(new Set(names)).sort();
  return [
    ...unique.filter((name) => name === 'core'),
    ...unique.filter((name) => name !== 'core' && name !== 'cli'),
    ...unique.filter((name) => name === 'cli'),
  ];
}

/**
 * Every directory `--publish` must publish, in dependency order: packages/* in
 * the core-first/cli-last order, THEN each non-private plugin package (plugins
 * consume the packages, so they publish after them). Skipping publishable
 * plugins is exactly how @adlc/opencode ended up registered in user
 * opencode.json files while not existing on npm (T30).
 * Returns [{ dir, name, private }].
 */
export function publishTargets({ packagesDir = PKGS, pluginsDir = PLUGINS } = {}) {
  const targets = [];
  for (const name of packagePublishOrder(workspacePackageNames(packagesDir))) {
    const dir = join(packagesDir, name);
    const pkg = readJson(join(dir, 'package.json'));
    targets.push({ dir, name: pkg.name, private: pkg.private === true });
  }
  if (existsSync(pluginsDir)) {
    for (const name of readdirSync(pluginsDir).sort()) {
      const pj = join(pluginsDir, name, 'package.json');
      if (!existsSync(pj)) continue;
      const pkg = readJson(pj);
      targets.push({ dir: join(pluginsDir, name), name: pkg.name, private: pkg.private === true });
    }
  }
  return targets.filter((t) => !t.private);
}

export function repinInternalDependencies(pkg, version) {
  const next = structuredClone(pkg);
  for (const dependencyKind of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (!next[dependencyKind]) continue;
    for (const name of Object.keys(next[dependencyKind])) {
      if (!name.startsWith('@adlc/')) continue;
      // Preserve the existing range style: packages/* pin exactly (`1.2.0`), but a
      // consumer-style package (e.g. plugins/adlc-pi) may use `^`/`~` ranges —
      // forcing those to exact would silently change its dependency intent.
      const prev = next[dependencyKind][name];
      const prefix = typeof prev === 'string' && /^[\^~]/.test(prev) ? prev[0] : '';
      next[dependencyKind][name] = prefix + version;
    }
  }
  next.version = version;
  return next;
}

function workspacePackageNames(packagesDir) {
  return readdirSync(packagesDir).filter((name) => existsSync(join(packagesDir, name, 'package.json')));
}

/**
 * Every versioned package.json in the suite: each `packages/*` AND each
 * `plugins/*` that ships a package.json. Plugins without one (skill/command-only
 * integrations like adlc-claude-code) are skipped. The root is handled separately.
 */
function versionedPackageJsonPaths({ packagesDir = PKGS, pluginsDir = PLUGINS } = {}) {
  const paths = [];
  for (const base of [packagesDir, pluginsDir]) {
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const pj = join(base, name, 'package.json');
      if (existsSync(pj)) paths.push(pj);
    }
  }
  return paths;
}

function codexPluginManifestPaths(pluginsDir = PLUGINS) {
  if (!existsSync(pluginsDir)) return [];
  const paths = [];
  for (const name of readdirSync(pluginsDir)) {
    const manifest = join(pluginsDir, name, '.codex-plugin', 'plugin.json');
    if (existsSync(manifest)) paths.push(manifest);
  }
  return paths;
}

function cursorPluginManifestPaths(pluginsDir = PLUGINS) {
  if (!existsSync(pluginsDir)) return [];
  const paths = [];
  for (const name of readdirSync(pluginsDir)) {
    const manifest = join(pluginsDir, name, '.cursor-plugin', 'plugin.json');
    if (existsSync(manifest)) paths.push(manifest);
  }
  return paths;
}

function cursorMarketplacePath(root) {
  const p = join(root, '.cursor-plugin', 'marketplace.json');
  return existsSync(p) ? p : null;
}

/**
 * Deterministic post-bump gate: return a list of every place still NOT at
 * `version` — any versioned package.json (packages/* + plugins/*), the root, and
 * package-lock.json. An empty list means the suite is fully in lockstep. This is
 * what makes "the v1.1.0 drift can't happen again" machine-checkable rather than
 * a thing a human has to remember.
 */
export function findVersionDrift(version, { root = ROOT, packagesDir = PKGS, pluginsDir = PLUGINS } = {}) {
  const problems = [];
  for (const pj of versionedPackageJsonPaths({ packagesDir, pluginsDir })) {
    const v = readJson(pj).version;
    if (v !== version) problems.push(`${pj}: ${v} != ${version}`);
  }
  for (const manifest of codexPluginManifestPaths(pluginsDir)) {
    const v = readJson(manifest).version;
    if (v !== version) problems.push(`${manifest}: ${v} != ${version}`);
  }
  for (const manifest of cursorPluginManifestPaths(pluginsDir)) {
    const v = readJson(manifest).version;
    if (v !== version) problems.push(`${manifest}: ${v} != ${version}`);
  }
  const marketplacePath = cursorMarketplacePath(root);
  if (marketplacePath) {
    const marketplace = readJson(marketplacePath);
    if (marketplace.metadata?.version !== version) {
      problems.push(`${marketplacePath} metadata.version: ${marketplace.metadata?.version} != ${version}`);
    }
    for (const entry of marketplace.plugins ?? []) {
      if (entry.version !== version) {
        problems.push(`${marketplacePath} plugin ${entry.name}: ${entry.version} != ${version}`);
      }
    }
  }
  const rootV = readJson(join(root, 'package.json')).version;
  if (rootV !== version) problems.push(`${join(root, 'package.json')}: ${rootV} != ${version}`);
  const lockPath = join(root, 'package-lock.json');
  if (existsSync(lockPath)) {
    const lockV = readJson(lockPath).version;
    if (lockV !== version) problems.push(`${lockPath}: ${lockV} != ${version}`);
  }
  return problems;
}

// Repo slug every publishable package's provenance is built against. npm's
// sigstore provenance check 422s if package.json repository.url does not resolve
// to this, aborting the lockstep publish partway through.
const PROVENANCE_REPO = 'github.com/voodootikigod/adlc';

/**
 * Every non-private publish target must carry a repository.url that references
 * the source repo, or npm provenance validation rejects it mid-publish. Returns
 * the list of offenders (empty = all good).
 */
export function findPublishMetadataProblems({ packagesDir = PKGS, pluginsDir = PLUGINS } = {}) {
  const problems = [];
  for (const target of publishTargets({ packagesDir, pluginsDir })) {
    const pkg = readJson(join(target.dir, 'package.json'));
    const repo = pkg.repository;
    const url = repo && typeof repo === 'object' ? repo.url : (typeof repo === 'string' ? repo : undefined);
    if (!url || !String(url).includes(PROVENANCE_REPO)) {
      problems.push(`${target.name}: repository.url is ${JSON.stringify(url ?? null)} — provenance requires it to reference ${PROVENANCE_REPO}`);
    }
  }
  return problems;
}

function defaultPublishImpl(dir) {
  execFileSync('npm', ['publish', '--provenance'], { cwd: dir, stdio: 'inherit' });
}

export function releaseMain(
  argv = process.argv.slice(2),
  {
    root = ROOT,
    packagesDir = PKGS,
    pluginsDir = PLUGINS,
    regenerateLockfile = defaultRegenerateLockfile,
    publishImpl = defaultPublishImpl,
  } = {}
) {
  const version = argv[0];
  const publish = argv.includes('--publish');

  if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    console.error('usage: release.mjs <semver> [--publish]');
    return 1;
  }

  // core publishes first; cli publishes last because it depends on every routed tool.
  const order = packagePublishOrder(workspacePackageNames(packagesDir));

  // 1. Set version everywhere and repin every internal @adlc/* dependency to match.
  for (const name of order) {
    const pj = join(packagesDir, name, 'package.json');
    const pkg = repinInternalDependencies(readJson(pj), version);
    writeJson(pj, pkg);
    console.log(`set ${pkg.name}@${version}`);
  }

  // Versioned plugin packages (e.g. @adlc/pi) are part of the suite and
  // must move in lockstep — skipping them is exactly how plugins/adlc-pi got
  // stranded at 1.0.2 while everything else went to 1.1.0.
  if (existsSync(pluginsDir)) {
    for (const name of readdirSync(pluginsDir)) {
      const pj = join(pluginsDir, name, 'package.json');
      if (!existsSync(pj)) continue; // skill/command-only plugins have no package.json
      const pkg = repinInternalDependencies(readJson(pj), version);
      writeJson(pj, pkg);
      console.log(`set ${pkg.name}@${version} (plugin)`);
    }
    for (const manifest of codexPluginManifestPaths(pluginsDir)) {
      const plugin = readJson(manifest);
      plugin.version = version;
      writeJson(manifest, plugin);
      console.log(`set ${plugin.name}@${version} (Codex manifest)`);
    }
    for (const manifest of cursorPluginManifestPaths(pluginsDir)) {
      const plugin = readJson(manifest);
      plugin.version = version;
      writeJson(manifest, plugin);
      console.log(`set ${plugin.name}@${version} (Cursor manifest)`);
    }
  }

  // Cursor marketplace.json (root-level) lists each Cursor-packaged plugin's
  // version separately from its package.json — T47's install-smoke check
  // locksteps both entry.version and metadata.version against the package, so a
  // bump that skips this file strands the marketplace listing the same way
  // plugins/adlc-pi was stranded at 1.0.2 pre-T-drift-gate.
  const marketplacePath = cursorMarketplacePath(root);
  if (marketplacePath) {
    const marketplace = readJson(marketplacePath);
    if (marketplace.metadata) marketplace.metadata.version = version;
    for (const entry of marketplace.plugins ?? []) {
      entry.version = version;
    }
    writeJson(marketplacePath, marketplace);
    console.log(`set .cursor-plugin/marketplace.json@${version} (Cursor marketplace)`);
  }

  // Keep the (private) root version in lockstep too.
  const rootPj = join(root, 'package.json');
  const rootPkg = readJson(rootPj);
  rootPkg.version = version;
  writeJson(rootPj, rootPkg);
  console.log(`set ${rootPkg.name}@${version} (root)`);

  // 2. Regenerate the lockfile so package-lock.json tracks the new versions.
  // Omitting this is the bug that left the lockfile at 1.0.2 (npm ci broke).
  regenerateLockfile(root);
  console.log('regenerated package-lock.json');

  // 3. Fail closed on any residual drift — a missed package.json or a stale
  // lockfile aborts the release instead of shipping an inconsistent suite.
  const drift = findVersionDrift(version, { root, packagesDir, pluginsDir });
  if (drift.length > 0) {
    console.error(`version drift after bump — aborting:\n  ${drift.join('\n  ')}`);
    return 1;
  }

  // 4. Fail closed on missing publish metadata. npm provenance validation 422s
  // if a package's repository.url does not match the build's source repo, and it
  // does so MID-publish (core-first) — stranding a partial release (v1.4.0 shipped
  // 27 of 34 because @adlc/tickets had no repository field). Catch it at bump time,
  // before any tag or publish, so the whole suite ships or none of it does.
  const metadataProblems = findPublishMetadataProblems({ packagesDir, pluginsDir });
  if (metadataProblems.length > 0) {
    console.error(`publish metadata invalid — aborting (npm provenance would 422 mid-publish):\n  ${metadataProblems.join('\n  ')}`);
    return 1;
  }

  if (!publish) {
    console.log(`\nversions set to ${version} (no publish). Commit, tag v${version}, push.`);
    return 0;
  }

  // 2. Publish in dependency order — packages/* first, then every non-private
  // plugin package (they consume the packages).
  for (const target of publishTargets({ packagesDir, pluginsDir })) {
    console.log(`\npublishing ${target.name}@${version} ...`);
    publishImpl(target.dir, target.name);
  }
  console.log(`\npublished @adlc suite @ ${version}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(releaseMain());
}
