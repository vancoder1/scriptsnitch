import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, combine, confirm } from '../../src/analyze/judge.js';
import { firstRunSplit } from '../../src/analyze/firstrun.js';
import { findingKey } from '../../src/analyze/keys.js';
import { DRILL_ORIGIN } from '../../src/capture/drill.js';
import { SITE, H, ext, code, scriptRef, visit, snapshot, entry, approved, config, state } from '../helpers/snapshots.js';

const run = (snap, appr, st = state()) => judge({ snapshot: snap, approved: appr, config: config(snap.pages.map((p) => ({ path: p.path, sensitive: p.sensitive }))), state: st, now: Date.UTC(2026, 10, 24) });
const kinds = (r) => r.findings.map((f) => `${f.kind}:${f.severity}`).sort();
const infoKinds = (r) => r.info.map((f) => f.kind).sort();
const one = (path, observed, extra = {}) => snapshot([{ path, observed, ...extra }]);

const APP = `${SITE}/js/app.js`;
const CHAT = 'https://chat.example/widget.js';
const behavior = (b = {}) => ({ hosts: [], listens: [], input: false, eval: false, obfuscation: 'minified', ...b });
const appEntry = (b = {}, pages = ['**', '/login', '/checkout', '/support']) => entry({ id: 'app', match: APP, trust: 'deploy', pages, behavior: behavior(b) });
const chatEntry = (b = {}) => entry({ id: 'chat', match: CHAT, trust: 'origin', pages: ['**', '/checkout'], behavior: behavior(b) });
const dest = (url, { method = 'GET', type = 'Fetch', frame = 'top', by = APP, phase = 'load', viaCode = false } = {}) => ({ url, method, type, frame, initiator: by && scriptRef(by), viaCode, phase });
const lis = (kind, role, event, by) => ({ kind, role, event, script: by && scriptRef(by) });
const probe = ({ hits = [], growth = [], storage = [] } = {}) => ({ values: { card: '4111111111111111' }, submitted: true, hits, growth, storage });
const hit = (kind, url, by = null) => ({ kind, encoding: 'raw', url, frame: 'top', initiator: by && scriptRef(by) });
// Visits A and B plus the probe visits collect makes: one, and a second on sensitive pages.
const withProbe = (path, scripts, probeVisit, extra = {}) => snapshot([{ path, ...extra, visits: [
  visit({ role: 'A', scripts }), visit({ role: 'B', scripts }), visit({ role: 'probe', scripts, ...probeVisit }),
  ...(extra.sensitive ? [visit({ role: 'probe2', scripts, ...probeVisit })] : []),
] }]);
const priorDeploy = () => { const s = state(); s.sites[SITE] = { entrySlots: { [`${SITE}/assets/index-{token}.js`]: 'B7kQ0aRz' }, marker: null, ownHashes: {}, inline: {}, deployTokens: [], seen: {}, domains: {}, domainCheck: null }; return s; };

test('new-destination is High during the probe, High on a sensitive page from code without a URL or a changed script, Medium otherwise', () => {
  const appr = approved({ scripts: [appEntry()] });
  const scripts = [ext(APP)];
  const r = run(one('/', { scripts, destinations: [dest('https://api.example/v1/x?id=1')] }), appr);
  assert.deepEqual(kinds(r), ['new-destination:medium']);
  assert.equal(r.findings[0].key, findingKey('new-destination', 'https://api.example', '*'));
  assert.deepEqual(kinds(run(withProbe('/', scripts, { destinations: [dest('https://api.example/v1/x', { phase: 'probe' })] }), appr)), ['new-destination:high']);
  assert.deepEqual(kinds(run(one('/login', { scripts, destinations: [dest('https://api.example/x', { viaCode: true })] }, { sensitive: true }), appr)), ['new-destination:high']);
  assert.deepEqual(kinds(run(one('/login', { scripts, destinations: [dest('https://api.example/x')] }, { sensitive: true }), appr)), ['new-destination:medium']);
  const changed = state();
  changed.sites[SITE] = { entrySlots: {}, marker: null, ownHashes: { [APP]: H('before').slice(0, 12) }, inline: {}, deployTokens: [], seen: {}, domains: {}, domainCheck: null };
  const r2 = run(one('/login', { scripts: [ext(APP, { hash: H('after') })], destinations: [dest('https://api.example/x')] }, { sensitive: true }), appr, changed);
  assert.ok(kinds(r2).includes('new-destination:high'));
});

