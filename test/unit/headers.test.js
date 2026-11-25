import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsp, cspBaseline, compareCsp } from '../../src/analyze/csp.js';
import { baselineFor, compareHeaders } from '../../src/analyze/headers.js';

const cmp = (base, cur) => compareCsp(base === null ? null : parseCsp(base), cur === null ? null : parseCsp(cur));

test('removing the CSP is weaker', () => {
  assert.deepEqual(cmp("script-src 'self'", null).weaker, ['Content-Security-Policy removed']);
});

test("adding 'unsafe-inline' without a nonce or hash is weaker", () => {
  assert.deepEqual(cmp("script-src 'self'", "script-src 'self' 'unsafe-inline'").weaker, ["script-src now allows 'unsafe-inline'"]);
});

test("adding 'unsafe-inline' alongside a nonce and 'strict-dynamic' is not weaker", () => {
  const r = cmp("script-src 'nonce-abc' 'strict-dynamic'", "script-src 'nonce-xyz' 'strict-dynamic' 'unsafe-inline' https:");
  assert.deepEqual(r.weaker, []);
  assert.deepEqual(r.newSources, []);
});

test('adding * or a whole scheme to connect-src is weaker', () => {
  assert.deepEqual(cmp("connect-src 'self'", "connect-src 'self' *").weaker, ['connect-src now allows *']);
  assert.deepEqual(cmp("connect-src 'self'", "connect-src 'self' https:").weaker, ['connect-src now allows https:']);
});

test('dropping a directive is weaker', () => {
  assert.deepEqual(cmp("script-src 'self'; frame-ancestors 'none'", "script-src 'self'").weaker, ['frame-ancestors dropped']);
});

test('adding one specific host is a new source, not weaker', () => {
  const r = cmp("script-src 'self'", "script-src 'self' https://js.stripe.com");
  assert.deepEqual(r.weaker, []);
  assert.deepEqual(r.newSources, ['script-src https://js.stripe.com']);
});

test('new image hosts are not reported', () => {
  assert.deepEqual(cmp("img-src 'self'", "img-src 'self' https://cdn.example").newSources, []);
});

test('nonce and hash churn is ignored', () => {
  const r = cmp("script-src 'nonce-aaa' 'sha256-111'", "script-src 'nonce-bbb' 'sha256-222' 'sha256-333'");
  assert.deepEqual([r.weaker, r.newSources], [[], []]);
});

test('the baseline form round-trips with nonce and hash markers', () => {
  const base = cspBaseline(parseCsp("Script-Src 'self' 'nonce-r4nd0m' https://JS.stripe.com; object-src 'none'"));
  assert.deepEqual(base, { 'object-src': ["'none'"], 'script-src': ["'nonce'", "'self'", 'https://js.stripe.com'] });
  assert.deepEqual(compareCsp(base, parseCsp("script-src 'self' 'nonce-other' https://js.stripe.com; object-src 'none'")).weaker, []);
});

test('the most specific baseline key wins per header', () => {
  const headers = { '**': { 'strict-transport-security': 'max-age=31536000', 'x-frame-options': 'DENY' }, '/checkout': { 'x-frame-options': 'SAMEORIGIN' } };
  assert.deepEqual(baselineFor(headers, '/checkout'), { 'strict-transport-security': 'max-age=31536000', 'x-frame-options': 'SAMEORIGIN' });
  assert.deepEqual(baselineFor(headers, '/'), { 'strict-transport-security': 'max-age=31536000', 'x-frame-options': 'DENY' });
});

test('HSTS removed or its max-age cut is weaker', () => {
  const base = { 'strict-transport-security': 'max-age=31536000; includeSubDomains' };
  assert.deepEqual(compareHeaders(base, {}).weaker, ['Strict-Transport-Security removed']);
  assert.deepEqual(compareHeaders(base, { 'strict-transport-security': 'max-age=300' }).weaker, ['Strict-Transport-Security max-age cut from 31536000 to 300']);
  assert.deepEqual(compareHeaders(base, { 'strict-transport-security': 'max-age=63072000' }).weaker, []);
});

test('framing protection removed is weaker, unless frame-ancestors still covers it', () => {
  const base = { 'x-frame-options': 'DENY' };
  assert.deepEqual(compareHeaders(base, {}).weaker, ['framing protection removed']);
  assert.deepEqual(compareHeaders(base, { 'content-security-policy': "frame-ancestors 'self'" }).weaker, []);
});

test('report-only CSP changes are flagged separately', () => {
  const r = compareHeaders({ 'content-security-policy-report-only': { 'script-src': ["'self'"] } }, { 'content-security-policy-report-only': "script-src 'self' https://x.example" });
  assert.equal(r.reportOnlyChanged, true);
  assert.deepEqual(r.weaker, []);
});

test('CSP comparisons flow through compareHeaders', () => {
  const r = compareHeaders({ 'content-security-policy': { 'script-src': ["'self'"] } }, { 'content-security-policy': "script-src 'self' https://chat.example" });
  assert.deepEqual(r.newCspSources, ['script-src https://chat.example']);
});

test('two CSP headers, which Chrome joins with a newline, are two policies, not one', () => {
  const p = parseCsp("script-src 'self' https://js.stripe.com\nconnect-src 'self'");
  assert.deepEqual([...p.keys()], ['script-src']);
  assert.deepEqual([...p.get('script-src')].sort(), ["'self'", 'https://js.stripe.com']);
});
