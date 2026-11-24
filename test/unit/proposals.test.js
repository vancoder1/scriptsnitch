import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { judge } from '../../src/analyze/judge.js';
import { proposalsFor, groupSiblings, staleProposals, applyProposals } from '../../src/analyze/proposals.js';
import { validateMode } from '../../src/modes/validate.js';
import { approveMode } from '../../src/modes/approve.js';
import { findingKey } from '../../src/analyze/keys.js';
import { parseApproved, validateApproved } from '../../src/config/approved.js';
import { SITE, H, ext, inline, scriptRef, visit, snapshot, entry, approved, config, state } from '../helpers/snapshots.js';

const NOW = Date.UTC(2026, 10, 24);
const TODO = 'TODO: why does this page need it?';
const judged = (snap, appr, st = state()) => judge({ snapshot: snap, approved: appr, config: config(snap.pages.map((p) => ({ path: p.path, sensitive: p.sensitive }))), state: st, now: NOW });
const propose = (snap, appr, st) => { const r = judged(snap, appr, st); return proposalsFor([...r.findings, ...r.held], appr, { now: NOW, headers: r.headers }); };
const one = (path, observed, extra = {}) => snapshot([{ path, observed, ...extra }]);
const CHAT = 'https://chat.example/widget.js';
const chatEntry = entry({ id: 'chat', match: CHAT, trust: 'origin', pages: ['**', '/checkout'] });
const JQ = 'https://cdn.example/npm/jquery@3.7.1/dist/jquery.min.js';
const jqEntry = entry({ id: 'jq', match: JQ, trust: 'exact', sha256: [H(JQ)] });

test('High findings become pending and Medium routine', () => {
  const ps = propose(one('/', { scripts: [ext(CHAT), ext('https://evil.example/x.js'), ext('https://chat.example/extra.js')] }), approved({ scripts: [chatEntry] }));
  const evil = ps.find((p) => p.entry?.match === 'https://evil.example/x.js');
  assert.equal(evil.mode, 'pending');
  assert.equal(evil.section, 'scripts');
  assert.equal(evil.finding, findingKey('new-origin', 'https://evil.example/x.js', '*'));
  assert.deepEqual([evil.entry.id, evil.entry.reason, evil.entry.approved, evil.entry.pages], ['evil-example-x-js', TODO, '2026-11-24', ['**']]);
  assert.equal(ps.find((p) => p.entry?.match === 'https://chat.example/extra.js').mode, 'routine');
});

test('pending additions to an existing entry use add, never replace', () => {
  const ps = propose(snapshot([{ path: '/checkout', sensitive: true, visits: [
    visit({ role: 'A', scripts: [ext(JQ, { hash: H('tampered') })] }), visit({ role: 'B', scripts: [ext(JQ, { hash: H('tampered') })] }),
    visit({ role: 'probe', scripts: [ext(JQ, { hash: H('tampered') })], listeners: [{ kind: 'card', role: 'field', event: 'keydown', script: { url: JQ, contentHash: H('tampered'), template: null } }] }),
  ] }]), approved({ scripts: [{ ...jqEntry, pages: ['**', '/checkout'] }] }));
  const mismatch = ps.find((p) => p.finding.startsWith('content-mismatch'));
  assert.deepEqual([mismatch.mode, mismatch.id, mismatch.add, 'entry' in mismatch], ['pending', 'jq', { sha256: [H('tampered')] }, false]);
  const listener = ps.find((p) => p.finding.startsWith('listener'));
  assert.deepEqual([listener.mode, listener.id, listener.add], ['pending', 'jq', { listens: ['card:field:keydown'] }]);
});