test('new-destination is keyed by origin, with the account key for keyed services, and approved patterns cover it', () => {
  const appr = approved({ scripts: [appEntry()], destinations: [{ match: 'https://*.google-analytics.com/g/collect?tid=G-MINE', reason: 'r', approved: '2026-11-23' }] });
  const r = run(one('/', { scripts: [ext(APP)], destinations: [dest('https://region1.google-analytics.com/g/collect?v=2&tid=G-MINE'), dest('https://region1.google-analytics.com/g/collect?v=2&tid=G-EVIL')] }), appr);
  assert.deepEqual(r.findings.map((f) => f.key), [findingKey('new-destination', 'https://region1.google-analytics.com/g/collect?tid=G-EVIL', '*')]);
});

test('<link> prefetch hosts are destinations matched by host alone', () => {
  const appr = approved({ scripts: [appEntry()], destinations: [{ match: 'https://fonts.example/css', reason: 'r', approved: '2026-11-23' }] });
  const r = run(one('/', { scripts: [ext(APP)], linkHosts: ['fonts.example', 'x7f3a.evil.example'] }), appr);
  assert.deepEqual(r.findings.map((f) => f.key), [findingKey('new-destination', 'https://x7f3a.evil.example', '*')]);
});

test('probe-exfil: a value to a destination without receives, to a static path whatever receives says, a growing payload, a value in storage', () => {
  const appr = approved({
    scripts: [appEntry({ input: true })],
    destinations: [
      { match: 'https://pay.example', pages: ['/checkout'], reason: 'r', approved: '2026-11-23' },
      { match: 'POST https://gateway.example/charge', receives: ['card'], pages: ['/checkout'], reason: 'r', approved: '2026-11-23' },
      { match: `${SITE}/img/**`, receives: ['card'], pages: ['/checkout'], reason: 'r', approved: '2026-11-23' },
    ],
  });
  const scripts = [ext(APP)];
  const probed = (p) => run(withProbe('/checkout', scripts, p, { sensitive: true }), appr);
  const toPay = probed({ destinations: [dest('https://pay.example/api', { method: 'POST', phase: 'probe' })], probe: probe({ hits: [hit('card', 'https://pay.example/api', APP)] }) });
  assert.deepEqual(kinds(toPay), ['probe-exfil:high']);
  const toGateway = probed({ destinations: [dest('https://gateway.example/charge', { method: 'POST', phase: 'probe' })], probe: probe({ hits: [hit('card', 'https://gateway.example/charge', APP)] }) });
  assert.deepEqual(kinds(toGateway), []);
  const toStatic = probed({ destinations: [dest(`${SITE}/img/p.gif?d=x`, { type: 'Image', phase: 'probe' })], probe: probe({ hits: [hit('card', `${SITE}/img/p.gif?d=x`, APP)] }) });
  assert.deepEqual(kinds(toStatic), ['probe-exfil:high']);
  const growing = probed({ destinations: [dest('https://pay.example/t', { method: 'POST', phase: 'probe' })], probe: probe({ growth: [{ url: 'https://pay.example/t', field: 'body' }] }) });
  assert.deepEqual(kinds(growing), ['probe-exfil:high']);
  assert.deepEqual(kinds(probed({ probe: probe({ storage: [{ kind: 'card', where: 'localStorage' }] }) })), ['probe-exfil:high']);
});

