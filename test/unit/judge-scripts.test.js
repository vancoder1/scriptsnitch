import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge } from '../../src/analyze/judge.js';
import { findingKey } from '../../src/analyze/keys.js';
import { SITE, H, ext, inline, visit, snapshot, entry, approved, config, state } from '../helpers/snapshots.js';
import { ownKey } from '../../src/state.js';

const run = (snap, appr, st = state()) => judge({ snapshot: snap, approved: appr, config: config(snap.pages.map((p) => ({ path: p.path, sensitive: p.sensitive }))), state: st, now: Date.UTC(2026, 10, 24) });
const kinds = (r) => r.findings.map((f) => `${f.kind}:${f.severity}`).sort();
const one = (path, observed, extra = {}) => snapshot([{ path, observed, ...extra }]);
const JQ = 'https://cdn.example/npm/jquery@3.7.1/dist/jquery.min.js';
const jqEntry = entry({ id: 'jq', match: JQ, trust: 'exact', sha256: [H(JQ)] });

test('an approved exact script raises nothing', () => {
  assert.deepEqual(kinds(run(one('/', { scripts: [ext(JQ)] }), approved({ scripts: [jqEntry] }))), []);
});

test('new-origin is High for a script from an unapproved origin', () => {
  const r = run(one('/', { scripts: [ext('https://evil.example/x.js')] }), approved({ scripts: [jqEntry] }));
  assert.deepEqual(kinds(r), ['new-origin:high']);
  assert.equal(r.findings[0].key, findingKey('new-origin', 'https://evil.example/x.js', '*'));
});

test('new-origin is High for a new slot on a path-shared host', () => {
  const r = run(one('/', { scripts: [ext(JQ), ext('https://cdn.jsdelivr.net/gh/evil/x@1/x.js')] }), approved({ scripts: [entry({ id: 'jsd', match: 'https://cdn.jsdelivr.net/npm/a@1.0.0/a.js', trust: 'exact', sha256: [H('a')] }), jqEntry] }));
  assert.deepEqual(kinds(r), ['new-origin:high']);
});

test('new-origin is High for a new account key on an approved service', () => {
  const mine = 'https://www.googletagmanager.com/gtm.js?id=GTM-MINE';
  const r = run(one('/', { scripts: [ext(mine), ext('https://www.googletagmanager.com/gtm.js?id=GTM-EVIL')] }), approved({ scripts: [entry({ id: 'gtm', match: mine, trust: 'origin' })] }));
  assert.deepEqual(kinds(r), ['new-origin:high']);
  assert.match(r.findings[0].subject, /GTM-EVIL/);
});

test('an account key given twice, or hidden by percent-encoding, is still a new account', () => {
  const mine = 'https://www.googletagmanager.com/gtm.js?id=GTM-MINE';
  const appr = approved({ scripts: [entry({ id: 'gtm', match: mine, trust: 'origin' })] });
  const twice = run(one('/', { scripts: [ext(mine), ext('https://www.googletagmanager.com/gtm.js?id=GTM-MINE&id=GTM-EVIL')] }), appr);
  assert.deepEqual(kinds(twice), ['new-origin:high']);
  assert.match(twice.findings[0].subject, /GTM-EVIL/);
  assert.deepEqual(kinds(run(one('/', { scripts: [ext(mine), ext('https://www.googletagmanager.com/%67tm.js?id=GTM-EVIL')] }), appr)), ['new-origin:high']);
  assert.deepEqual(kinds(run(one('/', { scripts: [ext('https://www.googletagmanager.com/%67tm.js?id=GTM-MINE')] }), appr)), [], 'the same file, written another way');
});

test('new-slot is Medium at an approved origin', () => {
  const r = run(one('/', { scripts: [ext('https://chat.example/widget.js'), ext('https://chat.example/extra.js')] }), approved({ scripts: [entry({ id: 'chat', match: 'https://chat.example/widget.js', trust: 'origin' })] }));
  assert.deepEqual(kinds(r), ['new-slot:medium']);
});

