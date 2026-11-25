import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openBrowser } from '../../src/capture/browser.js';
import { visitPage } from '../../src/capture/visit.js';
import { totp } from '../../src/util/totp.js';
import { startDemoSite } from '../fixtures/site/server.js';
import { demoChromeArgs } from '../helpers/browser.js';
import { requireChrome } from '../helpers/chrome.js';

let site;
let browser;
before(async (t) => {
  const executable = requireChrome(t);
  if (!executable) return;
  site = await startDemoSite();
  browser = await openBrowser({ executable, extraArgs: demoChromeArgs(site.port) });
});
after(async () => {
  await browser?.close();
  await site?.close();
});

const page = (path, extra = {}) => ({ name: path, url: `${site.origin('shop.test')}${path}`, site: site.origin('shop.test'), path, sensitive: false, steps: [], settle: { quietMs: 1000, scriptQuietMs: 1500, capMs: 15000 }, ...extra });

test('settles quickly on a page with a long-polling request', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('long-poll');
  const started = Date.now();
  const visit = await visitPage(browser, page('/'), 'desktop', { own: new Set([site.origin('shop.test')]) });
  assert.ok(Date.now() - started < 9000, `took ${Date.now() - started} ms`);
  assert.equal(visit.conclusive, true);
});

test('runs the steps, then judges only the page itself', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('baseline');
  const steps = [{ goto: `${site.origin('shop.test')}/product/1` }, { click: '#add-to-cart' }];
  const visit = await visitPage(browser, page('/checkout', { steps }), 'desktop', { own: new Set([site.origin('shop.test')]) });
  assert.equal(new URL(visit.document.finalUrl).pathname, '/checkout');
  const sources = [...visit.sources.values()].map((s) => s.source);
  assert.equal(sources.some((s) => s.includes('productPageOnly')), false, 'scripts of step pages are not judged');
  assert.ok(site.received.some((r) => r.path === '/product/1'), 'the step page was visited');
});

test('types a one-time code from a seed in the environment', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('otp');
  const seed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const steps = [{ goto: `${site.origin('shop.test')}/otp` }, { type: '#otp', totp: 'DEMO_TOTP' }, { click: '#verify' }, { wait: '#done' }];
  const before = Date.now();
  await visitPage(browser, page('/', { steps }), 'desktop', { own: new Set([site.origin('shop.test')]), env: { DEMO_TOTP: seed } });
  const post = site.received.find((r) => r.method === 'POST' && r.path === '/otp');
  assert.ok(post, 'the code was submitted');
  const sent = new URLSearchParams(post.body).get('otp');
  assert.ok([totp(seed, before), totp(seed, Date.now())].includes(sent), `sent ${sent}`);
});

test('a missing step selector makes the visit inconclusive and says which step', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('baseline');
  const steps = [{ goto: `${site.origin('shop.test')}/product/1` }, { click: '#no-such-button' }];
  const visit = await visitPage(browser, page('/checkout', { steps }), 'desktop', { own: new Set([site.origin('shop.test')]) });
  assert.equal(visit.conclusive, false);
  assert.match(visit.reason, /step 2/);
});

test('applies the mobile profile to the page', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('baseline');
  await visitPage(browser, page('/'), 'mobile', { own: new Set([site.origin('shop.test')]) });
  const home = site.received.find((r) => r.host === 'shop.test' && r.path === '/');
  assert.match(home.userAgent, /Android 14/);
  assert.doesNotMatch(home.userAgent, /HeadlessChrome/);
});

test('a page whose renderer stops answering ends the visit at its deadline', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('hang');
  const started = Date.now();
  await assert.rejects(visitPage(browser, page('/'), 'desktop', { own: new Set([site.origin('shop.test')]), deadlineMs: 4000 }), /stopped answering/);
  assert.ok(Date.now() - started < 45000, `took ${Date.now() - started} ms`);
});
