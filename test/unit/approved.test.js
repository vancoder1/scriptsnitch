import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseApproved, emptyApproved, serializeApproved, siteSection, addEntry, addToEntry, removeEntry,
  addPending, approvePending, todoReasons, validateApproved, ApprovedError, UnknownPendingError,
} from '../../src/config/approved.js';

const example = readFileSync(new URL('../fixtures/approved-example.json', import.meta.url), 'utf8');
const SITE = 'https://shop.example';

test('round-trips the design example deterministically', () => {
  const a = parseApproved(example, 'approved.json');
  const once = serializeApproved(a);
  assert.deepEqual(parseApproved(once, 'x').sites['https://shop.example'].scripts.map((s) => s.id).sort(), a.sites['https://shop.example'].scripts.map((s) => s.id).sort());
  assert.equal(serializeApproved(parseApproved(once, 'x')), once);
  assert.ok(once.endsWith('\n'));
});

test('entries are written sorted, so diffs stay small', () => {
  let a = emptyApproved();
  a = addEntry(a, SITE, 'scripts', { id: 'zeta', match: 'https://z.example/z.js', trust: 'exact', sha256: ['a'.repeat(64)], reason: 'z', approved: '2026-11-23' });
  a = addEntry(a, SITE, 'scripts', { id: 'alpha', match: 'https://a.example/a.js', trust: 'exact', sha256: ['b'.repeat(64)], reason: 'a', approved: '2026-11-23' });
  const ids = JSON.parse(serializeApproved(a)).sites[SITE].scripts.map((s) => s.id);
  assert.deepEqual(ids, ['alpha', 'zeta']);
});

test('defaults are filled in on load', () => {
  const a = parseApproved(JSON.stringify({ version: 1, sites: { [SITE]: { scripts: [{ id: 'x', match: 'https://cdn.example/x@1.0.0/x.js', trust: 'exact', sha256: ['c'.repeat(64)], reason: 'r', approved: '2026-11-23' }] } } }), 'a');
  const s = siteSection(a, SITE);
  assert.deepEqual(s.own, []);
  assert.deepEqual(s.scripts[0].pages, ['**']);
  assert.deepEqual(s.scripts[0].behavior, { hosts: [], listens: [], input: false, eval: false, obfuscation: 'minified' });
  assert.deepEqual(s.pending, []);
});

test('pending items never count as approved', () => {
  let a = emptyApproved();
  a = addPending(a, SITE, { finding: 'new-origin|https://evil.example/x.js|*', severity: 'high', into: 'scripts', entry: { id: 'evil', match: 'https://evil.example/x.js', trust: 'exact', sha256: ['d'.repeat(64)], reason: 'TODO: why does this page need it?', approved: '2026-11-23' } });
  assert.deepEqual(siteSection(a, SITE).scripts, []);
  assert.equal(siteSection(a, SITE).pending.length, 1);
});

test('approvePending moves a whole entry into its section with the reason', () => {
  let a = addPending(emptyApproved(), SITE, { finding: 'new-origin|https://chat.example/w.js|*', severity: 'high', into: 'scripts', entry: { id: 'chat', match: 'https://chat.example/w.js', trust: 'origin', reason: 'TODO: why does this page need it?', approved: '2026-11-23' } });
  a = approvePending(a, SITE, 'new-origin|https://chat.example/w.js|*', 'Support chat');
  const s = siteSection(a, SITE);
  assert.equal(s.scripts[0].id, 'chat');
  assert.equal(s.scripts[0].reason, 'Support chat');
  assert.deepEqual(s.pending, []);
});

test('approvePending adds to an existing entry without replacing what was approved', () => {
  let a = parseApproved(example, 'approved.json');
  a = addPending(a, SITE, { finding: 'listener|https://www.googletagmanager.com/gtm.js?id=GTM-ABC123|/checkout', severity: 'high', into: 'scripts', id: 'gtm-main', add: { listens: ['card:field:keydown'] } });
  a = approvePending(a, SITE, 'listener|https://www.googletagmanager.com/gtm.js?id=GTM-ABC123|/checkout', 'Checkout analytics');
  const gtm = siteSection(a, SITE).scripts.find((s) => s.id === 'gtm-main');
  assert.deepEqual(gtm.behavior.listens, ['*:document:click', 'card:field:keydown']);
  assert.equal(gtm.reason, 'Marketing tags');
});