test('scope is Medium for an approved script newly on a sensitive page', () => {
  const r = run(one('/checkout', { scripts: [ext(JQ)] }, { sensitive: true }), approved({ scripts: [jqEntry] }));
  assert.deepEqual(kinds(r), ['scope:medium']);
  assert.equal(r.findings[0].page, '/checkout');
});

test('new-version is Medium for an exact third-party upgrade', () => {
  const v380 = JQ.replace('3.7.1', '3.8.0');
  const r = run(one('/', { scripts: [ext(v380)] }), approved({ scripts: [jqEntry] }));
  assert.deepEqual(kinds(r), ['new-version:medium']);
  assert.match(r.findings[0].reasons.join(' '), /3\.7\.1.*3\.8\.0/);
});

test('content-mismatch is High at an approved exact URL, including two unapproved variants in visits A and B', () => {
  assert.deepEqual(kinds(run(one('/', { scripts: [ext(JQ, { hash: H('tampered') })] }), approved({ scripts: [jqEntry] }))), ['content-mismatch:high']);
  const snap = snapshot([{ path: '/', visits: [visit({ role: 'A', scripts: [ext(JQ, { hash: H('v1') })] }), visit({ role: 'B', scripts: [ext(JQ, { hash: H('v2') })] })] }]);
  const r = run(snap, approved({ scripts: [jqEntry] }));
  assert.deepEqual(kinds(r), ['content-mismatch:high']);
  assert.equal(r.findings[0].evidence.length, 2);
});

test('in-place-change is High at an unchanged hashed name and at an own path-versioned URL', () => {
  const own = approved({ scripts: [entry({ id: 'build', match: `${SITE}/assets/*.{token}.js`, trust: 'deploy' }), entry({ id: 'mz', match: `${SITE}/js/modernizr-{version}.min.js`, trust: 'deploy' })] });
  const st = state();
  st.sites[SITE] = { entrySlots: {}, marker: null, ownHashes: { [ownKey(`${SITE}/assets/main.3f2a1c9b.js`)]: H('old').slice(0, 12), [ownKey(`${SITE}/js/modernizr-2.6.2.min.js`)]: H('mz-old').slice(0, 12) }, inline: {}, deployTokens: [], seen: {}, domains: {}, domainCheck: null };
  const r = run(one('/', { scripts: [ext(`${SITE}/assets/main.3f2a1c9b.js`, { hash: H('new') }), ext(`${SITE}/js/modernizr-2.6.2.min.js`, { hash: H('mz-skimmer') })] }), own, st);
  assert.deepEqual(kinds(r), ['in-place-change:high', 'in-place-change:high']);
});

test('an own file loaded with an extra query parameter is still the same file', () => {
  const own = approved({ scripts: [entry({ id: 'mz', match: `${SITE}/js/modernizr-{version}.min.js`, trust: 'deploy', pages: ['**', '/checkout'] }), entry({ id: 'app', match: `${SITE}/js/app.js`, trust: 'deploy', pages: ['**', '/checkout'] })] });
  const st = state();
  st.sites[SITE] = { entrySlots: {}, marker: null, ownHashes: { [ownKey(`${SITE}/js/modernizr-2.6.2.min.js`)]: H('mz-old').slice(0, 12), [ownKey(`${SITE}/js/app.js`)]: H('app-old').slice(0, 12) }, inline: {}, deployTokens: [], seen: {}, domains: {}, domainCheck: null };
  const r = run(one('/checkout', { scripts: [ext(`${SITE}/js/modernizr-2.6.2.min.js?x=1`, { hash: H('mz-skimmer') }), ext(`${SITE}/js/app.js?x=1`, { hash: H('app-skimmer') })] }, { sensitive: true }), own, st);
  assert.deepEqual(kinds(r), ['in-place-change:high', 'own-change:medium']);
});

test('an own file whose variants differ by query parameter keeps every variant it has seen', () => {
  const own = approved({ scripts: [entry({ id: 'cfg', match: `${SITE}/js/config.js`, trust: 'deploy', pages: ['**', '/checkout'] })] });
  const page = () => one('/checkout', { scripts: [ext(`${SITE}/js/config.js?lang=en`, { hash: H('en') }), ext(`${SITE}/js/config.js?lang=fr`, { hash: H('fr') })] }, { sensitive: true });
  const first = run(page(), own);
  assert.deepEqual(kinds(first), []);
  assert.deepEqual(kinds(run(page(), own, first.state)), []);
});