test('probe-exfil: the own origin receives nothing implicitly', () => {
  const appr = approved({ scripts: [appEntry({ input: true })], destinations: [{ match: SITE, pages: ['/login'], reason: 'r', approved: '2026-11-23' }] });
  const r = run(withProbe('/login', [ext(APP)], { destinations: [dest(`${SITE}/wp-content/x.php`, { method: 'POST', phase: 'probe' })], probe: probe({ hits: [hit('password', `${SITE}/wp-content/x.php`, APP)] }) }, { sensitive: true }), appr);
  assert.deepEqual(kinds(r), ['probe-exfil:high']);
});

test('listener on field/form/submit by a third-party script is High; by an approved own script Medium; on ancestor/document/window by an approved script Medium', () => {
  const page = (listeners, b = {}) => run(one('/checkout', { scripts: [ext(APP), ext(CHAT)], listeners }, { sensitive: true }), approved({ scripts: [appEntry(b), chatEntry()] }));
  assert.deepEqual(kinds(page([lis('card', 'field', 'keydown', CHAT)])), ['listener:high']);
  assert.deepEqual(kinds(page([lis('card', 'field', 'input', APP)])), ['listener:medium']);
  assert.deepEqual(kinds(page([lis('card', 'field', 'input', APP)], { listens: ['card:field:input'] })), []);
  assert.deepEqual(kinds(page([lis('card', 'document', 'click', CHAT)])), ['listener:medium']);
  assert.deepEqual(kinds(page([lis('card', 'submit', 'mouseup', null)])), ['listener:high']);
});

test('input-code is High for unapproved code and Medium for an approved script whose input is false', () => {
  const appr = (input) => approved({ scripts: [appEntry({ input })] });
  const probed = (refs, input = false) => run(withProbe('/login', [ext(APP)], { inputCode: refs }, { sensitive: true }), appr(input));
  assert.deepEqual(kinds(probed([scriptRef('https://evil.example/k.js')])), ['input-code:high']);
  assert.deepEqual(kinds(probed([{ url: null, contentHash: H('orphan'), template: null }])), ['input-code:high']);
  assert.deepEqual(kinds(probed([scriptRef(APP)])), ['input-code:medium']);
  assert.deepEqual(kinds(probed([scriptRef(APP)], true)), []);
});

test('new-field is High for a new signature and for a count above approved', () => {
  const field = (count) => ({ frame: 'top', form: 'POST /login', field: 'password', kind: 'password', count });
  const appr = (fields) => approved({ scripts: [appEntry()], fields });
  const approvedField = { frame: 'top', form: 'POST /login', field: 'password', kind: 'password', count: 1, pages: ['/login'], reason: 'r', approved: '2026-11-23' };
  const at = (fields, a) => run(one('/login', { scripts: [ext(APP)], fields }, { sensitive: true }), a);
  const r = at([field(1)], appr([]));
  assert.deepEqual(kinds(r), ['new-field:high']);
  assert.equal(r.findings[0].key, findingKey('new-field', 'top POST /login password password', '*'));
  assert.deepEqual(kinds(at([field(2)], appr([approvedField]))), ['new-field:high']);
  assert.deepEqual(kinds(at([field(1)], appr([approvedField]))), []);
  assert.deepEqual(kinds(at([{ frame: 'top', form: 'POST /login', field: 'email', kind: 'email', count: 1 }], appr([]))), []);
});

