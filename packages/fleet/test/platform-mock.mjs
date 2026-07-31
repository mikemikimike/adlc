// The Windows `.mjs` routing branches (isWinMjsCommand and its two call sites)
// are unreachable on a POSIX runner, and a test that only asserts the non-win32
// answer cannot distinguish the real predicate from a broken one — both return
// the same `false` for different reasons, so the branch is effectively untested.
//
// `process.platform`'s property descriptor is configurable, so the branch can be
// exercised in-process on any host. SYNCHRONOUS callbacks only: the override is
// process-global, so an awaited callback would leak win32 into whatever else the
// event loop runs next.

export function withPlatform(platform, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

export const withWin32Platform = (fn) => withPlatform('win32', fn);