test('own-change is Medium on sensitive pages and Info elsewhere without deploy evidence, and accepted with it', () => {
  const appr = approved({ scripts: [entry({ id: 'app', match: `${SITE}/js/app.js`, trust: 'deploy', pages: ['**', '/login'] })] });
  const prior = () => { const st = state(); st.sites[SITE] = { entrySlots: { [`${SITE}/assets/index-{token}.js`]: 'B7kQ0aRz' }, marker: null, ownHashes: { [ownKey(`${SITE}/js/app.js`)]: H('before').slice(0, 12) }, inline: {}, deployTokens: [], seen: {}, domains: {}, domainCheck: null }; return st; };
  const changed = (path, sensitive, extra = []) => run(snapshot([{ path, sensitive, observed: { scripts: [ext(`${SITE}/js/app.js`, { hash: H('after') }), ...extra] } }]), appr, prior());
  assert.deepEqual(kinds(changed('/login', true)), ['own-change:medium']);
  const home = changed('/', false);
  assert.deepEqual(kinds(home), []);
  assert.deepEqual(home.info.map((f) => f.kind), ['own-change']);
  const deployed = changed('/login', true, [ext(`${SITE}/assets/index-C9xR1bTp.js`)]);
  assert.deepEqual(kinds(deployed).filter((k) => k.startsWith('own-change')), []);
});

test('new-own-script is High on sensitive pages and Medium elsewhere', () => {
  const appr = approved({ scripts: [entry({ id: 'app', match: `${SITE}/js/app.js`, trust: 'deploy', pages: ['**', '/login'] })] });
  const obs = { scripts: [ext(`${SITE}/js/app.js`), ext(`${SITE}/js/new-thing.js`)] };
  assert.deepEqual(kinds(run(one('/login', obs, { sensitive: true }), appr)), ['new-own-script:high']);
  assert.deepEqual(kinds(run(one('/', obs), appr)), ['new-own-script:medium']);
});

test('build-file follows the chunk map and deploy evidence', () => {
  const appr = approved({ scripts: [entry({ id: 'build', match: `${SITE}/assets/*-{token}.js`, trust: 'deploy' })] });
  const st = () => { const s = state(); s.sites[SITE] = { entrySlots: { [`${SITE}/assets/index-{token}.js`]: 'B7kQ0aRz' }, marker: null, ownHashes: {}, inline: {}, deployTokens: [], seen: {}, domains: {}, domainCheck: null }; return s; };
  const entryJs = ext(`${SITE}/assets/index-B7kQ0aRz.js`);
  assert.deepEqual(kinds(run(one('/', { scripts: [entryJs, ext(`${SITE}/assets/chunk-Dq9Wn3Lp.js`, { referencedBy: [`${SITE}/assets/index-B7kQ0aRz.js`], creator: `${SITE}/assets/index-B7kQ0aRz.js` })] }), appr, st())), []);
  assert.deepEqual(kinds(run(one('/', { scripts: [entryJs, ext(`${SITE}/assets/evil-Zz9Yy8Xx.js`, { creator: `${SITE}/assets/index-B7kQ0aRz.js` })] }), appr, st())), ['build-file:medium']);
  assert.deepEqual(kinds(run(one('/', { scripts: [ext(`${SITE}/assets/index-C9xR1bTp.js`), ext(`${SITE}/assets/evil-Zz9Yy8Xx.js`, { creator: `${SITE}/assets/index-C9xR1bTp.js` })] }), appr, st())), []);
});

