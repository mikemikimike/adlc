// Liveness probe for the owner recorded in an in-flight mutation record.
//
// Extracted from bin/hollow-test.mjs so it can be tested directly. Both of the
// properties that matter here are invisible to an integration test:
//
//   * the probe must OBSERVE, never disturb — signal 0 performs the permission
//     and existence checks and delivers nothing. Any other signal number is
//     delivered for real, so a probe that drifted to 1 would SIGHUP the very run
//     it was checking. An integration test cannot see that reliably, because a
//     killed child of the test process becomes a zombie and still answers
//     `kill(pid, 0)` until it is reaped.
//
//   * EPERM means the pid EXISTS but belongs to another user, so the owner is
//     alive and its file must not be touched. Provoking EPERM for real needs a
//     process owned by somebody else, which a test cannot conjure.
//
// Injecting `kill` makes both observable in-process.

/**
 * Is the process that owns an in-flight record still running?
 *
 * @param {number} pid            Owner pid from the record.
 * @param {(pid: number, signal: number) => void} [kill]  Defaults to process.kill.
 * @returns {boolean} true if the owner is alive (or alive but not ours to signal).
 */
export function pidAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}
