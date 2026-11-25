import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect } from '../../src/modes/collect.js';
import { parseConfig } from '../../src/config/config.js';
import { emptyApproved } from '../../src/config/approved.js';
import { validateSnapshot } from '../../src/snapshot.js';
import { startDemoSite } from '../fixtures/site/server.js';
import { demoChromeArgs } from '../helpers/browser.js';
import { requireChrome } from '../helpers/chrome.js';

let site;
let executable;
before(async (t) => {
  executable = requireChrome(t);
  if (!executable) return;
  site = await startDemoSite();
});
after(async () => { await site?.close(); });

const config = (pages, extra = {}) => parseConfig(JSON.stringify({ pages, concurrency: 2, ...extra }), 'config.json');
const home = () => ({ name: 'Home', url: `${site.origin('shop.test')}/` });
const run = (cfg, opts = {}) => collect({ config: cfg, approved: emptyApproved(), outDir: mkdtempSync(join(tmpdir(), 'ss-out-')), executable, extraArgs: demoChromeArgs(site.port), ...opts });

test('writes a valid snapshot with visits A and B for each profile', async (t) => {
  if (!executable) return t.skip('no Chrome');
  await site.setScenario('baseline');
  const outDir = mkdtempSync(join(tmpdir(), 'ss-out-'));
  const snap = await collect({ config: config([home()]), approved: emptyApproved(), outDir, executable, extraArgs: demoChromeArgs(site.port) });
  const onDisk = validateSnapshot(JSON.parse(readFileSync(join(outDir, 'snapshot.json'), 'utf8')));
  assert.deepEqual(onDisk.pages.map((p) => p.name), ['Home']);
  for (const profile of ['desktop', 'mobile']) {
    assert.deepEqual(snap.pages[0].profiles[profile].visits.map((v) => v.role), ['A', 'B']);
    assert.equal(snap.pages[0].profiles[profile].conclusive, true);
  }
  const lib = snap.pages[0].profiles.desktop.visits[0].scripts.find((s) => s.ref.url?.includes('lib.min.js'));
  assert.ok(existsSync(join(outDir, snap.evidence[lib.ref.contentHash].file)), 'evidence for an unapproved script');
});

test('masks per-visit query parameters so both visits name the script the same way', async (t) => {
  if (!executable) return t.skip('no Chrome');
  await site.setScenario('cache-buster');
  const snap = await run(config([home()], { profiles: ['desktop'] }));
  const urls = snap.pages[0].profiles.desktop.visits.map((v) => v.scripts.find((s) => s.ref.url?.includes('widget.js')).ref.url);
  assert.equal(urls[0], urls[1]);
  assert.equal(new URL(urls[0]).searchParams.has('cb'), false);
  assert.equal(new URL(urls[0]).searchParams.get('id'), 'W1');
});

test('a sourceURL name gives no identity, and inline scripts stay inline after replaceState', async (t) => {
  if (!executable) return t.skip('no Chrome');
  await site.setScenario('source-url');
  const snap = await run(config([home()], { profiles: ['desktop'] }));
  const scripts = snap.pages[0].profiles.desktop.visits[0].scripts;
  const lib = scripts.filter((s) => s.ref.url?.endsWith('/lib.min.js'));
  assert.equal(lib.length, 1, 'only the real library carries its URL');
  assert.equal(lib[0].kind, 'external');
  assert.ok(!scripts.some((s) => s.ref.url && !/^https?:/.test(s.ref.url)), 'no script is named by a bundler-style sourceURL');
  assert.ok(!scripts.some((s) => s.kind === 'external' && s.ref.url?.includes('shop.test') && !s.ref.url.includes('/assets/')), 'no inline script is taken for an own file');
  assert.ok(scripts.filter((s) => s.kind === 'inline').length >= 5);
});

test('makes a confirmation visit when something unapproved appears in only one visit', async (t) => {
  if (!executable) return t.skip('no Chrome');
  await site.setScenario('intermittent');
  const snap = await run(config([home()], { profiles: ['desktop'] }));
  assert.deepEqual(snap.pages[0].profiles.desktop.visits.map((v) => v.role), ['A', 'B', 'confirm']);
});

test('marks a bot challenge inconclusive and still writes the snapshot', async (t) => {
  if (!executable) return t.skip('no Chrome');
  await site.setScenario('challenge');
  const snap = await run(config([home()], { profiles: ['desktop'] }));
  const p = snap.pages[0].profiles.desktop;
  assert.equal(p.conclusive, false);
  assert.match(p.reason, /answered 403|bot challenge/);
});