test('a file dropped in the build folder with its own script tag is reported on every run, not adopted', () => {
  const appr = approved({ scripts: [entry({ id: 'build', match: `${SITE}/assets/*-{token}.js`, trust: 'deploy', pages: ['**', '/checkout'] })] });
  const st = state();
  st.sites[SITE] = { entrySlots: { [`${SITE}/assets/index-{token}.js`]: 'B7kQ0aRz' }, marker: null, ownHashes: {}, inline: {}, deployTokens: [], seen: {}, domains: {}, domainCheck: null };
  const page = () => one('/checkout', { scripts: [ext(`${SITE}/assets/index-B7kQ0aRz.js`), ext(`${SITE}/assets/skim-Ab12Cd34.js`)] }, { sensitive: true });
  const first = run(page(), appr, st);
  assert.deepEqual(kinds(first), ['build-file:high']);
  const second = run(page(), appr, first.state);
  assert.deepEqual(kinds(second), ['build-file:high'], 'the second run does not take its slot for a known one');
});

test('two files dropped in the build folder do not vouch for each other', () => {
  const appr = approved({ scripts: [entry({ id: 'build', match: `${SITE}/assets/*-{token}.js`, trust: 'deploy' })] });
  const st = () => { const s = state(); s.sites[SITE] = { entrySlots: { [`${SITE}/assets/index-{token}.js`]: 'B7kQ0aRz' }, marker: null, ownHashes: {}, inline: {}, deployTokens: [], seen: {}, domains: {}, domainCheck: null }; return s; };
  const a = `${SITE}/assets/evil-Zz9Yy8Xx.js`;
  const b = `${SITE}/assets/more-Qq7Ww6Ee.js`;
  const scripts = [ext(`${SITE}/assets/index-B7kQ0aRz.js`), ext(a, { referencedBy: [b] }), ext(b, { creator: a, referencedBy: [a] })];
  assert.deepEqual(kinds(run(one('/', { scripts }), appr, st())), ['build-file:medium', 'build-file:medium']);
});

test('what a deploy accepted, rather than an approval, is listed so its alerts are not cleared silently', () => {
  const appr = approved({ scripts: [entry({ id: 'build', match: `${SITE}/assets/*-{token}.js`, trust: 'deploy' })] });
  const st = () => { const s = state(); s.sites[SITE] = { entrySlots: { [`${SITE}/assets/index-{token}.js`]: 'B7kQ0aRz' }, marker: null, ownHashes: {}, inline: {}, deployTokens: [], seen: {}, domains: {}, domainCheck: null }; return s; };
  const evil = `${SITE}/assets/evil-Zz9Yy8Xx.js`;
  const r = run(one('/', { scripts: [ext(`${SITE}/assets/index-C9xR1bTp.js`), ext(evil, { creator: `${SITE}/assets/index-C9xR1bTp.js` })] }), appr, st());
  assert.ok(r.acceptedByDeploy.includes(`content:${evil}|${H(evil)}`), r.acceptedByDeploy.join(' '));
  assert.ok(!r.acceptedByDeploy.some((x) => x.includes('index-C9xR1bTp')), 'a replaced entry file is the deploy itself');
});

test('new-inline: High on sensitive pages without a deploy, Medium with one; deploy-trust inline accepted with deploy evidence', () => {
  const t1 = 'a'.repeat(64);
  const t2 = 'b'.repeat(64);
  const appr = approved({ own: [], scripts: [entry({ id: 'build', match: `${SITE}/assets/*-{token}.js`, trust: 'deploy', pages: ['**', '/login'] }), entry({ id: 'in-login', match: 'inline', trust: 'exact', template: [t1], pages: ['/login'] }), entry({ id: 'in-home', match: 'inline', trust: 'deploy', pages: ['**'] })] });
  const st = () => { const s = state(); s.sites[SITE] = { entrySlots: { [`${SITE}/assets/index-{token}.js`]: 'B7kQ0aRz' }, marker: null, ownHashes: {}, inline: { '/': [t1.slice(0, 12)] }, deployTokens: [], seen: {}, domains: {}, domainCheck: null }; return s; };
  const same = ext(`${SITE}/assets/index-B7kQ0aRz.js`);
  const deployed = ext(`${SITE}/assets/index-C9xR1bTp.js`);
  assert.deepEqual(kinds(run(one('/login', { scripts: [same, inline(t2)] }, { sensitive: true }), appr, st())), ['new-inline:high']);
  assert.deepEqual(kinds(run(one('/login', { scripts: [deployed, inline(t2)] }, { sensitive: true }), appr, st())), ['new-inline:medium']);
  assert.deepEqual(kinds(run(one('/', { scripts: [deployed, inline(t2)] }), appr, st())), []);
  assert.deepEqual(kinds(run(one('/', { scripts: [same, inline(t2)] }), appr, st())), ['new-inline:medium']);
});