test('frame-field is High, new-frame Medium, own frames neither; peer-connection High without allow', () => {
  const frames = [{ origin: 'https://js.pay.example', tracked: false, fieldKinds: ['card'] }, { origin: 'https://video.example', tracked: false, fieldKinds: [] }, { origin: SITE, tracked: true, fieldKinds: [] }];
  const appr = (extra = {}) => approved({ scripts: [appEntry()], ...extra });
  assert.deepEqual(kinds(run(one('/checkout', { scripts: [ext(APP)], frames }, { sensitive: true }), appr())), ['frame-field:high', 'new-frame:medium']);
  const ok = appr({ frames: [{ match: 'https://js.pay.example', fields: ['card'], pages: ['/checkout'], reason: 'r', approved: '2026-11-23' }, { match: 'https://video.example', pages: ['/checkout'], reason: 'r', approved: '2026-11-23' }] });
  assert.deepEqual(kinds(run(one('/checkout', { scripts: [ext(APP)], frames }, { sensitive: true }), ok)), []);
  const peers = run(one('/support', { scripts: [ext(APP)], peers: 1 }), appr());
  assert.deepEqual(kinds(peers), ['peer-connection:high']);
  assert.equal(peers.findings[0].page, '/support');
  assert.deepEqual(kinds(run(one('/support', { scripts: [ext(APP)], peers: 1 }), appr({ allow: [{ what: 'peer-connection', pages: ['/support'], reason: 'r', approved: '2026-11-23' }] }))), []);
});

test('eval and obfuscation are Medium for approved scripts beyond their behaviour', () => {
  const appr = (b) => approved({ scripts: [appEntry(b)] });
  assert.deepEqual(kinds(run(one('/', { scripts: [ext(APP), code(APP)] }), appr())), ['eval:medium']);
  assert.deepEqual(kinds(run(one('/', { scripts: [ext(APP), code(APP)] }), appr({ eval: true }))), []);
  assert.deepEqual(kinds(run(one('/', { scripts: [ext(APP, { band: 'packed' })] }), appr())), ['obfuscation:medium']);
  assert.deepEqual(kinds(run(one('/', { scripts: [ext(APP, { band: 'packed' })] }), appr({ obfuscation: 'packed' }))), []);
});

test('hostname: Medium on sensitive pages (own scripts only without deploy), Info elsewhere; own origin, approved destinations and namespace hosts never new', () => {
  const appr = approved({ scripts: [appEntry(), chatEntry({ hosts: ['api.chat.example'] })], destinations: [{ match: 'https://*.pay.example', reason: 'r', approved: '2026-11-23' }] });
  const page = (path, sensitive, scripts, extra = [], st = state()) => run(snapshot([{ path, sensitive, observed: { scripts: [...scripts, ...extra] } }]), appr, st);
  const evilApp = ext(APP, { hosts: ['collector.evil.example'] });
  assert.deepEqual(kinds(page('/login', true, [evilApp])), ['hostname:medium']);
  const deployed = page('/login', true, [evilApp], [ext(`${SITE}/assets/index-C9xR1bTp.js`)], priorDeploy());
  assert.deepEqual(kinds(deployed).filter((k) => k.startsWith('hostname')), []);
  const home = page('/', false, [evilApp]);
  assert.deepEqual(kinds(home), []);
  assert.deepEqual(infoKinds(home).filter((k) => k === 'hostname'), ['hostname']);
  assert.deepEqual(kinds(page('/checkout', true, [ext(CHAT, { hosts: ['x.evil.example'] })])), ['hostname:medium']);
  const quiet = page('/login', true, [ext(APP, { hosts: ['shop.example', 'api.pay.example', 'www.w3.org', 'api.chat.example'] })]);
  assert.deepEqual([...kinds(quiet), ...infoKinds(quiet).filter((k) => k === 'hostname')], []);
});

test('headers-weaker is High, csp-source Medium, stronger Info', () => {
  const appr = approved({ scripts: [appEntry()], headers: { '**': { 'strict-transport-security': 'max-age=31536000', 'content-security-policy': "script-src 'self'" } } });
  const at = (headers) => run(one('/', { scripts: [ext(APP)], headers }), appr);
  const csp = "script-src 'self'";
  const weaker = at({ 'content-security-policy': csp });
  assert.deepEqual(kinds(weaker), ['headers-weaker:high']);
  assert.equal(weaker.findings[0].key, findingKey('headers-weaker', 'strict-transport-security', '/'));
  assert.deepEqual(kinds(at({ 'strict-transport-security': 'max-age=31536000', 'content-security-policy': `${csp} https://cdn.new.example` })), ['csp-source:medium']);
  const stronger = at({ 'strict-transport-security': 'max-age=63072000', 'content-security-policy': csp });
  assert.deepEqual(kinds(stronger), []);
  assert.deepEqual(infoKinds(stronger), ['headers-stronger']);
});

