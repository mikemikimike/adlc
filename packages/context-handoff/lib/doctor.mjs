/**
 * `handoff doctor` (T-01M1AXGESETGS9RCD3BGP8KQH6): classify every deny record and
 * clear ONLY orphaned-unbound ones — open, bound to no ticket, no content hash, and
 * no capture (final) for the session. Exactly the shape a pre-containment writer
 * leaks (the sess-1 record, 2026-08-31 triage): there is nothing to resume into,
 * so deletion is the only sensible operator action, and it dead-ends in one
 * command instead of an investigation. Everything else — bound, captured, closed —
 * is real handoff state the doctor must never touch.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadDenyRecords, denyPath } from './deny-marker.mjs';
import { readFinal } from './final.mjs';
import { recordHandoffEvidence } from './evidence.mjs';

/** A live session's deny is open+unbound+uncaptured for a WINDOW before binding/capture:
 * only a record older than this is an orphan candidate (agy r2 — clearing a live one would
 * strand the session it protects). */
export const ORPHAN_MIN_AGE_MS = 24 * 60 * 60 * 1000;

/** Pure classification. `orphaned-unbound` = open + null ticket + null hash + no capture + old enough. */
export function classifyDenyRecord(record, { hasCapture, nowMs = Date.now(), minAgeMs = ORPHAN_MIN_AGE_MS }) {
  if (!record || record.status !== 'open') return { kind: 'closed' };
  if (record.ticket_id != null || record.content_hash != null) return { kind: 'bound' };
  if (hasCapture) return { kind: 'captured' };
  const sinceMs = Date.parse(record.since ?? '');
  if (!Number.isFinite(sinceMs) || nowMs - sinceMs < minAgeMs) return { kind: 'recent-unbound' };
  return { kind: 'orphaned-unbound' };
}

/** Read-only report over the real store. */
export function doctorReport(root, { nowMs = Date.now(), minAgeMs = ORPHAN_MIN_AGE_MS } = {}) {
  const loaded = loadDenyRecords(root);
  if (!loaded.ok) return { ok: false, reason: loaded.reason ?? 'deny store unavailable', records: [], orphans: [], open: [] };
  const records = loaded.records.map((r) => {
    const hasCapture = readFinal(root, r.session_id).ok === true;
    return { ...r, kind: classifyDenyRecord(r, { hasCapture, nowMs, minAgeMs }).kind };
  });
  const orphans = records.filter((r) => r.kind === 'orphaned-unbound');
  const open = records.filter((r) => r.kind !== 'closed');
  return {
    ok: true,
    records,
    orphans,
    open,
    invalidRecords: loaded.invalidRecords ?? [],
    clearCommand: 'adlc handoff doctor --clear --write   # needs ADLC_MANIFEST_KEY',
  };
}

const sentinelPath = (root) => join(root, '.adlc', '.deny-store');
const legacySentinelPath = (root) => join(root, '.adlc', 'handoffs', '.deny-store');

/** Rewrite the sentinel without the cleared sessions (atomic tmp+rename; legacy file removed). */
function readSentinelSessions(path) {
  try { const cur = JSON.parse(readFileSync(path, 'utf8')); return Array.isArray(cur.sessions) ? cur.sessions : []; } catch { return []; }
}

function rewriteSentinelWithout(root, clearedIds) {
  const path = sentinelPath(root);
  // A store migrated mid-way may hold registrations ONLY in the legacy file: merge both
  // before filtering, or the first doctor clear would drop every bound/captured session's
  // registration (agy r1 #1).
  let sessions = [];
  if (existsSync(path)) sessions = readSentinelSessions(path);
  if (existsSync(legacySentinelPath(root))) sessions = [...new Set([...sessions, ...readSentinelSessions(legacySentinelPath(root))])];
  const next = sessions.filter((s) => !clearedIds.includes(s)).sort();
  mkdirSync(join(root, '.adlc'), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify({ schema: 1, sessions: next })}\n`, 'utf8');
  renameSync(tmp, path);
  if (existsSync(legacySentinelPath(root))) { try { unlinkSync(legacySentinelPath(root)); } catch { /* best effort */ } }
  return next;
}

/**
 * Clear the orphaned-unbound records. Requires the signing key: the clear is an
 * operator override of a fail-closed control, so it is recorded as signed
 * manifest evidence naming exactly what was cleared and why. Fails closed —
 * without a key nothing is touched.
 */
export function doctorClear(root, { key, dir, fs = { unlinkSync } }) {
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, exitCode: 1, reason: 'ADLC_MANIFEST_KEY is required for --clear --write; nothing was removed' };
  }
  const report = doctorReport(root);
  if (!report.ok) return { ok: false, exitCode: 1, reason: report.reason };
  const cleared = [];
  let failed = null;
  for (const o of report.orphans) {
    const p = denyPath(root, o.session_id);
    try { fs.unlinkSync(p); cleared.push(o.session_id); } catch (err) {
      failed = { session_id: o.session_id, reason: err?.message ?? 'unlink failed' };
      break;
    }
  }
  // A partial failure must never leave the store inconsistent or unaudited: whatever WAS
  // removed is reflected in the sentinel and recorded as evidence before the error is
  // reported (agy r1 #2).
  if (cleared.length > 0 || failed === null) {
    rewriteSentinelWithout(root, cleared);
    recordHandoffEvidence({
      gate: 'handoff-doctor-clear',
      ticket: null,
      data: { cleared, ...(failed ? { partial: true, failed } : {}), reason: 'orphaned-unbound (open, no ticket, no content hash, no capture)', writerNote: 'operator-keyed doctor clear' },
      dir,
      key,
    });
  }
  if (failed) return { ok: false, exitCode: 1, reason: `could not remove the deny for ${failed.session_id}: ${failed.reason} (cleared so far: ${cleared.join(', ') || 'none'} — sentinel updated, evidence recorded)`, cleared };
  return { ok: true, exitCode: 0, cleared, remainingOpen: report.open.length - cleared.length };
}