test('cloaking is High when Chrome and a direct fetch got different bytes', () => {
  const url = 'https://cdn.example/lib@2.0.0/lib.js';
  const snap = one('/', { scripts: [ext(url, { hash: H('skimmer') })] });
  snap.crossCheck = [{ url, chromeHash: H('skimmer'), directHash: H('clean'), note: null }];
  assert.ok(kinds(run(snap, approved({ scripts: [jqEntry] }))).includes('cloaking:high'));
});

test('a script an approved origin loader injects from the same vendor inherits its trust', () => {
  const loader = 'https://www.google.com/recaptcha/api.js';
  const release = 'https://www.gstatic.com/recaptcha/releases/abc123/recaptcha__en.js';
  const r = run(one('/', { scripts: [ext(loader), ext(release, { creator: loader })] }), approved({ scripts: [entry({ id: 'recaptcha', match: loader, trust: 'origin' })] }));
  assert.deepEqual(kinds(r), []);
});

test('the same finding on desktop and mobile is one finding with both profiles', () => {
  const snap = snapshot([{ path: '/', profiles: ['desktop', 'mobile'], observed: { scripts: [ext('https://evil.example/x.js')] } }]);
  const r = run(snap, approved({ scripts: [] }));
  assert.equal(r.findings.length, 1);
  assert.deepEqual(r.findings[0].profiles, ['desktop', 'mobile']);
});

test('inconclusive profiles produce no findings', () => {
  assert.deepEqual(kinds(run(snapshot([{ path: '/', conclusive: false, observed: { scripts: [ext('https://evil.example/x.js')] } }]), approved({}))), []);
});

test('an in-place change keeps being reported until its hash is approved on the deploy entry', () => {
  const url = `${SITE}/assets/main.3f2a1c9b.js`;
  const appr = (sha256) => approved({ scripts: [entry({ id: 'build', match: `${SITE}/assets/*.{token}.js`, trust: 'deploy', ...(sha256 ? { sha256 } : {}) })] });
  const st = state();
  st.sites[SITE] = { entrySlots: {}, marker: null, ownHashes: { [ownKey(url)]: H('old').slice(0, 12) }, inline: {}, deployTokens: [], seen: {}, domains: {}, domainCheck: null };
  const snap = one('/', { scripts: [ext(url, { hash: H('new') })] });
  const first = run(snap, appr(), st);
  assert.deepEqual(kinds(first), ['in-place-change:high']);
  assert.equal(first.findings[0].data.entryId, 'build');
  assert.deepEqual(kinds(run(snap, appr(), first.state)), ['in-place-change:high'], 'still reported on the next run');
  const ok = run(snap, appr([H('new')]), first.state);
  assert.deepEqual(kinds(ok), []);
  assert.deepEqual(kinds(run(snap, appr(), ok.state)), [], 'once accepted, the new hash is the baseline');
});

test('an inline template listed on a deploy entry is accepted without a deploy', () => {
  const t = 'c'.repeat(64);
  const appr = approved({ scripts: [entry({ id: 'in-home', match: 'inline', trust: 'deploy', template: [t] })] });
  assert.deepEqual(kinds(run(one('/', { scripts: [inline(t)] }), appr)), []);
});

test('cloaking is not raised for a file approved with origin trust', () => {
  const url = 'https://widgets.example/w.js';
  const snap = one('/', { scripts: [ext(url, { hash: H('a') })] });
  snap.crossCheck = [{ url, chromeHash: H('a'), directHash: H('b'), note: null }];
  assert.deepEqual(kinds(run(snap, approved({ scripts: [entry({ id: 'w', match: url, trust: 'origin' })] }))), []);
});

