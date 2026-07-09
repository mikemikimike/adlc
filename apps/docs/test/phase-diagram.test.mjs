import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPhaseMermaid, PHASES } from '../lib/phase-graph.mjs';

test('PHASES lists P0..P7 in order', () => {
  assert.deepEqual(PHASES.map((p) => p.id), ['P0','P1','P2','P3','P4','P5','P6','P7']);
});

test('P6 is named Integrate, not Review', () => {
  const p6 = PHASES.find((p) => p.id === 'P6');
  assert.equal(p6.name, 'Integrate');
});

test('buildPhaseMermaid highlights the active phase and is a flowchart', () => {
  const out = buildPhaseMermaid('P3');
  assert.match(out, /^flowchart TD/);
  assert.ok(out.includes('  style P3 fill:#4fb4d8,stroke:#cbcdd2,color:#1c1d21'), 'active phase highlight style');
  assert.ok(out.includes('P3["P3 Rail"]'), 'P3 node label');
});

test('buildPhaseMermaid emits all eight phase nodes with canonical names', () => {
  const out = buildPhaseMermaid('P3');
  assert.ok(out.includes('  P0["P0 Triage"]'), 'P0 node');
  assert.ok(out.includes('  P1["P1 Interrogate"]'), 'P1 node');
  assert.ok(out.includes('  P2["P2 Decompose"]'), 'P2 node');
  assert.ok(out.includes('  P3["P3 Rail"]'), 'P3 node');
  assert.ok(out.includes('  P4["P4 Build"]'), 'P4 node');
  assert.ok(out.includes('  P5["P5 Prosecute"]'), 'P5 node');
  assert.ok(out.includes('  P6["P6 Integrate"]'), 'P6 node');
  assert.ok(out.includes('  P7["P7 Distill"]'), 'P7 node');
});

test('the two human gates are present, wired in, and styled with the wish token hex', () => {
  const out = buildPhaseMermaid('P0');
  // Gate 1 after P1 (spec approval)
  assert.ok(out.includes('G1{{"Human gate: Is this what I meant?"}}'), 'gate 1 node');
  assert.ok(out.includes('  P1 --> G1'), 'edge P1 to gate 1');
  assert.ok(out.includes('  G1 --> P2'), 'edge gate 1 to P2');
  // Gate 2 after P6 (behavioral acceptance)
  assert.ok(out.includes('G2{{"Human gate: Is this what I meant, running?"}}'), 'gate 2 node');
  assert.ok(out.includes('  P6 --> G2'), 'edge P6 to gate 2');
  assert.ok(out.includes('  G2 --> P7'), 'edge gate 2 to P7');
  // Gate styling mirrors --adlc-wish (#e5cd52) and differs from active highlight
  assert.ok(out.includes('style G1 fill:#e5cd52'), 'gate 1 wish styling');
  assert.ok(out.includes('style G2 fill:#e5cd52'), 'gate 2 wish styling');
  assert.ok(out.includes('style P0 fill:#4fb4d8'), 'active highlight distinct from gates');
});

test('the remaining sequential edges are present', () => {
  const out = buildPhaseMermaid('P3');
  assert.ok(out.includes('  P0 --> P1'), 'edge P0 to P1');
  assert.ok(out.includes('  P2 --> P3'), 'edge P2 to P3');
  assert.ok(out.includes('  P3 --> P4'), 'edge P3 to P4');
  assert.ok(out.includes('  P4 --> P5'), 'edge P4 to P5');
  assert.ok(out.includes('  P5 --> P6'), 'edge P5 to P6');
});

test('P5 carries the prosecution loop edge', () => {
  const out = buildPhaseMermaid('P3');
  assert.ok(out.includes('  P5 -- "loop until dry" --> P5'), 'P5 self-edge labeled loop until dry');
});

test('P7 feeds back to P0 with a dashed lessons-compound edge', () => {
  const out = buildPhaseMermaid('P3');
  assert.ok(out.includes('  P7 -. "lessons compound" .-> P0'), 'dashed P7 to P0 edge');
});

test('buildPhaseMermaid rejects unknown phases', () => {
  assert.throws(() => buildPhaseMermaid('P9'), /unknown phase/i);
  assert.throws(() => buildPhaseMermaid('Review'), /unknown phase/i);
});
