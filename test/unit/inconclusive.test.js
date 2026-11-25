import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inconclusiveReason } from '../../src/capture/inconclusive.js';
import { createEvidenceStore } from '../../src/capture/evidence.js';
import { crossCheck } from '../../src/capture/crosscheck.js';
import { sha256Hex } from '../../src/util/hash.js';

const page = { site: 'https://shop.example', path: '/', expect: null };
const visit = (doc, extra = {}) => ({ reason: null, document: { status: 200, finalUrl: 'https://shop.example/', headers: {}, metaCsp: [], title: 'Shop', ...doc }, scripts: [], ...extra });
const own = new Set(['https://shop.example', 'https://auth.shop.example']);

test('a page that answered 4xx or 5xx is inconclusive', () => {
  assert.equal(inconclusiveReason(visit({ status: 404 }), page, { own }), 'the page answered 404');
});

test('a page that ended up outside the site is inconclusive, a redirect within own origins is not', () => {
  assert.equal(inconclusiveReason(visit({ finalUrl: 'https://login.other.example/' }), page, { own }), 'ended up on https://login.other.example, outside the site');
  assert.equal(inconclusiveReason(visit({ finalUrl: 'https://auth.shop.example/login' }), page, { own }), null);
});

test('bot challenges are recognised by header, title or script host', () => {
  assert.equal(inconclusiveReason(visit({ headers: { 'cf-mitigated': 'challenge' } }), page, { own }), 'bot challenge (Cloudflare)');
  assert.equal(inconclusiveReason(visit({ title: 'Just a moment...' }), page, { own }), 'bot challenge (Cloudflare)');
  assert.equal(inconclusiveReason(visit({}, { scripts: [{ ref: { url: 'https://ct.captcha-delivery.com/c.js' } }] }), page, { own }), 'bot challenge (DataDome)');
});

test('a challenge sign the page itself could plant does not hide a page that loaded', () => {
  const approvedOwn = (s) => s.ref.url === 'https://shop.example/app.js';
  const app = { ref: { url: 'https://shop.example/app.js' } };
  const opts = { own, hasApprovedOwn: true, isApprovedOwn: approvedOwn };
  assert.equal(inconclusiveReason(visit({}, { scripts: [app, { ref: { url: 'https://ct.captcha-delivery.com/c.js' } }] }), page, opts), null);
  assert.equal(inconclusiveReason(visit({ title: 'Just a moment...' }, { scripts: [app] }), page, opts), null);
  assert.equal(inconclusiveReason(visit({ title: 'Just a moment...' }), { ...page, expect: '#cart' }, { own }), null, 'the expected content was found');
  // A real challenge page loads none of the site's own scripts.
  assert.equal(inconclusiveReason(visit({ title: 'Just a moment...' }), page, opts), 'bot challenge (Cloudflare)');
});

test('without expect, a page with approved own scripts must load at least one of them', () => {
  const approvedOwn = (s) => s.ref.url === 'https://shop.example/app.js';
  assert.equal(inconclusiveReason(visit({}, { scripts: [{ ref: { url: 'https://shop.example/maintenance.js' } }] }), page, { own, hasApprovedOwn: true, isApprovedOwn: approvedOwn }), "expected content missing: none of the page's approved own scripts loaded");
  assert.equal(inconclusiveReason(visit({}, { scripts: [{ ref: { url: 'https://shop.example/app.js' } }] }), page, { own, hasApprovedOwn: true, isApprovedOwn: approvedOwn }), null);
  assert.equal(inconclusiveReason(visit({}), page, { own, hasApprovedOwn: false }), null, 'the first run has nothing approved yet');
});

test('a visit that already failed keeps its reason', () => {
  assert.equal(inconclusiveReason({ ...visit({}), reason: 'step 2 (click): no element matches #x' }, page, { own }), 'step 2 (click): no element matches #x');
});

test('evidence is capped at 2 MB per script and 100 MB in total', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-ev-'));
  const store = createEvidenceStore(dir, { perScript: 10, total: 25 });
  const a = store.add('a'.repeat(64), '0123456789ABCDEF', 'https://x.example/a.js');
  assert.equal(a.bytes, 10);
  assert.equal(readFileSync(join(dir, a.file), 'utf8'), '0123456789');
  assert.equal(store.add('b'.repeat(64), '0123456789', null).bytes, 10);
  assert.equal(store.add('c'.repeat(64), '0123456789', null), null, 'the total cap stops further files');
  assert.equal(existsSync(join(dir, `evidence/${'c'.repeat(64)}.js`)), false);
  assert.equal(store.add('a'.repeat(64), 'again', null).bytes, 10, 'the same hash is stored once');
});

test('the cross-check compares only 200 JavaScript responses, sent with the referer Chrome used', async () => {
  const served = Buffer.from('window.x=1;');
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init.headers.referer]);
    if (url.endsWith('/403.js')) return new Response('no', { status: 403 });
    if (url.endsWith('/html.js')) return new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
    if (url.endsWith('/cloaked.js')) return new Response('window.clean=1;', { status: 200, headers: { 'content-type': 'application/javascript' } });
    return new Response(served, { status: 200, headers: { 'content-type': 'text/javascript; charset=utf-8' } });
  };
  const hash = sha256Hex(served);
  const out = await crossCheck([
    { url: 'https://cdn.example/same.js', chromeHash: hash, referer: 'https://shop.example/' },
    { url: 'https://cdn.example/403.js', chromeHash: hash, referer: 'https://shop.example/' },
    { url: 'https://cdn.example/html.js', chromeHash: hash, referer: 'https://shop.example/' },
    { url: 'https://cdn.example/cloaked.js', chromeHash: hash, referer: 'https://shop.example/' },
  ], { fetchImpl });
  assert.deepEqual(out.map((c) => [c.url.split('/').pop(), c.directHash === null ? null : c.directHash === hash, c.note]), [
    ['same.js', true, null], ['403.js', null, 'direct fetch answered 403'], ['html.js', null, 'direct fetch returned text/html, not JavaScript'], ['cloaked.js', false, null],
  ]);
  assert.equal(calls[0][1], 'https://shop.example/');
});