test('with no entry-slot history (a first or stateless run), the page\'s own bundle in an approved build folder is accepted', () => {
  const appr = approved({ scripts: [entry({ id: 'build', match: `${SITE}/assets/*-{token}.js`, trust: 'deploy' })] });
  const bundle = `${SITE}/assets/index-B7kQ0aRz.js`;
  assert.deepEqual(kinds(run(one('/', { scripts: [ext(bundle)] }), appr)), []);
  assert.deepEqual(kinds(run(one('/', { scripts: [ext(bundle), ext(`${SITE}/assets/evil-Zz9Yy8Xx.js`, { creator: bundle })] }), appr)), ['build-file:medium'], 'a file the page did not load directly still needs the chunk map or a deploy');
});

test('a new inline script on a page that is not sensitive says only that', () => {
  const r = run(one('/', { scripts: [inline('d'.repeat(64))] }), approved({ scripts: [] }));
  assert.deepEqual(r.findings.map((f) => f.reasons), [['a new inline script']]);
});

test('an in-place change says whether a build token or a version was reused', () => {
  const own = approved({ scripts: [entry({ id: 'build', match: `${SITE}/assets/*.{token}.js`, trust: 'deploy' }), entry({ id: 'mz', match: `${SITE}/js/modernizr-{version}.min.js`, trust: 'deploy' })] });
  const st = state();
  st.sites[SITE] = { entrySlots: {}, marker: null, ownHashes: { [ownKey(`${SITE}/assets/main.3f2a1c9b.js`)]: H('old').slice(0, 12), [ownKey(`${SITE}/js/modernizr-2.6.2.min.js`)]: H('mz-old').slice(0, 12) }, inline: {}, deployTokens: [], seen: {}, domains: {}, domainCheck: null };
  const r = run(one('/', { scripts: [ext(`${SITE}/assets/main.3f2a1c9b.js`, { hash: H('new') }), ext(`${SITE}/js/modernizr-2.6.2.min.js`, { hash: H('mz-skimmer') })] }), own, st);
  assert.deepEqual(r.findings.map((f) => f.reasons[0]).sort(), ['the content changed at a file name that carries a build token', 'the content of version 2.6.2 changed in place']);
});

test('a hashed own file approved by its exact URL on a deploy entry is the baseline on first sight', () => {
  const url = `${SITE}/assets/vendor-B7kQ0aRz.js`;
  const appr = approved({ scripts: [entry({ id: 'vendor', match: url, trust: 'deploy' })] });
  assert.deepEqual(kinds(run(one('/', { scripts: [ext(url, { creator: `${SITE}/js/app.js` })] }), appr)), []);
});

test('a bundle accepted on a first run without a deploy does not lend its token to a dropped file', () => {
  const appr = approved({ scripts: [entry({ id: 'build', match: `${SITE}/assets/*-{token}.js`, trust: 'deploy' })] });
  const bundle = `${SITE}/assets/index-B7kQ0aRz.js`;
  const first = run(one('/', { scripts: [ext(bundle)] }), appr);
  assert.deepEqual(first.state.sites[SITE].deployTokens, []);
  const dropped = run(one('/', { scripts: [ext(bundle), ext(`${SITE}/assets/evil-B7kQ0aRz.js`, { creator: bundle })] }), appr, first.state);
  assert.deepEqual(kinds(dropped), ['build-file:medium']);
});

test('an own file approved with origin trust is covered by that entry alone', () => {
  const url = `${SITE}/js/widget.js`;
  const appr = approved({ scripts: [entry({ id: 'widget', match: url, trust: 'origin' })] });
  assert.deepEqual(kinds(run(one('/', { scripts: [ext(url, { hash: H('changed') })] }), appr)), []);
});

