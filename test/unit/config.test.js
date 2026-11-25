import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, ConfigError } from '../../src/config/config.js';

const minimal = { pages: [{ name: 'Home', url: 'https://shop.example/' }] };
const parse = (obj) => parseConfig(JSON.stringify(obj), 'scriptsnitch/config.json');
const pointerOf = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof ConfigError, e.message); return e.pointer; } assert.fail('expected a ConfigError'); };

test('applies the documented defaults', () => {
  const c = parse(minimal);
  assert.equal(c.approved, 'scriptsnitch/approved.json');
  assert.deepEqual(c.notify, []);
  assert.deepEqual(c.profiles, ['desktop', 'mobile']);
  assert.deepEqual(c.block, ['image', 'media', 'font']);
  assert.equal(c.concurrency, 4);
  assert.equal(c.requireReasons, true);
  assert.equal(c.frames, 'own');
  assert.equal(c.consent, 'accept');
  const p = c.pages[0];
  assert.equal(p.site, 'https://shop.example');
  assert.equal(p.path, '/');
  assert.equal(p.sensitive, false);
  assert.equal(p.probe, 'auto');
  assert.equal(p.expect, null);
  assert.deepEqual(p.steps, []);
  assert.equal(p.consent, 'accept');
  assert.deepEqual(p.settle, { quietMs: 1000, scriptQuietMs: 1500, capMs: 15000 });
});

test('a page can name its site and override settling', () => {
  const c = parse({ pages: [{ name: 'Sign in', url: 'https://auth.shop.example/login', site: 'https://shop.example', settle: { capMs: 20000 } }] });
  assert.equal(c.pages[0].site, 'https://shop.example');
  assert.deepEqual(c.pages[0].settle, { quietMs: 1000, scriptQuietMs: 1500, capMs: 20000 });
});

test('two pages of one site that differ only in their query are refused, not merged', () => {
  const pages = [{ name: 'Home', url: 'https://shop.example/index.php?route=common/home' }, { name: 'Checkout', url: 'https://shop.example/index.php?route=checkout/checkout', sensitive: true }];
  assert.equal(pointerOf(() => parse({ pages })), '/pages/1/url');
  assert.doesNotThrow(() => parse({ pages: [pages[0], { name: 'Other site', url: 'https://other.example/index.php?route=x' }] }));
});

test('notify takes user names and teams as org/team, nothing else', () => {
  assert.deepEqual(parse({ ...minimal, notify: ['octocat', 'acme/security-team'] }).notify, ['octocat', 'acme/security-team']);
  for (const bad of ['@octocat', 'a/b/c', 'acme/', 'two words']) assert.equal(pointerOf(() => parse({ ...minimal, notify: [bad] })), '/notify/0', bad);
});

test('rejects unknown fields with a pointer to them', () => {
  assert.equal(pointerOf(() => parse({ pages: [{ name: 'x', url: 'https://a.example/', sensitiv: true }] })), '/pages/0/sensitiv');
  assert.equal(pointerOf(() => parse({ ...minimal, concurency: 2 })), '/concurency');
});

test('rejects a step with two actions or with none', () => {
  assert.equal(pointerOf(() => parse({ pages: [{ name: 'x', url: 'https://a.example/', steps: [{ goto: 'https://a.example/a', click: '#b' }] }] })), '/pages/0/steps/0');
  assert.equal(pointerOf(() => parse({ pages: [{ name: 'x', url: 'https://a.example/', steps: [{}] }] })), '/pages/0/steps/0');
});

test('rejects a type step without value, secret or totp', () => {
  assert.equal(pointerOf(() => parse({ pages: [{ name: 'x', url: 'https://a.example/', steps: [{ type: '#email' }] }] })), '/pages/0/steps/0');
  const c = parse({ pages: [{ name: 'x', url: 'https://a.example/', steps: [{ type: '#otp', totp: 'OTP_SEED' }, { wait: 500 }, { wait: '#done' }] }] });
  assert.deepEqual(c.pages[0].steps, [{ type: '#otp', totp: 'OTP_SEED' }, { wait: 500 }, { wait: '#done' }]);
});

test('rejects duplicate page names', () => {
  assert.equal(pointerOf(() => parse({ pages: [{ name: 'Home', url: 'https://a.example/' }, { name: 'Home', url: 'https://a.example/x' }] })), '/pages/1/name');
});

test('rejects plain http except for local test hosts', () => {
  assert.equal(pointerOf(() => parse({ pages: [{ name: 'x', url: 'http://shop.example/' }] })), '/pages/0/url');
  assert.equal(parse({ pages: [{ name: 'x', url: 'http://shop.test:8080/' }] }).pages[0].site, 'http://shop.test:8080');
  assert.equal(parse({ pages: [{ name: 'x', url: 'http://localhost:3000/' }] }).pages[0].path, '/');
  assert.equal(parse({ pages: [{ name: 'x', url: 'http://shop.localhost:8123/' }] }).pages[0].site, 'http://shop.localhost:8123');
});

test('expect is a selector or a text, never both', () => {
  assert.deepEqual(parse({ pages: [{ name: 'x', url: 'https://a.example/', expect: { selector: '#main' } }] }).pages[0].expect, { selector: '#main' });
  assert.equal(pointerOf(() => parse({ pages: [{ name: 'x', url: 'https://a.example/', expect: { selector: '#a', text: 'b' } }] })), '/pages/0/expect');
});

test('a deploy marker is a URL or a page attribute', () => {
  const c = parse({ ...minimal, sites: { 'https://shop.example': { deployMarker: { page: '/', selector: 'meta[name=build]', attribute: 'content' } } } });
  assert.deepEqual(c.sites['https://shop.example'].deployMarker, { page: '/', selector: 'meta[name=build]', attribute: 'content' });
  assert.equal(pointerOf(() => parse({ ...minimal, sites: { 'https://shop.example': { deployMarker: { selector: 'x' } } } })), '/sites/https:~1~1shop.example/deployMarker');
});

test('loads with a BOM and CRLF, and names the line of a syntax error', () => {
  const c = parseConfig('﻿{\r\n  "pages": [{"name": "Home", "url": "https://shop.example/"}]\r\n}\r\n', 'config.json');
  assert.equal(c.pages.length, 1);
  assert.throws(() => parseConfig('{\n  "pages": [],\n}', 'config.json'), (e) => e instanceof ConfigError && /line 3/.test(e.message));
});

test('needs at least one page', () => {
  assert.equal(pointerOf(() => parse({ pages: [] })), '/pages');
});

test('plain http is refused for look-alike hosts', () => {
  for (const url of ['http://127x0x0x1/', 'http://shoptest/', 'http://1/', 'http://evil-localhost.example/']) assert.equal(pointerOf(() => parse({ pages: [{ name: 'x', url }] })), '/pages/0/url', url);
});
