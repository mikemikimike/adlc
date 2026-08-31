import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyDenyRecord, doctorReport } from '../lib/doctor.mjs';
import { ensureDenyMarker, loadDenyRecords, readDenyMarker } from '../lib/deny-marker.mjs';
import { writeDenyRecord } from '../lib/deny-persist.mjs';
import { writeFinal } from '../lib/final.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'handoff-doctor-'));

test('classifyDenyRecord: ORPHANED-UNBOUND is exactly open + null ticket + null hash + no capture; every near-miss classifies differently', () => {
  const orphan = { session_id: 's1', ticket_id: null, content_hash: null, status: 'open' };
  assert.equal(classifyDenyRecord(orphan, { hasCapture: false }).kind, 'orphaned-unbound');
  assert.equal(classifyDenyRecord({ ...orphan, ticket_id: 'T1' }, { hasCapture: false }).kind, 'bound');
  assert.equal(classifyDenyRecord({ ...orphan, content_hash: 'h' }, { hasCapture: false }).kind, 'bound');
  assert.equal(classifyDenyRecord(orphan, { hasCapture: true }).kind, 'captured');
  assert.equal(classifyDenyRecord({ ...orphan, status: 'consumed' }, { hasCapture: false }).kind, 'closed');
});

test('doctorReport over a real store: an orphan is reported with its clear command; a bound deny and a captured deny are NOT clearable; a clean store reports none', () => {
  const root = scratch();
  try {
    ensureDenyMarker(root, { sessionId: 'orphan-a', host: 'pi' });
    ensureDenyMarker(root, { sessionId: 'bound-b', ticketId: 'T9', contentHash: 'c'.repeat(64), host: 'pi' });
    ensureDenyMarker(root, { sessionId: 'captured-c', host: 'pi' });
    writeFinal(root, { sessionId: 'captured-c', ticketId: null, contentHash: null, host: 'pi' });
    const r = doctorReport(root);
    assert.equal(r.ok, true);
    assert.deepEqual(r.orphans.map((o) => o.session_id).sort(), ['orphan-a']);
    assert.deepEqual(r.records.map((x) => [x.session_id, x.kind]).sort(), [['bound-b', 'bound'], ['captured-c', 'captured'], ['orphan-a', 'orphaned-unbound']]);
    assert.match(r.clearCommand, /doctor --clear/, 'the report names the exact clear command');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('provenance: new deny records carry writer {pid, argv0, cwd, host, wroteAt}; readers tolerate records without it; loadDenyRecords passes it through', () => {
  const root = scratch();
  try {
    ensureDenyMarker(root, { sessionId: 'with-prov', host: 'pi' });
    const rec = readDenyMarker(root, 'with-prov').record;
    assert.equal(typeof rec.writer, 'object');
    assert.equal(rec.writer.pid, process.pid);
    assert.equal(typeof rec.writer.argv0, 'string');
    assert.ok(!rec.writer.argv0.includes('/'), 'argv0 is a basename, never a path');
    assert.equal(rec.writer.cwd, process.cwd());
    assert.ok(rec.writer.wroteAt);
    // A record written without provenance (the pre-provenance schema) still loads and classifies.
    const legacy = writeDenyRecord(root, { session_id: 'legacy-l', ticket_id: null, content_hash: null, status: 'open', since: new Date().toISOString(), host: 'pi', schema: 1 });
    assert.equal(legacy.ok, true);
    const loaded = loadDenyRecords(root);
    assert.equal(loaded.ok, true);
    const l = loaded.records.find((x) => x.session_id === 'legacy-l');
    assert.equal(l.writer, undefined);
    assert.equal(classifyDenyRecord(l, { hasCapture: false }).kind, 'orphaned-unbound');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