test('judges a redirected page at its final URL under the configured path', async (t) => {
  if (!executable) return t.skip('no Chrome');
  await site.setScenario('redirect');
  const snap = await run(config([home()], { profiles: ['desktop'] }));
  assert.equal(snap.pages[0].path, '/');
  assert.equal(snap.pages[0].profiles.desktop.conclusive, true);
  assert.match(snap.pages[0].profiles.desktop.visits[0].document.finalUrl, /\/en\/$/);
});

test('relaunches Chrome once after it crashes and finishes the run', async (t) => {
  if (!executable) return t.skip('no Chrome');
  await site.setScenario('baseline');
  let launches = 0;
  const snap = await run(config([home(), { name: 'Sign in', url: `${site.origin('shop.test')}/login` }], { profiles: ['desktop'], concurrency: 1 }), {
    onBrowser: (browser) => {
      launches++;
      if (launches === 1) setTimeout(() => browser.process.kill('SIGKILL'), 300);
    },
  });
  assert.equal(launches, 2);
  assert.equal(snap.pages.every((p) => p.profiles.desktop.conclusive), true);
});

test('probes sensitive pages, twice on desktop, and catches an encrypted payload by its growth', async (t) => {
  if (!executable) return t.skip('no Chrome');
  await site.setScenario('encrypted-exfil');
  const snap = await run(config([{ name: 'Sign in', url: `${site.origin('shop.test')}/login`, sensitive: true }], { profiles: ['desktop'] }));
  const visits = snap.pages[0].profiles.desktop.visits;
  assert.deepEqual(visits.map((v) => v.role), ['A', 'B', 'probe', 'probe2']);
  const probe2 = visits.find((v) => v.role === 'probe2');
  assert.deepEqual(probe2.probe.growth, [{ url: `${site.origin('evil.test')}/e`, field: 'd' }]);
  assert.deepEqual(probe2.probe.hits, [], 'the encrypted payload holds no probe value');
});

test('probes a page with a password field once per profile when it is not sensitive', async (t) => {
  if (!executable) return t.skip('no Chrome');
  await site.setScenario('probe-form');
  const snap = await run(config([{ name: 'Sign in', url: `${site.origin('shop.test')}/login` }]));
  assert.deepEqual(snap.pages[0].profiles.desktop.visits.map((v) => v.role), ['A', 'B', 'probe']);
  assert.deepEqual(snap.pages[0].profiles.mobile.visits.map((v) => v.role), ['A', 'B', 'probe']);
});

test('runs a drill visit on sensitive pages when asked, and keeps drill code out of the evidence', async (t) => {
  if (!executable) return t.skip('no Chrome');
  await site.setScenario('baseline');
  const snap = await run(config([{ name: 'Sign in', url: `${site.origin('shop.test')}/login`, sensitive: true }], { profiles: ['desktop'] }), { drill: true });
  const roles = snap.pages[0].profiles.desktop.visits.map((v) => v.role);
  assert.ok(roles.includes('drill'), roles.join(','));
  assert.equal(snap.run.drill, true);
  assert.equal(Object.values(snap.evidence).some((e) => e.url?.includes('drill.scriptsnitch.invalid')), false);
});

test('lists the own scripts that name a hashed own file', async (t) => {
  if (!executable) return t.skip('no Chrome');
  await site.setScenario('baseline');
  const snap = await run(config([home()], { profiles: ['desktop'] }));
  const scripts = snap.pages[0].profiles.desktop.visits[0].scripts;
  assert.deepEqual(scripts.find((s) => s.ref.url?.endsWith('/chunk-Dq9Wn3Lp.js')).referencedBy.map((u) => new URL(u).pathname), ['/assets/index-B7kQ0aRz.js']);
  assert.deepEqual(scripts.find((s) => s.ref.url?.endsWith('/index-B7kQ0aRz.js')).referencedBy, []);
});

test('step secrets are redacted from the snapshot by value', async (t) => {
  if (!executable) return t.skip('no Chrome');
  await site.setScenario('secret-echo');
  const origin = site.origin('shop.test');
  const cfg = config([{ name: 'Home', url: `${origin}/`, steps: [{ goto: `${origin}/login` }, { type: '#user', secret: 'SHOP_USER' }, { click: '#go' }] }], { profiles: ['desktop'] });
  const outDir = mkdtempSync(join(tmpdir(), 'ss-out-'));
  await collect({ config: cfg, approved: emptyApproved(), outDir, executable, extraArgs: demoChromeArgs(site.port), env: { ...process.env, SHOP_USER: 'demo-user-123' } });
  const text = readFileSync(join(outDir, 'snapshot.json'), 'utf8');
  assert.ok(text.includes('/api/me?u=[redacted]') || text.includes('/api/me?u=%5Bredacted%5D'), 'the request URL is in the snapshot, redacted');
  assert.ok(!text.includes('demo-user-123'));
});