test('an approved origin loader lends no trust to a script it injects from another vendor', () => {
  const loader = 'https://widgets.example/loader.js';
  const r = run(one('/', { scripts: [ext(loader), ext('https://evil.example/x.js', { creator: loader })] }), approved({ scripts: [entry({ id: 'w', match: loader, trust: 'origin' })] }));
  assert.deepEqual(kinds(r), ['new-origin:high']);
  const google = 'https://www.google.com/recaptcha/api.js';
  const g = run(one('/', { scripts: [ext(google), ext('https://evil.example/x.js', { creator: google })] }), approved({ scripts: [entry({ id: 'recaptcha', match: google, trust: 'origin' })] }));
  assert.deepEqual(kinds(g), ['new-origin:high']);
});

test('no trust is inherited onto a host that serves anyone\'s files, even one the loader\'s company runs', () => {
  const gtm = 'https://www.googletagmanager.com/gtm.js?id=GTM-MINE';
  const injected = (loader, url) => kinds(run(one('/checkout', { scripts: [ext(loader), ext(url, { creator: loader })] }, { sensitive: true }), approved({ scripts: [entry({ id: 'loader', match: loader, trust: 'origin', pages: ['**', '/checkout'] })] })));
  assert.deepEqual(injected(gtm, 'https://storage.googleapis.com/evil-bucket/skim.js'), ['new-origin:high']);
  assert.deepEqual(injected(gtm, 'https://lh3.googleusercontent.com/skim.js'), ['new-origin:high']);
  assert.deepEqual(injected(gtm, 'https://firebasestorage.googleapis.com/v0/b/evil/o/skim.js'), ['new-origin:high']);
  assert.deepEqual(injected(gtm, 'https://evil-abc123-uc.a.run.app/skim.js'), ['new-origin:high']);
  assert.deepEqual(injected('https://d111abcdef8.cloudfront.net/loader.js', 'https://d222evil.cloudfront.net/skim.js'), ['new-origin:high']);
  assert.deepEqual(injected(gtm, 'https://www.google-analytics.com/analytics.js'), [], 'the vendor\'s own hosts still inherit');
});

test('trust is inherited only from a loader approved with origin trust', () => {
  const loader = 'https://www.google.com/recaptcha/api.js';
  const release = 'https://www.gstatic.com/recaptcha/releases/abc123/recaptcha__en.js';
  const r = run(one('/', { scripts: [ext(loader), ext(release, { creator: loader })] }), approved({ scripts: [entry({ id: 'recaptcha', match: loader, trust: 'exact', sha256: [H(loader)] })] }));
  assert.deepEqual(kinds(r), ['new-origin:high']);
});

test('a renamed hashed third-party file at an approved origin is a new slot, not a new version', () => {
  const was = 'https://cdn.example/widget-B7kQ0aRz.js';
  const r = run(one('/', { scripts: [ext('https://cdn.example/widget-C9xR1bTp.js')] }), approved({ scripts: [entry({ id: 'widget', match: was, trust: 'exact', sha256: [H(was)] })] }));
  assert.deepEqual(kinds(r), ['new-slot:medium']);
});

test('a versioned script from an unapproved origin is a new origin, whatever else is approved', () => {
  const r = run(one('/', { scripts: [ext('https://evil.example/lib@1.0.0/lib.js')] }), approved({ scripts: [jqEntry] }));
  assert.deepEqual(kinds(r), ['new-origin:high']);
});

test('a Next.js deploy, which moves the build manifest to a new build id directory, raises nothing', () => {
  const was = `${SITE}/_next/static/aB3dE5fG7hJ9kL1mN3pQ5/_buildManifest.js`;
  const now = `${SITE}/_next/static/Zy9xW7vU5tS3rQ1pO9nM7/_buildManifest.js`;
  const appr = approved({ scripts: [entry({ id: 'next', match: `${SITE}/_next/static/{token}/_buildManifest.js`, trust: 'deploy' })] });
  const st = state();
  st.sites[SITE] = { entrySlots: { [`${SITE}/_next/static/{token}/_buildManifest.js`]: 'aB3dE5fG7hJ9kL1mN3pQ5' }, marker: null, ownHashes: { [ownKey(was)]: H(was).slice(0, 12) }, inline: {}, deployTokens: [], seen: {}, domains: {}, domainCheck: null };
  assert.deepEqual(kinds(run(one('/', { scripts: [ext(now)] }), appr, st)), []);
});
