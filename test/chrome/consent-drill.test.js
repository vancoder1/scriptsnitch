import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openBrowser } from '../../src/capture/browser.js';
import { visitPage } from '../../src/capture/visit.js';
import { DRILL_ORIGIN } from '../../src/capture/drill.js';
import { probeValues } from '../../src/analyze/probe-match.js';
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

const page = (path, extra = {}) => ({ name: path, url: `${site.origin('shop.test')}${path}`, site: site.origin('shop.test'), path, sensitive: false, steps: [], consent: 'accept', settle: { quietMs: 600, scriptQuietMs: 800, capMs: 15000 }, ...extra });

test('accepts a OneTrust-style banner and sees the tags that load after consent', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('consent-onetrust');
  const v = await visitPage(browser, page('/'), 'desktop', { own: new Set([site.origin('shop.test')]) });
  assert.deepEqual(v.consent, { found: 'OneTrust', accepted: true });
  assert.ok(v.scripts.some((s) => s.ref.url?.endsWith('/marketing.js')), 'the marketing tag loaded after consent');
});

test('notes a banner it could not accept', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('consent-broken');
  const v = await visitPage(browser, page('/'), 'desktop', { own: new Set([site.origin('shop.test')]) });
  assert.deepEqual(v.consent, { found: 'OneTrust', accepted: false });
});

test('consent "ignore" leaves the banner alone', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('consent-onetrust');
  const v = await visitPage(browser, page('/', { consent: 'ignore' }), 'desktop', { own: new Set([site.origin('shop.test')]) });
  assert.deepEqual(v.consent, { found: null, accepted: false });
  assert.equal(v.scripts.some((s) => s.ref.url?.endsWith('/marketing.js')), false);
});

test('a drill visit records the drill skimmer, its listener and its exfiltration, inside the browser only', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('baseline');
  const v = await visitPage(browser, page('/login', { sensitive: true }), 'desktop', { role: 'drill', mode: 'probe', drill: true, values: probeValues(), own: new Set([site.origin('shop.test')]) });
  assert.ok(v.scripts.some((s) => s.ref.url?.startsWith(DRILL_ORIGIN)), 'the drill script ran');
  assert.ok(v.listeners.some((l) => l.script?.url?.startsWith(DRILL_ORIGIN) && l.kind === 'password'), 'its listener was seen');
  assert.ok(v.probe.hits.some((h) => h.url.startsWith(DRILL_ORIGIN)), 'its exfiltration was caught');
  assert.equal(site.received.some((r) => r.method === 'POST'), false, 'nothing was submitted to the site');
});

test('the drill runs on a page whose CSP is set in a meta tag', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('meta-csp');
  const v = await visitPage(browser, page('/login', { sensitive: true }), 'desktop', { role: 'drill', mode: 'probe', drill: true, values: probeValues(), own: new Set([site.origin('shop.test')]) });
  assert.ok(v.scripts.some((s) => s.ref.url?.startsWith(DRILL_ORIGIN)), 'the drill script ran');
  assert.ok(v.probe.hits.some((h) => h.url.startsWith(DRILL_ORIGIN)), 'its exfiltration was caught');
});
