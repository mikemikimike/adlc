/**
 * snapshot.mjs — Read and restore file contents.
 * Pure operations around a snapshot map: { [path]: string }.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { applyHunks } from './hunks.mjs';

/**
 * Map a candidate's filename back to the caller's ORIGINAL path string.
 *
 * validateCandidate compares separator-NORMALIZED paths, so a model may
 * legitimately answer `src/file.mjs` for a `--files src\file.mjs` run on
 * Windows. Everything downstream — the pre-run snapshot, and the write itself —
 * is keyed by the caller's original strings, so the model's form has to be
 * translated back. Indexing the snapshot with the un-translated name yields
 * `undefined`, and because the apply loop writes as it goes, a multi-file run
 * fails only AFTER earlier files are already modified: a partially written tree,
 * which is the one outcome the snapshot/restore machinery exists to prevent.
 *
 * Falls back to the candidate's own string when nothing matches; the caller has
 * already rejected any file outside the allowed list, so this cannot introduce
 * a path the operator did not name.
 *
 * @param {string} file  filename as the model returned it
 * @param {string[]} callerPaths  the paths exactly as supplied to --files
 * @returns {string}
 */
export function resolveTargetPath(file, callerPaths, platform = process.platform) {
  const name = String(file);
  // 1. An EXACT match always wins, on every platform. Normalizing first meant a
  //    caller path that matched the candidate verbatim could still lose to an
  //    earlier entry that merely normalized equal.
  for (const original of callerPaths) {
    if (String(original) === name) return original;
  }
  // 2. Separator equivalence is a WINDOWS fact, not a universal one. There
  //    `src\a.mjs` and `src/a.mjs` name the same file; on POSIX a backslash is
  //    an ordinary filename character, so they are two DIFFERENT files and
  //    treating them as interchangeable writes the wrong one. Applying the
  //    normalization everywhere is how a candidate naming `src/a.mjs` could be
  //    evaluated against one file and applied to another.
  if (platform !== 'win32') return name;
  const normalized = name.replaceAll('\\', '/');
  for (const original of callerPaths) {
    if (String(original).replaceAll('\\', '/') === normalized) return original;
  }
  return name;
}


/**
 * Capture the current content of each path.
 * Returns { path: content } map.
 */
export function takeSnapshot(paths) {
  const snap = {};
  for (const p of paths) {
    snap[p] = readFileSync(p, 'utf8');
  }
  return snap;
}

/**
 * Write each path back to its snapshot content.
 * Always restores all paths regardless of errors on individual writes.
 */
export function restoreSnapshot(snapshot) {
  const errors = [];
  for (const [p, content] of Object.entries(snapshot)) {
    try {
      writeFileSync(p, content, 'utf8');
    } catch (err) {
      errors.push(`restore failed for ${p}: ${err.message}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(errors.join('\n'));
  }
}

/**
 * Apply a set of hunk-based changes from an LLM candidate (issue #279).
 * changes: [{ file, hunks: [{startLine, endLine, replacement}] }]
 *
 * Only writes files whose paths are in the snapshot — a candidate
 * referencing an unlisted file is a validation bug upstream (validateCandidate
 * should have caught it already) and throws, unlike a hunk that fails to
 * apply cleanly, which is an EXPECTED per-candidate outcome (a candidate's
 * hunk coordinates don't match reality, e.g. an off-by-one or a reference to
 * an excerpt-omitted line) and is reported back via the return value instead
 * of thrown, so the caller can disqualify just that one candidate.
 *
 * @param {Array<{file:string, hunks:Array}>} changes
 * @param {{[path]: string}} snapshot
 * @returns {{ok:true} | {ok:false, error:string}}
 */
export function applyChanges(changes, snapshot) {
  for (const { file, hunks } of changes) {
    const realFile = resolveTargetPath(file, Object.keys(snapshot));
    if (!(realFile in snapshot)) {
      throw new Error(`candidate referenced file not in provided list: ${file}`);
    }
    const result = applyHunks(snapshot[realFile], hunks);
    if (!result.ok) return { ok: false, error: `${file}: ${result.error}` };
    writeFileSync(realFile, result.content, 'utf8');
  }
  return { ok: true };
}