test('proposed trust: exact for versioned third-party, origin for floating, deploy for own', () => {
  const t = 'd'.repeat(64);
  const ps = propose(snapshot([
    { path: '/', observed: { scripts: [ext('https://cdn.example/lib@2.0.0/lib.js'), ext('https://widgets.example/w.js'), ext(`${SITE}/assets/index-B7kQ0aRz.js`), ext(`${SITE}/js/app.js`), ext('https://cdn.jsdelivr.net/gh/someone/tool/tool.js'), ext('https://www.googletagmanager.com/gtm.js?id=GTM-NEW1'), inline(t)] } },
    { path: '/login', sensitive: true, observed: { scripts: [inline(t)] } },
  ]), approved({}));
  const by = (match) => ps.find((p) => p.entry?.match === match)?.entry;
  assert.deepEqual([by('https://cdn.example/lib@2.0.0/lib.js').trust, by('https://cdn.example/lib@2.0.0/lib.js').sha256], ['exact', [H('https://cdn.example/lib@2.0.0/lib.js')]]);
  assert.equal(by('https://widgets.example/w.js').trust, 'origin');
  assert.equal(by(`${SITE}/assets/*-{token}.js`).trust, 'deploy');
  assert.equal(by(`${SITE}/js/app.js`).trust, 'deploy');
  assert.equal(by('https://cdn.jsdelivr.net/gh/someone/tool/tool.js').trust, 'exact', 'origin trust is refused on path-shared hosts');
  assert.equal(by('https://www.googletagmanager.com/gtm.js?id=GTM-NEW1').trust, 'origin');
  const inlines = ps.filter((p) => p.entry?.match === 'inline').map((p) => [p.entry.trust, p.entry.pages, p.entry.template]);
  assert.deepEqual(inlines.sort(), [['deploy', ['**'], [t]], ['exact', ['/login'], [t]]]);
  const applied = applyProposals(approved({}), SITE, ps.map((p) => ({ ...p, mode: 'routine' })));
  assert.deepEqual(validateApproved(applied).filter((i) => i.level === 'error'), []);
});

test('new script proposals carry the behaviour seen, and new-version keeps the old entry\'s pages', () => {
  const evil = 'https://evil.example/k.js';
  const ps = propose(snapshot([{ path: '/', visits: [
    visit({ role: 'A', scripts: [ext(evil, { hosts: ['c2.evil.example'] })], listeners: [{ kind: 'password', role: 'document', event: 'keydown', script: scriptRef(evil) }] }),
    visit({ role: 'B', scripts: [ext(evil, { hosts: ['c2.evil.example'] })] }),
  ] }]), approved({}));
  assert.deepEqual(ps.find((p) => p.entry?.match === evil).entry.behavior, { hosts: ['c2.evil.example'], listens: ['password:document:keydown'], input: false, eval: false, obfuscation: 'minified' });
  const v380 = JQ.replace('3.7.1', '3.8.0');
  const up = propose(one('/', { scripts: [ext(v380)] }), approved({ scripts: [{ ...jqEntry, pages: ['/', '/about'] }] }));
  assert.deepEqual([up[0].entry.match, up[0].entry.trust, up[0].entry.pages, up[0].mode], [v380, 'exact', ['/', '/about'], 'routine']);
});

test('sibling hosts group into one wildcard but never on shared hosts or account-keyed services', () => {
  const dest = (match, mode = 'routine') => ({ site: SITE, finding: findingKey('new-destination', match), severity: mode === 'pending' ? 'high' : 'medium', section: 'destinations', mode, entry: { match, pages: ['**'], reason: TODO, approved: '2026-11-24' } });
  const grouped = groupSiblings([
    dest('https://a.metrics.example'), dest('https://b.metrics.example'), dest('https://c.metrics.example'),
    dest('https://x.netlify.app'), dest('https://y.netlify.app'), dest('https://z.netlify.app'),
    dest('https://region1.google-analytics.com/g/collect?tid=G-1'), dest('https://region2.google-analytics.com/g/collect?tid=G-1'), dest('https://region3.google-analytics.com/g/collect?tid=G-1'),
    dest('https://one.two.example'), dest('https://two.two.example'),
    dest('https://p.side.example', 'pending'), dest('https://q.side.example'), dest('https://r.side.example'),
  ]);
  const matches = grouped.map((p) => p.entry.match).sort();
  assert.ok(matches.includes('https://*.metrics.example'));
  assert.ok(!matches.some((m) => m.includes('a.metrics.example')));
  assert.equal(grouped.find((p) => p.entry.match === 'https://*.metrics.example').also.length, 2);
  for (const m of ['https://x.netlify.app', 'https://region1.google-analytics.com/g/collect?tid=G-1', 'https://one.two.example', 'https://p.side.example', 'https://q.side.example']) assert.ok(matches.includes(m), m);
});

