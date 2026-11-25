import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openBrowser } from '../../src/capture/browser.js';
import { visitPage } from '../../src/capture/visit.js';
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

const loginPage = () => ({ name: 'Sign in', url: `${site.origin('shop.test')}/login`, site: site.origin('shop.test'), path: '/login', sensitive: true, steps: [], settle: { quietMs: 600, scriptQuietMs: 800, capMs: 15000 } });
async function probe(scenario, { profile = 'desktop', values = probeValues() } = {}) {
  await site.setScenario(scenario);
  const visit = await visitPage(browser, loginPage(), profile, { role: 'probe', mode: 'probe', values, own: new Set([site.origin('shop.test')]) });
  return { visit, values };
}
const posts = () => site.received.filter((r) => r.method === 'POST');

test('holds every request, so the form never reaches the server', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const { visit } = await probe('probe-form');
  assert.equal(visit.probe.submitted, true);
  assert.deepEqual(posts(), []);
  assert.ok(visit.destinations.some((d) => d.phase === 'probe' && d.method === 'POST' && d.url.endsWith('/login')), 'the held form post is recorded');
});

test('catches credentials sent over a WebSocket on submit, without letting them out', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const { visit, values } = await probe('ws-exfil');
  assert.ok(visit.probe.hits.some((h) => h.kind === 'password' && h.encoding === 'raw' && h.url.startsWith('ws://evil.test')));
  assert.equal(site.wsFrames.some((f) => f.text.includes(values.password)), false, 'the frame never reached the server');
});

test('catches a send delayed by five seconds on a sensitive page', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const { visit } = await probe('delayed-send');
  assert.ok(visit.probe.hits.some((h) => h.kind === 'password' && h.url.endsWith('/c')));
});

test('catches a beacon sent when the page goes away', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const { visit } = await probe('unload-beacon');
  assert.ok(visit.probe.hits.some((h) => h.kind === 'password' && h.url.endsWith('/b')));
  assert.deepEqual(posts(), []);
});

test('finds a password kept in localStorage', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const { visit } = await probe('stash');
  assert.deepEqual(visit.probe.storage, [{ kind: 'password', where: 'localStorage' }]);
});

test('fires a trusted mouseup on the submit button on desktop', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const { visit } = await probe('mouseup-skimmer');
  assert.ok(visit.probe.hits.some((h) => h.kind === 'password' && h.encoding === 'base64' && h.url.includes('/p?d=')));
});

test('fires a trusted touchend on the submit button on mobile', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const { visit } = await probe('touchend-skimmer', { profile: 'mobile' });
  assert.ok(visit.probe.hits.some((h) => h.kind === 'password' && h.url.includes('/t?d=')));
});

test('fills the required fields so the form really submits', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const { visit, values } = await probe('required-fields');
  assert.equal(visit.probe.submitted, true);
  assert.ok(visit.probe.hits.some((h) => h.kind === 'password' && h.url.endsWith('/login')), 'the form data reached the held request');
  assert.ok(values.phone);
});

test('reads the fields again after submit, catching a card form that appears then', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const { visit } = await probe('card-overlay-after-submit');
  assert.ok(visit.fields.some((f) => f.kind === 'card' && f.form === 'POST /verify'));
});

test('names the skimmer behind a delegated handler through the code that ran during input', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const { visit } = await probe('jquery-delegated');
  assert.ok(visit.inputCode.some((r) => r.url?.endsWith('/d.js')), JSON.stringify(visit.inputCode));
  assert.ok(visit.inputCode.some((r) => r.url?.endsWith('/delegate.js')));
});

test('counts a peer connection', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const { visit } = await probe('webrtc');
  assert.ok(visit.peers >= 1);
});

test("scriptsnitch's own helper code is never reported as the page's", async (t) => {
  if (!browser) return t.skip('no Chrome');
  const { visit } = await probe('baseline');
  assert.deepEqual(visit.inputCode.filter((r) => !r.url && !r.template), [], 'no code without a URL or a creator ran during the input');
  assert.deepEqual(visit.scripts.filter((s) => s.kind === 'code' && !s.creator), []);
});

test('an iframe that came and went before the probe does not stop it', async (t) => {
  if (!browser) return t.skip('no Chrome');
  const { visit } = await probe('iframe-churn');
  assert.equal(visit.conclusive, true);
  assert.equal(visit.probe.submitted, true);
});
