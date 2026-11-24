import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeUrl, parseDestinationPattern, matchUrl, matchPage, coversPage, matchListener, validatePattern } from '../../src/config/patterns.js';

test('*.stripe.com covers subdomains at any depth but not the bare domain', () => {
  assert.equal(matchUrl('https://*.stripe.com', 'https://a.b.stripe.com/v1/x'), true);
  assert.equal(matchUrl('https://*.stripe.com', 'https://js.stripe.com/'), true);
  assert.equal(matchUrl('https://*.stripe.com', 'https://stripe.com/'), false);
  assert.equal(matchUrl('https://*.stripe.com', 'https://evilstripe.com/'), false);
});

test('a pattern without a path covers every path; with one it must match', () => {
  assert.equal(matchUrl('https://shop.example', 'https://shop.example/any/thing'), true);
  assert.equal(matchUrl('https://shop.example/', 'https://shop.example/any'), false);
  assert.equal(matchUrl('https://shop.example/', 'https://shop.example/'), true);
});

test('* matches within one path segment and ** across segments', () => {
  assert.equal(matchUrl('https://shop.example/assets/*.js', 'https://shop.example/assets/app.js'), true);
  assert.equal(matchUrl('https://shop.example/assets/*.js', 'https://shop.example/assets/x/y.js'), false);
  assert.equal(matchUrl('https://shop.example/assets/**', 'https://shop.example/assets/x/y.js'), true);
});

test('{token} matches a build token and {version} a version', () => {
  assert.equal(matchUrl('https://shop.example/assets/main.{token}.js', 'https://shop.example/assets/main.3f2a1c9b.js'), true);
  assert.equal(matchUrl('https://shop.example/assets/main.{token}.js', 'https://shop.example/assets/main.app.js'), false);
  assert.equal(matchUrl('https://cdn.example/npm/jquery@{version}/dist/jquery.min.js', 'https://cdn.example/npm/jquery@3.8.0/dist/jquery.min.js'), true);
  assert.equal(matchUrl('https://cdn.example/npm/jquery@{version}/dist/jquery.min.js', 'https://cdn.example/npm/jquery@latest/dist/jquery.min.js'), false);
});

test('listed query parameters must match and others are ignored', () => {
  assert.equal(matchUrl('https://www.googletagmanager.com/gtm.js?id=GTM-ABC123', 'https://www.googletagmanager.com/gtm.js?id=GTM-ABC123&l=dataLayer'), true);
  assert.equal(matchUrl('https://www.googletagmanager.com/gtm.js?id=GTM-ABC123', 'https://www.googletagmanager.com/gtm.js?id=GTM-EVIL'), false);
  assert.equal(matchUrl('https://a.example/x.js?v=*', 'https://a.example/x.js?v=9'), true);
  assert.equal(matchUrl('https://a.example/x.js?v=*', 'https://a.example/x.js'), false);
});

test('account-key parameters must be listed in the pattern', () => {
  const opts = { accountKeyParams: ['tid'] };
  assert.equal(matchUrl('https://www.google-analytics.com/g/collect', 'https://www.google-analytics.com/g/collect?tid=G-EVIL&v=2', opts), false);
  assert.equal(matchUrl('https://www.google-analytics.com/g/collect?tid=G-MINE', 'https://www.google-analytics.com/g/collect?tid=G-MINE&v=2', opts), true);
});

test('http and ws, https and wss match alike', () => {
  assert.equal(matchUrl('https://*.intercom.io', 'wss://nexus-websocket-a.intercom.io/pubsub'), true);
  assert.equal(matchUrl('http://shop.test:8080', 'ws://shop.test:8080/ws'), true);
  assert.equal(matchUrl('https://shop.example', 'http://shop.example/'), false);
});

test('ports are part of the origin', () => {
  assert.equal(matchUrl('http://shop.test:8080', 'http://shop.test:9090/'), false);
  assert.equal(matchUrl('https://shop.example', 'https://shop.example:443/x'), true);
});

test('a method prefix restricts destinations', () => {
  assert.deepEqual(parseDestinationPattern('POST https://shop.example/api/login'), { method: 'POST', url: 'https://shop.example/api/login' });
  assert.deepEqual(parseDestinationPattern('https://*.stripe.com'), { method: null, url: 'https://*.stripe.com' });
});

test('page patterns use * within a segment and ** across', () => {
  assert.equal(matchPage('**', '/anything/at/all'), true);
  assert.equal(matchPage('/account/*', '/account/settings'), true);
  assert.equal(matchPage('/account/*', '/account/a/b'), false);
  assert.equal(matchPage('/blog/**', '/blog/2026/11/post'), true);
  assert.equal(matchPage('/login', '/login'), true);
  assert.equal(matchPage('/login', '/login/help'), false);
});

test('a pattern never covers a sensitive page', () => {
  assert.equal(coversPage(['**'], '/checkout', true), false);
  assert.equal(coversPage(['**', '/checkout'], '/checkout', true), true);
  assert.equal(coversPage(['/account/*'], '/account/pay', true), false);
  assert.equal(coversPage(undefined, '/about', false), true);
  assert.equal(coversPage(['/blog/**'], '/about', false), false);
});

test('listener patterns match kind, role and event, with * as a wildcard', () => {
  assert.equal(matchListener('password:field:input', { kind: 'password', role: 'field', event: 'input' }), true);
  assert.equal(matchListener('*:document:click', { kind: 'card', role: 'document', event: 'click' }), true);
  assert.equal(matchListener('*:document:click', { kind: 'card', role: 'field', event: 'click' }), false);
});

test('normalizes IDN hosts, case and default ports', () => {
  assert.equal(normalizeUrl('HTTPS://BÜCHER.example:443/A?b=1'), 'https://xn--bcher-kva.example/A?b=1');
  assert.equal(matchUrl('https://bücher.example', 'https://xn--bcher-kva.example/x'), true);
});

test('validatePattern explains what is wrong', () => {
  assert.equal(validatePattern('https://*.stripe.com', 'url'), null);
  assert.match(validatePattern('https://js.*.com/x', 'url'), /wildcard/);
  assert.match(validatePattern('https://*.com', 'url'), /too broad/);
  assert.match(validatePattern('ftp://a.example/x', 'url'), /scheme/);
  assert.equal(validatePattern('POST https://shop.example/api', 'destination'), null);
  assert.match(validatePattern('FETCH https://shop.example/api', 'destination'), /method/);
  assert.equal(validatePattern('/account/*', 'page'), null);
  assert.match(validatePattern('account', 'page'), /start with \//);
  assert.match(validatePattern('password:field', 'listener'), /kind:role:event/);
  assert.match(validatePattern('password:elsewhere:input', 'listener'), /role/);
});
