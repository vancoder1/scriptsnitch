import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openBrowser } from '../../src/capture/browser.js';
import { visitPage } from '../../src/capture/visit.js';
import { sha256Hex } from '../../src/util/hash.js';
import { startDemoSite } from '../fixtures/site/server.js';
import { demoChromeArgs } from '../helpers/browser.js';
import { requireChrome } from '../helpers/chrome.js';

let site;
let browser;
const sent = [];

before(async (t) => {
  const executable = requireChrome(t);
  if (!executable) return;
  site = await startDemoSite();
  await site.setScenario('baseline');
  browser = await openBrowser({ executable, extraArgs: demoChromeArgs(site.port) });
  const send = browser.conn.send;
  browser.conn.send = (method, params, sessionId) => { sent.push(method); return send(method, params, sessionId); };
});

after(async () => {
  await browser?.close();
  await site?.close();
});

const homePage = () => ({ name: 'Home', url: `${site.origin('shop.test')}/`, site: site.origin('shop.test'), path: '/', sensitive: false, steps: [], settle: { quietMs: 1000, scriptQuietMs: 1500, capMs: 15000 } });

test('records external, inline and injected scripts with their identities', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const visit = await visitPage(browser, homePage(), 'desktop', { own: new Set([site.origin('shop.test')]) });
  const lib = visit.scripts.find((s) => s.ref.url?.endsWith('/lib@1.2.3/lib.min.js'));
  assert.equal(lib.kind, 'external');
  assert.equal(lib.ref.contentHash, sha256Hex('window.lib={version:"1.2.3",ready:!0};'));
  assert.equal(lib.creator, null);
  assert.match(lib.sri, /^sha384-/);
  const inline = visit.scripts.find((s) => s.kind === 'inline');
  assert.match(inline.ref.template, /^[0-9a-f]{64}$/);
  assert.equal(inline.ref.url, null);
  const tag = visit.scripts.find((s) => s.kind === 'code' && s.creator?.url?.includes('/gtm.js'));
  assert.ok(tag, 'the inline tag injected by gtm.js is code attributed to gtm.js');
  const gtm = visit.scripts.find((s) => s.ref.url?.includes('/gtm.js'));
  assert.equal(gtm.createsCode, true);
  const chunk = visit.scripts.find((s) => s.ref.url?.endsWith('/assets/chunk-Dq9Wn3Lp.js'));
  assert.equal(chunk.kind, 'external');
  assert.match(chunk.creator.url, /index-B7kQ0aRz\.js$/);
});

test('records destinations with the script that made them', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const visit = await visitPage(browser, homePage(), 'desktop', { own: new Set([site.origin('shop.test')]) });
  const ping = visit.destinations.find((d) => d.url.endsWith('/api/ping'));
  assert.equal(ping.method, 'GET');
  assert.equal(ping.phase, 'load');
  assert.match(ping.initiator.url, /index-B7kQ0aRz\.js$/);
  assert.equal(visit.destinations.some((d) => d.url.endsWith('.js')), false, 'script loads are not destinations');
});

test('keeps the final document status and headers', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const visit = await visitPage(browser, homePage(), 'desktop', { own: new Set([site.origin('shop.test')]) });
  assert.equal(visit.document.status, 200);
  assert.equal(visit.document.headers['x-frame-options'], 'DENY');
  assert.equal(visit.document.finalUrl, `${site.origin('shop.test')}/`);
});

test('never enables Runtime, Console or Log on page sessions', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await visitPage(browser, homePage(), 'desktop', { own: new Set([site.origin('shop.test')]) });
  assert.deepEqual(sent.filter((m) => ['Runtime.enable', 'Console.enable', 'Log.enable'].includes(m)), []);
});