test('approvePending names an unknown finding', () => {
  assert.throws(() => approvePending(emptyApproved(), SITE, 'nope|x|*', 'r'), UnknownPendingError);
});

test('addToEntry finds destinations by match and merges receives', () => {
  let a = parseApproved(example, 'approved.json');
  a = addToEntry(a, SITE, 'destinations', 'https://*.stripe.com', { receives: ['card'] });
  assert.deepEqual(siteSection(a, SITE).destinations.find((d) => d.match === 'https://*.stripe.com').receives, ['card']);
});

test('removeEntry removes a script by id', () => {
  const a = removeEntry(parseApproved(example, 'approved.json'), SITE, 'scripts', 'jsdelivr-jquery');
  assert.equal(siteSection(a, SITE).scripts.some((s) => s.id === 'jsdelivr-jquery'), false);
});

test('rejects an exact external entry without a literal URL and a sha256', () => {
  const bad = (script) => () => parseApproved(JSON.stringify({ version: 1, sites: { [SITE]: { scripts: [{ id: 'x', reason: 'r', approved: '2026-11-23', ...script }] } } }), 'a');
  assert.throws(bad({ match: 'https://cdn.example/x.js', trust: 'exact' }), (e) => e instanceof ApprovedError && /sha256/.test(e.message));
  assert.throws(bad({ match: 'https://cdn.example/*.js', trust: 'exact', sha256: ['e'.repeat(64)] }), /literal URL/);
  assert.throws(bad({ match: 'inline', trust: 'exact' }), /template/);
});

test('rejects origin or deploy trust on a path-shared host', () => {
  const doc = (trust) => JSON.stringify({ version: 1, sites: { [SITE]: { scripts: [{ id: 'x', match: 'https://cdn.jsdelivr.net/npm/x@1/x.js', trust, reason: 'r', approved: '2026-11-23' }] } } });
  assert.throws(() => parseApproved(doc('origin'), 'a'), /shared/);
  assert.throws(() => parseApproved(doc('deploy'), 'a'), /shared/);
});

test('rejects an own entry that is not one exact origin', () => {
  const doc = (own) => JSON.stringify({ version: 1, sites: { [SITE]: { own } } });
  assert.throws(() => parseApproved(doc(['https://*.shop.example']), 'a'), /exact origin/);
  assert.throws(() => parseApproved(doc(['https://shop.example/assets']), 'a'), /exact origin/);
  assert.equal(siteSection(parseApproved(doc(['https://myshop.netlify.app']), 'a'), SITE).own[0], 'https://myshop.netlify.app');
});

test('rejects duplicate script ids', () => {
  const s = { match: 'https://a.example/a@1.0.0/a.js', trust: 'exact', sha256: ['f'.repeat(64)], reason: 'r', approved: '2026-11-23' };
  assert.throws(() => parseApproved(JSON.stringify({ version: 1, sites: { [SITE]: { scripts: [{ id: 'dup', ...s }, { id: 'dup', ...s }] } } }), 'a'), /duplicate id/);
});

test('todoReasons finds live entries only, never pending ones', () => {
  let a = addEntry(emptyApproved(), SITE, 'destinations', { match: 'https://api.example', reason: 'TODO: why does this page need it?', approved: '2026-11-23' });
  a = addPending(a, SITE, { finding: 'new-origin|https://x.example/x.js|*', severity: 'high', into: 'scripts', entry: { id: 'x', match: 'https://x.example/x.js', trust: 'origin', reason: 'TODO: why does this page need it?', approved: '2026-11-23' } });
  assert.deepEqual(todoReasons(a), [{ site: SITE, section: 'destinations', id: 'https://api.example' }]);
});

test('validateApproved reports issues instead of throwing', () => {
  const issues = validateApproved({ version: 1, sites: { [SITE]: { scripts: [{ id: 'x', match: 'https://cdn.jsdelivr.net/npm/x@1/x.js', trust: 'origin', reason: 'r', approved: '2026-11-23' }] } } });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, 'error');
  assert.equal(issues[0].pointer, '/sites/https:~1~1shop.example/scripts/0/trust');
});

test('loads with a BOM and CRLF, and names the line of a syntax error', () => {
  assert.equal(parseApproved('﻿{\r\n"version": 1,\r\n"sites": {}\r\n}\r\n', 'a').version, 1);
  assert.throws(() => parseApproved('{\n "version": 1,\n "sites": {},\n}', 'approved.json'), (e) => e instanceof ApprovedError && /line 4/.test(e.message));
});
