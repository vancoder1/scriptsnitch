import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entrySlotsOf, deployEvident, buildFileAccepted } from '../../src/analyze/deploy.js';
import { emptyStatusState, emptySiteState } from '../../src/state.js';

const own = new Set(['https://shop.example']);
const ext = (url, creator = null) => ({ ref: { url, contentHash: 'a'.repeat(64), template: null }, kind: 'external', creator });
const visit = (...scripts) => ({ conclusive: true, role: 'A', scripts });

test('entry slots are own scripts the HTML loads directly, with their token or version', () => {
  const slots = entrySlotsOf([visit(
    ext('https://shop.example/assets/index-B7kQ0aRz.js'),
    ext('https://shop.example/assets/chunk-Dq9Wn3Lp.js', { url: 'https://shop.example/assets/index-B7kQ0aRz.js' }),
    ext('https://shop.example/wp/x.js?ver=6.4.2'),
    ext('https://cdn.example/lib@1.2.3/lib.js'),
  )], own);
  assert.deepEqual(slots, { 'https://shop.example/assets/index-{token}.js': 'B7kQ0aRz', 'https://shop.example/wp/x.js?ver={version}': '6.4.2' });
});

test('a replaced entry token is deploy evidence', () => {
  assert.equal(deployEvident({ previousEntrySlots: { 'https://s/a/index-{token}.js': 'B7kQ0aRz' }, currentEntrySlots: { 'https://s/a/index-{token}.js': 'C9xR1bTp' } }), true);
});

test('a newly added entry slot is not deploy evidence', () => {
  assert.equal(deployEvident({ previousEntrySlots: { 'https://s/a/index-{token}.js': 'B7kQ0aRz' }, currentEntrySlots: { 'https://s/a/index-{token}.js': 'B7kQ0aRz', 'https://s/a/evil-{token}.js': 'Zz9Yy8Xx' } }), false);
});

test('a changed deploy marker is deploy evidence; a first reading is not', () => {
  assert.equal(deployEvident({ previousEntrySlots: {}, currentEntrySlots: {}, previousMarker: 'v1', currentMarker: 'v2' }), true);
  assert.equal(deployEvident({ previousEntrySlots: {}, currentEntrySlots: {}, previousMarker: null, currentMarker: 'v1' }), false);
});

test('the first run has no deploy evidence', () => {
  assert.equal(deployEvident({ previousEntrySlots: null, currentEntrySlots: { 'https://s/a/index-{token}.js': 'B7kQ0aRz' } }), false);
});

test('a build file named by the chunk map is accepted without a deploy', () => {
  assert.equal(buildFileAccepted({ token: 'Dq9Wn3Lp', referenced: true, evident: false, deployTokens: [] }), true);
});

test('an unreferenced build file is accepted only with deploy evidence, and stays accepted until the next deploy', () => {
  assert.equal(buildFileAccepted({ token: 'Zz9Yy8Xx', referenced: false, evident: false, deployTokens: [] }), false);
  assert.equal(buildFileAccepted({ token: 'Zz9Yy8Xx', referenced: false, evident: true, deployTokens: [] }), true);
  assert.equal(buildFileAccepted({ token: 'Zz9Yy8Xx', referenced: false, evident: false, deployTokens: ['Zz9Yy8Xx'] }), true);
});

test('empty states have the documented shape', () => {
  assert.deepEqual(emptyStatusState(), { v: 1, run: 0, pages: {}, sites: {}, sightings: {}, log: [] });
  assert.deepEqual(emptySiteState('https://shop.example'), { v: 1, site: 'https://shop.example', findings: {} });
});