test('combination raises all of one script\'s findings to High when one is a behaviour sign; peer connections do not count', () => {
  const extra = 'https://chat.example/extra.js';
  const appr = approved({ scripts: [chatEntry()] });
  const r = run(one('/', { scripts: [ext(CHAT), ext(extra)], listeners: [lis('card', 'document', 'keydown', extra)] }), appr);
  assert.deepEqual(kinds(r), ['listener:high', 'new-slot:high']);
  const p = run(one('/', { scripts: [ext(CHAT), ext(extra)], peers: 2 }), appr);
  assert.deepEqual(kinds(p), ['new-slot:medium', 'peer-connection:high']);
  const ref = scriptRef(extra);
  const combined = combine([{ kind: 'eval', severity: 'medium', attributedTo: ref }, { kind: 'obfuscation', severity: 'medium', attributedTo: ref }]);
  assert.deepEqual(combined.map((f) => f.severity), ['medium', 'medium'], 'no behaviour sign, no raise');
});

test('a Medium seen once is held as a sighting and reported on the second within 7 runs; a High is reported on first sight', () => {
  const f = (severity, seen = 1) => ({ kind: 'new-slot', key: `new-slot|x|*`, severity, seen, attributedTo: null });
  const st = state();
  st.run = 1;
  let c = confirm([f('medium')], st, 1);
  assert.deepEqual([c.reportable.length, c.pendingSightings.length], [0, 1]);
  assert.deepEqual(st.sightings['new-slot|x|*'], [1]);
  c = confirm([f('medium')], st, 7);
  assert.equal(c.reportable.length, 1, 'runs 1 and 7 are within the last 7');
  const late = state();
  late.sightings['new-slot|x|*'] = [1];
  assert.equal(confirm([f('medium')], late, 8).reportable.length, 0, 'run 1 is outside the window of run 8');
  assert.equal(confirm([f('medium', 2)], state(), 1).reportable.length, 1, 'two visits in one run confirm it');
  assert.equal(confirm([f('high')], state(), 1).reportable.length, 1);

  const extra = 'https://chat.example/extra.js';
  const appr = approved({ scripts: [chatEntry()] });
  const once = snapshot([{ path: '/', visits: [visit({ role: 'A', scripts: [ext(CHAT), ext(extra)] }), visit({ role: 'B', scripts: [ext(CHAT)] })] }]);
  const r1 = run(once, appr);
  assert.deepEqual(kinds(r1), []);
  assert.deepEqual(r1.held.map((h) => h.kind), ['new-slot']);
  const r2 = run(once, appr, r1.state);
  assert.deepEqual(kinds(r2), ['new-slot:medium']);
});

test('inconclusive profiles produce no findings and resolve nothing', () => {
  const st = state();
  st.sightings['new-slot|https://chat.example/extra.js|*'] = [1];
  st.run = 1;
  const r = run(snapshot([{ path: '/checkout', sensitive: true, conclusive: false, observed: { scripts: [ext('https://evil.example/x.js')], destinations: [dest('https://evil.example/c')], peers: 1 } }]), approved({}), st);
  assert.deepEqual([...kinds(r), ...infoKinds(r)], []);
  assert.deepEqual(r.inconclusive, [{ site: SITE, page: '/checkout', profile: 'desktop', reason: 'bot challenge (Cloudflare)' }]);
  assert.deepEqual(r.state.sightings['new-slot|https://chat.example/extra.js|*'], [1]);
  assert.deepEqual(r.state.pages[`${SITE}/checkout|desktop`], { lastConclusiveRun: null, inconclusiveStreak: 1 });
  const again = run(snapshot([{ path: '/checkout', sensitive: true, observed: { scripts: [] } }]), approved({}), r.state);
  assert.deepEqual(again.state.pages[`${SITE}/checkout|desktop`], { lastConclusiveRun: 3, inconclusiveStreak: 0 });
});

