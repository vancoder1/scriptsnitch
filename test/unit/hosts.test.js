import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sharedHostKind, wildcardCoversTenants, accountKey, accountKeyParams, vendorOf, registrableCandidates, isKnownTld, ownOrigins } from '../../src/analyze/hosts.js';

test('tells path-shared hosts from host-shared domains', () => {
  assert.equal(sharedHostKind('cdn.jsdelivr.net'), 'path');
  assert.equal(sharedHostKind('unpkg.com'), 'path');
  assert.equal(sharedHostKind('s3.eu-west-1.amazonaws.com'), 'path');
  assert.equal(sharedHostKind('foo.netlify.app'), 'host');
  assert.equal(sharedHostKind('a.b.cloudfront.net'), 'host');
  assert.equal(sharedHostKind('bucket.s3.eu-west-1.amazonaws.com'), 'host');
  assert.equal(sharedHostKind('shop.example'), null);
});

test('a wildcard over a shared domain covers other tenants', () => {
  assert.equal(wildcardCoversTenants('*.netlify.app'), true);
  assert.equal(wildcardCoversTenants('*.jsdelivr.net'), true);
  assert.equal(wildcardCoversTenants('*.stripe.com'), false);
  assert.equal(wildcardCoversTenants('shop.netlify.app'), false);
});

test('reads account keys from the query or the path', () => {
  assert.deepEqual(accountKey('https://www.googletagmanager.com/gtm.js?id=GTM-ABC&l=dl'), { service: 'Google Tag Manager', key: 'GTM-ABC', where: 'query', param: 'id' });
  assert.deepEqual(accountKey('https://script.google.com/macros/s/AKfy123/exec'), { service: 'Google Apps Script', key: 'AKfy123', where: 'path', param: null });
  assert.equal(accountKey('https://api.telegram.org/bot123:abc/sendMessage').key, '123:abc');
  assert.equal(accountKey('https://region1.google-analytics.com/g/collect?tid=G-EVIL&v=2').key, 'G-EVIL');
  assert.equal(accountKey('https://docs.google.com/forms/d/e/1FAIpQ/formResponse').key, '1FAIpQ');
  assert.equal(accountKey('https://shop.example/x.js?id=1'), null);
});

test('accountKeyParams names the query parameters that carry a key', () => {
  assert.deepEqual(accountKeyParams('https://www.google-analytics.com/g/collect?v=2'), ['tid']);
  assert.deepEqual(accountKeyParams('https://www.googletagmanager.com/gtm.js'), ['id']);
  assert.deepEqual(accountKeyParams('https://shop.example/api'), []);
});

test('vendor families group one company\'s domains', () => {
  assert.equal(vendorOf('www.gstatic.com'), 'Google');
  assert.equal(vendorOf('www.gstatic.com'), vendorOf('www.google.com'));
  assert.equal(vendorOf('js.stripe.com'), 'Stripe');
  assert.equal(vendorOf('shop.example'), null);
});

test('registrable-domain candidates grow one label at a time', () => {
  assert.deepEqual(registrableCandidates('cdn.evil.co.uk'), ['co.uk', 'evil.co.uk', 'cdn.evil.co.uk']);
  assert.deepEqual(registrableCandidates('evil.com'), ['evil.com']);
  assert.deepEqual(registrableCandidates('10.0.0.7'), []);
});

test('knows real top-level domains', () => {
  assert.equal(isKnownTld('com'), true);
  assert.equal(isKnownTld('click'), true);
  assert.equal(isKnownTld('xn--p1ai'), true);
  assert.equal(isKnownTld('notatld'), false);
});

test('own origins are the site plus its own list', () => {
  assert.deepEqual([...ownOrigins('https://shop.example', { own: ['https://static.shop.example'] })], ['https://shop.example', 'https://static.shop.example']);
});