test('stale entries unseen for 30 days are proposed for removal', () => {
  const appr = approved({
    scripts: [entry({ id: 'old', match: 'https://old.example/a.js', trust: 'origin', approved: '2026-09-01' }), entry({ id: 'fresh', match: 'https://fresh.example/a.js', trust: 'origin', approved: '2026-11-20' }), entry({ id: 'recent', match: 'https://recent.example/a.js', trust: 'origin', approved: '2026-09-01' })],
    destinations: [{ match: 'https://gone.example', reason: 'r', approved: '2026-08-01' }],
  });
  const st = state();
  st.sites[SITE] = { entrySlots: {}, marker: null, ownHashes: {}, inline: {}, deployTokens: [], seen: { old: '2026-10-01', recent: '2026-11-10' }, domains: {}, domainCheck: null };
  const ps = staleProposals(appr, st, NOW);
  assert.deepEqual(ps.map((p) => [p.section, p.id, p.remove, p.mode]), [['scripts', 'old', true, 'routine'], ['destinations', 'https://gone.example', true, 'routine']]);
  const after = applyProposals(appr, SITE, ps);
  assert.deepEqual(after.sites[SITE].scripts.map((e) => e.id), ['fresh', 'recent']);
  assert.deepEqual(after.sites[SITE].destinations, []);
});

test('first-run proposals use the first-run split and include the headers present', () => {
  const r = judged(snapshot([{ path: '/login', sensitive: true, observed: { scripts: [ext('https://cdn.example/a.js')], fields: [{ frame: 'top', form: 'POST /login', field: 'password', kind: 'password', count: 1 }], headers: { 'strict-transport-security': 'max-age=63072000', 'x-powered-by': 'x' } } }]), { version: 1, sites: {} });
  const ps = proposalsFor([...r.findings, ...r.held], { version: 1, sites: {} }, { now: NOW, headers: r.headers });
  assert.equal(ps.find((p) => p.entry?.match === 'https://cdn.example/a.js').mode, 'routine', 'a High new-origin on the first run is routine');
  assert.equal(ps.find((p) => p.section === 'fields').mode, 'pending');
  assert.deepEqual(ps.find((p) => p.section === 'headers'), { site: SITE, finding: null, severity: null, section: 'headers', mode: 'routine', id: '**', add: { 'strict-transport-security': 'max-age=63072000' } });
});