test('drill findings are marked drill and kept apart', () => {
  const skimmer = `${DRILL_ORIGIN}/s.js`;
  const drillVisit = (listeners) => visit({ role: 'drill', scripts: [ext(APP), ext(skimmer)], listeners, destinations: [dest(`${DRILL_ORIGIN}/c?d=x`, { type: 'Image', by: skimmer, phase: 'probe' })], probe: probe({ hits: [hit('password', `${DRILL_ORIGIN}/c?d=x`, skimmer)] }) });
  const snap = (listeners) => snapshot([{ path: '/login', sensitive: true, visits: [visit({ role: 'A', scripts: [ext(APP)] }), visit({ role: 'B', scripts: [ext(APP)] }), drillVisit(listeners)] }], { drill: true });
  const appr = approved({ scripts: [appEntry()] });
  const passed = run(snap([lis('password', 'field', 'keydown', skimmer)]), appr);
  assert.deepEqual(kinds(passed), []);
  assert.ok(passed.drill.findings.length >= 3);
  assert.ok(passed.drill.findings.every((f) => f.drill === true));
  assert.deepEqual([passed.drill.result, passed.drill.missed], ['pass', []]);
  const failed = run(snap([]), appr);
  assert.deepEqual([failed.drill.result, failed.drill.missed], ['fail', ['listener']]);
  assert.equal(run(one('/', { scripts: [ext(APP)] }), appr).drill, null);
});

test('Info: approved scripts not seen, cross-check notes and unaccepted consent banners', () => {
  const snap = one('/', { scripts: [ext(APP)] });
  snap.crossCheck = [{ url: APP, chromeHash: H(APP), directHash: null, note: 'direct fetch got 403' }];
  snap.pages[0].profiles.desktop.visits[0].consent = { found: 'OneTrust', accepted: false };
  const r = run(snap, approved({ scripts: [appEntry(), chatEntry()] }));
  assert.deepEqual(kinds(r), []);
  assert.deepEqual(infoKinds(r), ['not-seen', 'note', 'note']);
});

test('first run proposes routine entries except the risky-in-themselves set', () => {
  const own = new Set([SITE]);
  const scripts = (match, b) => ({ section: 'scripts', entry: { id: match, match, trust: 'origin', behavior: behavior(b) } });
  const proposals = [
    scripts('https://cdn.example/a.js', {}),
    scripts('https://cdn.example/b.js', { listens: ['card:field:keydown'] }),
    scripts(APP, { listens: ['password:field:input'], input: true }),
    scripts('https://cdn.example/c.js', { listens: ['*:document:click'] }),
    scripts('https://cdn.example/d.js', { input: true }),
    { section: 'scripts', entry: { id: 'in', match: 'inline', trust: 'deploy', behavior: behavior({ input: true }) } },
    { section: 'destinations', entry: { match: 'POST https://shop.example/api/login', receives: ['password'] } },
    { section: 'destinations', entry: { match: 'https://api.example' } },
    { section: 'fields', entry: { frame: 'top', form: 'POST /login', field: 'password', kind: 'password' } },
    { section: 'frames', entry: { match: 'https://js.pay.example', fields: ['card'] } },
    { section: 'frames', entry: { match: 'https://video.example', fields: [] } },
    { section: 'allow', entry: { what: 'peer-connection' } },
    { section: 'headers', id: '**', add: { 'x-frame-options': 'DENY' } },
  ];
  assert.deepEqual(firstRunSplit(proposals, own).map((p) => p.mode), ['routine', 'pending', 'routine', 'routine', 'pending', 'routine', 'pending', 'routine', 'pending', 'pending', 'routine', 'pending', 'routine']);
});
