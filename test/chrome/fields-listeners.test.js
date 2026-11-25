import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openBrowser } from '../../src/capture/browser.js';
import { visitPage } from '../../src/capture/visit.js';
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

const page = (path) => ({ name: path, url: `${site.origin('shop.test')}${path}`, site: site.origin('shop.test'), path, sensitive: true, steps: [], settle: { quietMs: 800, scriptQuietMs: 1000, capMs: 15000 } });
const visit = (path) => visitPage(browser, page(path), 'desktop', { own: new Set([site.origin('shop.test')]) });

test('finds the sign-in password field with its signature', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('baseline');
  const v = await visit('/login');
  assert.deepEqual(v.fields, [{ frame: 'top', form: 'POST /login', field: 'password', kind: 'password', count: 1 }]);
});

test("finds sensitive fields in srcdoc and about:blank frames, as the page's own", async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('srcdoc-form');
  const v = await visit('/checkout');
  assert.ok(v.fields.some((f) => f.kind === 'card' && f.field === 'ccnum' && f.frame === 'top'), JSON.stringify(v.fields));
  assert.ok(v.fields.some((f) => f.kind === 'password' && f.field === 'pin' && f.frame === 'top'), JSON.stringify(v.fields));
  assert.ok(v.fields.some((f) => f.kind === 'card' && f.field === 'boxnum' && f.frame === 'top'), `a sandboxed srcdoc frame: ${JSON.stringify(v.fields)}`);
});

test('counts a second card field with the same signature', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('card-overlay');
  const v = await visit('/checkout');
  const card = v.fields.find((f) => f.kind === 'card' && f.field === 'cardnumber');
  assert.equal(card.count, 2);
  assert.equal(card.form, 'POST /pay');
  assert.ok(v.fields.some((f) => f.kind === 'card' && f.field === 'cvv'), 'a field named cvv is a card field');
});

test('records the card field kinds inside the payment iframe without tracking its scripts', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('baseline');
  const v = await visit('/checkout');
  assert.deepEqual(v.frames, [{ origin: site.origin('pay.test'), tracked: false, fieldKinds: ['card'] }]);
  assert.equal(v.scripts.some((s) => s.frame === site.origin('pay.test')), false);
  assert.equal(v.fields.length, 0, 'fields inside an untracked iframe are frame field kinds, not page fields');
});

test('attributes listeners on the field, an ancestor and the submit button to the script that added them', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('listeners');
  const v = await visit('/login');
  const bySkimmer = v.listeners.filter((l) => l.script?.url?.endsWith('/skim.js'));
  const has = (role, event) => bySkimmer.some((l) => l.kind === 'password' && l.role === role && l.event === event);
  assert.ok(has('field', 'keydown'), 'keydown on the password field');
  assert.ok(has('ancestor', 'input'), 'input listener on document.body');
  assert.ok(has('submit', 'mouseup'), 'mouseup on the submit button');
});

test('reads dns-prefetch and preconnect hosts', async (t) => {
  if (!browser) return t.skip('no Chrome');
  await site.setScenario('listeners');
  const v = await visit('/login');
  assert.deepEqual(v.linkHosts, ['pre.evil.test', 'prefetch.evil.test']);
});