function tempFiles(files) {
  const dir = mkdtempSync(join(tmpdir(), 'scriptsnitch-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  return dir;
}
const site = (s) => ({ version: 1, sites: { [SITE]: { own: [], scripts: [], destinations: [], frames: [], fields: [], allow: [], headers: {}, pending: [], ...s } } });
const cfg = (extra = {}) => ({ approved: 'approved.json', pages: [{ name: 'Home', url: `${SITE}/`, expect: { selector: 'main' } }], ...extra });

test('validate fails on a TODO reason in a live entry and passes with one only in pending', (t) => {
  const live = { match: 'https://api.example', reason: TODO, approved: '2026-11-24' };
  const dir = tempFiles({ 'c.json': cfg(), 'approved.json': site({ destinations: [live] }) });
  t.after(() => rmSync(dir, { recursive: true }));
  let r = validateMode({ configPath: join(dir, 'c.json'), cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.issues.find((i) => i.level === 'error').message, /TODO/);
  writeFileSync(join(dir, 'approved.json'), JSON.stringify(site({ pending: [{ finding: 'new-destination|https://api.example|*', severity: 'high', into: 'destinations', entry: live }] })));
  r = validateMode({ configPath: join(dir, 'c.json'), cwd: dir });
  assert.equal(r.ok, true, JSON.stringify(r.issues));
  writeFileSync(join(dir, 'approved.json'), JSON.stringify(site({ destinations: [live] })));
  writeFileSync(join(dir, 'c.json'), JSON.stringify(cfg({ requireReasons: false })));
  assert.equal(validateMode({ configPath: join(dir, 'c.json'), cwd: dir }).ok, true);
  writeFileSync(join(dir, 'approved.json'), '{ "version": 1, ');
  r = validateMode({ configPath: join(dir, 'c.json'), cwd: dir });
  assert.equal(r.ok, false);
  assert.match(r.issues[0].message, /approved\.json/);
});

test('validate warns about a page with no expect and no approved own script', (t) => {
  const dir = tempFiles({ 'c.json': { approved: 'approved.json', pages: [{ name: 'Home', url: `${SITE}/` }] }, 'approved.json': site({}) });
  t.after(() => rmSync(dir, { recursive: true }));
  const r = validateMode({ configPath: join(dir, 'c.json'), cwd: dir });
  assert.equal(r.ok, true);
  assert.match(r.issues.find((i) => i.level === 'warning').message, /expect/);
});

test('approve --id moves a pending item; --all adds only routine findings; --headers adopts current headers', (t) => {
  const pendingKey = 'new-origin|https://evil.example/x.js|*';
  const evilEntry = { id: 'evil-example-x-js', match: 'https://evil.example/x.js', trust: 'origin', pages: ['**'], reason: TODO, approved: '2026-11-24' };
  const report = {
    proposals: [
      { site: SITE, finding: 'new-slot|https://chat.example/extra.js|*', severity: 'medium', section: 'scripts', mode: 'routine', entry: { id: 'chat-example-extra-js', match: 'https://chat.example/extra.js', trust: 'origin', pages: ['**'], reason: TODO, approved: '2026-11-24' } },
      { site: SITE, finding: pendingKey, severity: 'high', section: 'scripts', mode: 'pending', entry: evilEntry },
    ],
    headers: { [SITE]: { '/': { 'strict-transport-security': 'max-age=63072000', 'x-frame-options': 'DENY' } } },
  };
  const dir = tempFiles({ 'approved.json': site({}), 'report.json': report });
  t.after(() => rmSync(dir, { recursive: true }));
  const read = () => parseApproved(readFileSync(join(dir, 'approved.json'), 'utf8'), 'approved.json').sites[SITE];
  const args = { approvedPath: join(dir, 'approved.json'), reportPath: join(dir, 'report.json') };

  approveMode({ ...args, all: true });
  assert.deepEqual(read().scripts.map((e) => e.id), ['chat-example-extra-js']);
  assert.deepEqual(read().pending.map((p) => p.finding), [pendingKey]);

  approveMode({ ...args, id: pendingKey, reason: 'Checked: a test script' });
  assert.deepEqual(read().scripts.map((e) => [e.id, e.reason]).sort(), [['chat-example-extra-js', TODO], ['evil-example-x-js', 'Checked: a test script']]);
  assert.deepEqual(read().pending, []);
  assert.throws(() => approveMode({ ...args, id: 'nope|x|*' }), /nope\|x\|\*/);

  approveMode({ ...args, headers: true });
  assert.deepEqual(read().headers, { '**': { 'strict-transport-security': 'max-age=63072000', 'x-frame-options': 'DENY' } });
});
