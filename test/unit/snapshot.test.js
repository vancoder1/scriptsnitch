import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSnapshot, SnapshotError, SNAPSHOT_FORMAT } from '../../src/snapshot.js';

const H = 'a'.repeat(64);
function visit(role = 'A') {
  return {
    role, conclusive: true, reason: null,
    document: { status: 200, finalUrl: 'https://shop.example/', headers: { 'content-security-policy': "script-src 'self'" }, metaCsp: [] },
    consent: { found: null, accepted: false },
    scripts: [{ ref: { url: 'https://cdn.example/x.js', contentHash: H, template: null }, kind: 'external', frame: 'top', creator: null, hosts: [], band: 'minified', createsCode: false, size: 120, sri: 'sha384-abc' }],
    destinations: [{ url: 'https://shop.example/api', method: 'GET', type: 'Fetch', frame: 'top', initiator: null, phase: 'load' }],
    frames: [], fields: [], listeners: [], inputCode: [], peers: 0, linkHosts: [], probe: null,
  };
}
function snapshot() {
  return {
    format: SNAPSHOT_FORMAT, tool: '1.0.0',
    run: { startedAt: '2026-11-24T06:17:00.000Z', finishedAt: '2026-11-24T06:18:00.000Z', chrome: 'Chrome/157.0.8103.78', drill: false },
    sites: { 'https://shop.example': { deployMarker: null } },
    pages: [{ name: 'Home', site: 'https://shop.example', path: '/', url: 'https://shop.example/', sensitive: false, profiles: { desktop: { conclusive: true, reason: null, viewport: { width: 1366, height: 768 }, visits: [visit('A'), visit('B')] } } }],
    crossCheck: [], evidence: { [H]: { file: `evidence/${H}.js`, url: 'https://cdn.example/x.js', bytes: 120 } },
  };
}
const pointerOf = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof SnapshotError, e.message); return e.pointer; } assert.fail('expected a SnapshotError'); };

test('accepts a valid snapshot', () => {
  const s = validateSnapshot(snapshot());
  assert.equal(s.pages[0].profiles.desktop.visits.length, 2);
});

test('refuses another major format with a clear message', () => {
  assert.throws(() => validateSnapshot({ ...snapshot(), format: 2 }), /format 2.*this version reads format 1/);
});

test('rejects an unknown visit role and says where', () => {
  const s = snapshot();
  s.pages[0].profiles.desktop.visits[1].role = 'C';
  assert.equal(pointerOf(() => validateSnapshot(s)), '/pages/0/profiles/desktop/visits/1/role');
});

test('rejects a content hash that is not a SHA-256', () => {
  const s = snapshot();
  s.pages[0].profiles.desktop.visits[0].scripts[0].ref.contentHash = 'not-a-hash';
  assert.equal(pointerOf(() => validateSnapshot(s)), '/pages/0/profiles/desktop/visits/0/scripts/0/ref/contentHash');
});

test('an evidence file must be evidence/<its hash>.js, so the report job reads nothing else', () => {
  // The collect job runs Chrome on the watched site; the report job holds a write token.
  for (const file of ['/proc/self/environ', '../../.env', `evidence/${'b'.repeat(64)}.js`, `evidence/${H}.js/../../x`]) {
    const s = snapshot();
    s.evidence[H].file = file;
    assert.equal(pointerOf(() => validateSnapshot(s)), `/evidence/${H}/file`, file);
  }
  const s = snapshot();
  s.evidence['../x'] = { file: 'evidence/../x.js', url: null, bytes: 1 };
  assert.equal(pointerOf(() => validateSnapshot(s)), '/evidence/../x');
});

test('rejects text where a number is expected', () => {
  const s = snapshot();
  s.pages[0].profiles.desktop.visits[0].peers = '2';
  assert.equal(pointerOf(() => validateSnapshot(s)), '/pages/0/profiles/desktop/visits/0/peers');
});
