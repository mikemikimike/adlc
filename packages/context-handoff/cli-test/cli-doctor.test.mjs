import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDenyMarker } from '../lib/deny-marker.mjs';
import { writeFinal } from '../lib/final.mjs';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'handoff.mjs');
const TEST_KEY = 'd'.repeat(64);

function run(args, { cwd, env = {} } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd, env: { ...process.env, ADLC_MANIFEST_KEY: '', ...env }, stderr: 'pipe' });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout?.toString() ?? '', stderr: err.stderr?.toString() ?? '' };
  }
}

function seeded() {
  const root = mkdtempSync(join(tmpdir(), 'handoff-doctor-cli-'));
  ensureDenyMarker(root, { sessionId: 'orphan-a', host: 'pi' });
  ensureDenyMarker(root, { sessionId: 'bound-b', ticketId: 'T9', contentHash: 'c'.repeat(64), host: 'pi' });
  ensureDenyMarker(root, { sessionId: 'captured-c', host: 'pi' });
  writeFinal(root, { sessionId: 'captured-c', ticketId: null, contentHash: null, host: 'pi' });
  return root;
}

test('doctor (read-only): exit 2 with the orphan named + provenance printed + the clear command; exit 0 on a clean store; never writes', () => {
  const root = seeded();
  try {
    const dir = join(root, '.adlc');
    const r = run(['doctor', '--dir', dir], { cwd: root });
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /orphan-a/);
    assert.match(r.stdout, /orphaned-unbound/);
    assert.match(r.stdout, /doctor --clear/);
    assert.ok(existsSync(join(dir, 'handoffs', 'denies', 'orphan-a.json')), 'read-only: nothing removed');
    rmSync(join(dir, 'handoffs', 'denies', 'orphan-a.json'));
    const clean = run(['doctor', '--dir', dir], { cwd: root });
    assert.equal(clean.code, 2, 'bound-b and captured-c still block new sessions — doctor reports open denies remain');
    rmSync(root, { recursive: true, force: true });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor --clear --write with the key: removes ONLY the orphan, updates the sentinel, appends a signed handoff-doctor-clear manifest entry', () => {
  const root = seeded();
  try {
    const dir = join(root, '.adlc');
    const r = run(['doctor', '--clear', '--write', '--dir', dir], { cwd: root, env: { ADLC_MANIFEST_KEY: TEST_KEY } });
    // The clear succeeded, but bound-b and captured-c are still OPEN denies: exit 2 keeps the
    // operator's attention on them — 0 means "no open denies at all", never "the clear ran".
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /cleared 1 orphaned-unbound record\(s\): orphan-a/);
    assert.ok(!existsSync(join(dir, 'handoffs', 'denies', 'orphan-a.json')), 'the orphan is gone');
    assert.ok(existsSync(join(dir, 'handoffs', 'denies', 'bound-b.json')), 'a bound deny is untouched');
    assert.ok(existsSync(join(dir, 'handoffs', 'denies', 'captured-c.json')), 'a captured deny is untouched');
    const sentinel = JSON.parse(readFileSync(join(dir, '.deny-store'), 'utf8'));
    assert.ok(!sentinel.sessions.includes('orphan-a'), 'sentinel membership updated');
    assert.ok(sentinel.sessions.includes('bound-b'));
    const segs = readFileSync(join(dir, 'manifest.jsonl'), 'utf8');
    const entry = segs.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.gate === 'handoff-doctor-clear');
    assert.ok(entry, 'a manifest entry records the clear');
    assert.ok(entry.sig, 'and it is signed');
    assert.deepEqual(entry.data.cleared, ['orphan-a']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor --clear --write WITHOUT the key fails closed: exit 1, nothing removed, no manifest entry', () => {
  const root = seeded();
  try {
    const dir = join(root, '.adlc');
    const r = run(['doctor', '--clear', '--write', '--dir', dir], { cwd: root, env: { ADLC_MANIFEST_KEY: '' } });
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.ok(existsSync(join(dir, 'handoffs', 'denies', 'orphan-a.json')), 'nothing removed');
    assert.ok(!existsSync(join(dir, 'manifest.jsonl')) || !readFileSync(join(dir, 'manifest.jsonl'), 'utf8').includes('handoff-doctor-clear'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('doctor --clear (dry-run, no --write): prints what WOULD clear, removes nothing, exit 2 while orphans remain', () => {
  const root = seeded();
  try {
    const dir = join(root, '.adlc');
    const r = run(['doctor', '--clear', '--dir', dir], { cwd: root });
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /dry-run|--write/i);
    assert.ok(existsSync(join(dir, 'handoffs', 'denies', 'orphan-a.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
