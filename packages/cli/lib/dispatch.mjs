import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTool } from './registry.mjs';
import { resolveOnPath, winShell, winCmdArgs, hasCmdMetacharacters } from '@adlc/core';

const require = createRequire(import.meta.url);

export function packageJsonPath(packageName) {
  if (packageName.startsWith('@adlc/')) {
    const name = packageName.slice('@adlc/'.length);
    const devPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', name, 'package.json');
    if (existsSync(devPath)) {
      try {
        const pkg = JSON.parse(readFileSync(devPath, 'utf8'));
        if (pkg?.name === packageName) return devPath;
      } catch {
        /* fall through to require.resolve */
      }
    }
  }
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch {
    return null;
  }
}

function resolvePackageBin(packageName, binName) {
  const pkgJsonPath = packageJsonPath(packageName);
  if (!pkgJsonPath) return null;
  return binPathFromPackage(pkgJsonPath, readPackage(pkgJsonPath), binName);
}

function readPackage(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function binPathFromPackage(pkgJsonPath, pkg, preferredBinName) {
  const bin = pkg?.bin;
  if (!bin) return null;
  if (typeof bin === 'string') return join(dirname(pkgJsonPath), bin);
  const name = preferredBinName ?? Object.keys(bin)[0];
  const relative = bin[name];
  return relative ? join(dirname(pkgJsonPath), relative) : null;
}

export function resolveBin(toolName) {
  const tool = getTool(toolName);
  if (!tool) return null;
  const pkgJsonPath = packageJsonPath(tool.packageName);
  if (!pkgJsonPath) return null;
  const pkg = readPackage(pkgJsonPath);
  return binPathFromPackage(pkgJsonPath, pkg, tool.binName ?? tool.name);
}

export function resolveRunnerBin() {
  const pkgJsonPath = packageJsonPath('@adlc/runner');
  if (!pkgJsonPath) return null;
  const pkg = readPackage(pkgJsonPath);
  return binPathFromPackage(pkgJsonPath, pkg, 'adlc-runner') ?? binPathFromPackage(pkgJsonPath, pkg);
}

function runBin(label, bin, args, spawnFn) {
  if (!bin) {
    return {
      code: 1,
      error: `tool not installed: ${label} - run "npm i -g @adlc/cli" to install the suite`,
    };
  }

  const result = spawnFn(process.execPath, [bin, ...args], { stdio: 'inherit' });
  if (result.error) return { code: 1, error: `failed to run ${label}: ${result.error.message}` };
  if (result.signal) return { code: 1, error: `${label} terminated by signal ${result.signal}` };
  return { code: typeof result.status === 'number' ? result.status : 1 };
}

export function npxCliJsCandidates(execPath = process.execPath) {
  const binDir = dirname(execPath);
  return [join(binDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'), join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')];
}

function resolveNpxCliJs() {
  // Prefer the JS entry so we never need `npx.cmd` / `shell: true` (operator
  // argv must not cross cmd.exe). Layouts differ by installer:
  //   fnm/nvs:   <prefix>/node_modules/npm/... next to the binary
  //   official / hostedtoolcache: <prefix>/bin/node + <prefix>/lib/node_modules/npm/...
  for (const p of npxCliJsCandidates()) {
    if (existsSync(p)) return p;
  }
  try {
    return require.resolve('npm/bin/npx-cli.js');
  } catch {
    return null;
  }
}

// External verbs (registry.mjs `external: true`) are not workspace packages, so there is
// no local bin to resolve. They shell out to `npx <packageName>` with full argument
// passthrough instead -- this is how `adlc review` reaches the separate
// `adversarial-review` CLI without vendoring it into this monorepo (issue #65).
//
// `resolveNpxCli` is injectable (production passes nothing, so behavior is unchanged)
// because WHICH of the two supported branches below runs is a property of the runner's
// Node install, not of this function. A test that could not choose the branch would be
// asserting the machine it happens to run on -- either the fallback or the JS-entry path
// would go permanently unexercised depending on where the suite ran.
function runExternal(packageName, args, spawnFn, resolveNpxCli = resolveNpxCliJs, resolveNpxBin = () => resolveOnPath('npx')) {
  const npxCli = resolveNpxCli();
  if (npxCli) {
    const result = spawnFn(process.execPath, [npxCli, packageName, ...args], { stdio: 'inherit' });
    if (result.error) return { code: 1, error: `failed to run npx ${packageName}: ${result.error.message}` };
    if (result.signal) return { code: 1, error: `${packageName} terminated by signal ${result.signal}` };
    return { code: typeof result.status === 'number' ? result.status : 1 };
  }

  // Rare fallback (Node install without a bundled npm).
  //
  // NO BARE NAME REACHES A SHELL. origin/main spawned `npx` with no shell at
  // all; the `npx.cmd` + `shell: true` form was introduced on this branch and is
  // the same repo-local hijack spawn-safe.mjs exists to close — `adlc review`
  // runs with cwd at the repository UNDER REVIEW, so a reviewed repo containing
  // `npx.cmd` would supply the executable. The metacharacter denylist cannot
  // help: `npx.cmd` contains none. Resolve absolutely, or fail closed.
  const isWindows = process.platform === 'win32';
  // VALIDATE BEFORE RESOLVING. A refusal that depends on whether npx happens to
  // be installed is not a refusal — the same ordering bug this branch already
  // fixed in core/lib/llm.mjs. Kept as defence in depth alongside winCmdArgs
  // quoting, and win32-only because the POSIX spawn below is shell-free.
  if (isWindows && [packageName, ...args].some((a) => hasCmdMetacharacters(a))) {
    return {
      code: 1,
      error: `failed to run npx ${packageName}: arguments contain shell metacharacters and npx-cli.js was not found beside node`,
    };
  }
  // Injectable for the same reason resolveNpxCli is: on a mocked win32 platform
  // resolveOnPath applies Windows path rules to a POSIX PATH and can never
  // succeed, so the win32 branch would be untestable off Windows.
  const resolvedNpx = resolveNpxBin();
  if (!resolvedNpx) {
    return { code: 1, error: `failed to run npx ${packageName}: npx not found on PATH and npx-cli.js was not found beside node` };
  }
  const useCmdShell = isWindows && /\.(cmd|bat)$/i.test(resolvedNpx);
  const result = useCmdShell
    ? spawnFn(winShell(), winCmdArgs(resolvedNpx, [packageName, ...args]), { stdio: 'inherit', windowsVerbatimArguments: true })
    : spawnFn(resolvedNpx, [packageName, ...args], { stdio: 'inherit' });
  if (result.error) return { code: 1, error: `failed to run npx ${packageName}: ${result.error.message}` };
  if (result.signal) return { code: 1, error: `${packageName} terminated by signal ${result.signal}` };
  return { code: typeof result.status === 'number' ? result.status : 1 };
}

export function dispatch(toolName, args, opts = {}) {
  const spawnFn = opts.spawnFn ?? spawnSync;
  const tool = getTool(toolName);
  if (toolName === 'ticket' && ['pull', 'push', 'sync', 'doctor'].includes(args[0])) {
    return runBin('@adlc/ticket-sync', resolvePackageBin('@adlc/ticket-sync', 'adlc-ticket-sync'), args, spawnFn);
  }
  if (tool?.external) {
    return runExternal(tool.packageName, args, spawnFn, opts.resolveNpxCliJs, opts.resolveNpxBin);
  }
  return runBin(tool?.packageName ?? `@adlc/${toolName}`, resolveBin(toolName), args, spawnFn);
}

export function dispatchRunner(args, opts = {}) {
  const spawnFn = opts.spawnFn ?? spawnSync;
  return runBin('@adlc/runner', resolveRunnerBin(), args, spawnFn);
}
