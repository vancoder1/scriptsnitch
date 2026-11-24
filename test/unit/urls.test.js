import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isBuildToken, classifyUrl, slotOf, findVolatileParams, maskParams } from '../../src/analyze/urls.js';

const buildNames = readFileSync(new URL('../fixtures/build-names.txt', import.meta.url), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

test('recognises build tokens in file names from real bundlers', () => {
  assert.ok(buildNames.length >= 40);
  for (const url of buildNames) assert.equal(classifyUrl(url, { own: true }).kind, 'hashed', url);
});

test('ordinary file names are not hashed', () => {
  for (const url of [
    'https://shop.test/js/jquery.min.js', 'https://shop.test/js/analytics.js', 'https://shop.test/main.js',
    'https://shop.test/js/bundle-legacy.js', 'https://shop.test/js/promo2024banner.js', 'https://shop.test/js/checkoutvalidation.js',
    'https://shop.test/wp-includes/js/jquery/jquery-migrate.min.js', 'https://js.stripe.com/v3/',
  ]) assert.notEqual(classifyUrl(url, { own: true }).kind, 'hashed', url);
});

test('isBuildToken wants something that looks random', () => {
  assert.equal(isBuildToken('3f2a1c9b'), true);
  assert.equal(isBuildToken('CLlpVvjr'), true);
  assert.equal(isBuildToken('deadbeef'), false); // hex without a digit reads as a word
  assert.equal(isBuildToken('analytics2024'), false);
  assert.equal(isBuildToken('abc123'), false); // too short
});

test('own path versions are versioned, third-party query versions float', () => {
  const own = classifyUrl('https://shop.example/js/modernizr-2.6.2.min.js', { own: true });
  assert.equal(own.kind, 'versioned');
  assert.equal(own.version, '2.6.2');
  assert.equal(classifyUrl('https://cdn.example/npm/jquery@3.7.1/dist/jquery.min.js', { own: false }).version, '3.7.1');
  assert.equal(classifyUrl('https://cdn.example/libs/lib/1.2.3/lib.js', { own: false }).kind, 'versioned');
  assert.equal(classifyUrl('https://connect.facebook.net/signals/config/1?v=2.9.1', { own: false }).kind, 'floating');
  const wp = classifyUrl('https://shop.example/wp-content/plugins/x/x.js?ver=6.4.2', { own: true });
  assert.equal(wp.kind, 'floating');
  assert.equal(wp.queryVersion, '6.4.2');
});

test('major-only versions count as floating', () => {
  assert.equal(classifyUrl('https://cdn.example/npm/jquery@3/dist/jquery.min.js', { own: false }).kind, 'floating');
  assert.equal(classifyUrl('https://js.stripe.com/v3/', { own: false }).kind, 'floating');
});

test('blob, data and wasm scripts are code without a URL', () => {
  assert.equal(classifyUrl('blob:https://shop.example/550e8400-e29b-41d4-a716-446655440000', { own: true }).kind, 'code');
  assert.equal(classifyUrl('data:text/javascript,alert(1)', { own: false }).kind, 'code');
  assert.equal(classifyUrl('wasm://wasm/0012abcd', { own: false }).kind, 'code');
});

test('slots replace build tokens and versions with placeholders', () => {
  const a = 'https://shop.example/assets/main.3f2a1c9b.js';
  const b = 'https://shop.example/assets/main.9e8d7c6b.js';
  assert.equal(slotOf(a, classifyUrl(a, { own: true })), 'https://shop.example/assets/main.{token}.js');
  assert.equal(slotOf(a, classifyUrl(a, { own: true })), slotOf(b, classifyUrl(b, { own: true })));
  const j = 'https://cdn.example/npm/jquery@3.7.1/dist/jquery.min.js';
  assert.equal(slotOf(j, classifyUrl(j, { own: false })), 'https://cdn.example/npm/jquery@{version}/dist/jquery.min.js');
  const v = 'https://cdn.example/npm/jquery@3.8.0/dist/jquery.min.js';
  assert.equal(slotOf(j, classifyUrl(j, { own: false })), slotOf(v, classifyUrl(v, { own: false })));
  const wp = 'https://shop.example/x.js?ver=6.4.2&a=1';
  assert.equal(slotOf(wp, classifyUrl(wp, { own: true })), 'https://shop.example/x.js?a=1&ver={version}');
});

test('finds per-visit query parameters by comparing two visits', () => {
  const vol = findVolatileParams(['https://tags.example/x.js?cb=1&id=GTM-1', 'https://a.example/y.js?t=5'], ['https://tags.example/x.js?cb=2&id=GTM-1', 'https://a.example/y.js?t=5']);
  assert.deepEqual([...vol].sort(), ['https://tags.example/x.js#cb']);
});

test('maskParams removes the per-visit parameters of that path only', () => {
  const vol = new Set(['https://tags.example/x.js#cb']);
  assert.equal(maskParams('https://tags.example/x.js?cb=7&id=GTM-1', vol), 'https://tags.example/x.js?id=GTM-1');
  assert.equal(maskParams('https://other.example/x.js?cb=7', vol), 'https://other.example/x.js?cb=7');
});
