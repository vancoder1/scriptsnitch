import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDomains, domainsToCheck } from '../../src/report/domains.js';
import { SITE, ext, snapshot, entry, approved } from '../helpers/snapshots.js';

const NOW = Date.UTC(2026, 10, 24);
const inDays = (n) => new Date(NOW + n * 86400000).toISOString();
const err = (code) => Object.assign(new Error(`query ${code}`), { code });
// A resolver from a table of "host TYPE" answers; anything missing is ENODATA (the name exists).
const resolver = (table) => {
  const calls = [];
  const fn = async (host, type) => {
    calls.push(`${host} ${type}`);
    const r = table[`${host} ${type}`] ?? table[`${host} *`];
    if (r instanceof Error) throw r;
    if (r === undefined) throw err('ENODATA');
    return r;
  };
  fn.calls = calls;
  return fn;
};
const ok = { 'cdn.widgets.com A': ['192.0.2.1'], 'widgets.com A': ['192.0.2.1'] };
const BOOT = { services: [[['com', 'net'], ['https://rdap.registry-a.test/']], [['uk'], ['https://rdap.registry-b.test/']]] };
const rdap = ({ registrar = 'Example Registrar, Inc.', registered = '2015-03-01T00:00:00Z', expires = inDays(400) } = {}) => ({
  objectClassName: 'domain',
  events: [{ eventAction: 'registration', eventDate: registered }, { eventAction: 'expiration', eventDate: expires }],
  entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', registrar]]] }],
});
function fetcher(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const r = routes[url];
    if (!r) return new Response('{"errorCode":404}', { status: 404 });
    return new Response(typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? r), { status: r.status ?? 200 });
  };
  fn.calls = calls;
  return fn;
}
const run = (hosts, { resolve = resolver(ok), fetchImpl = fetcher({ 'https://rdap.registry-a.test/domain/widgets.com': rdap() }), prior = {} } = {}) => checkDomains(hosts, { site: SITE, resolve, fetchImpl, prior, now: NOW, bootstrap: BOOT });
const kinds = (r) => r.findings.map((f) => `${f.kind}:${f.severity}:${f.subject}`);

test('flags a host that no longer resolves as dangling', async () => {
  const r = await run(['gone.widgets.com'], { resolve: resolver({ ...ok, 'gone.widgets.com *': err('ENOTFOUND') }) });
  assert.deepEqual(kinds(r), ['domain-dangling:high:gone.widgets.com']);
  assert.equal(r.findings[0].key, 'domain-dangling|gone.widgets.com|*');
});

test('flags a dangling CNAME target', async () => {
  const r = await run(['cdn.widgets.com'], { resolve: resolver({ 'cdn.widgets.com CNAME': ['widgets-assets.s3.amazonaws.com'], 'widgets-assets.s3.amazonaws.com *': err('ENOTFOUND'), 'widgets.com A': ['192.0.2.1'] }) });
  assert.deepEqual(kinds(r), ['domain-dangling:high:cdn.widgets.com']);
  assert.match(r.findings[0].reasons[0], /widgets-assets\.s3\.amazonaws\.com/);
});

test('a DNS timeout is unchecked, never dangling', async () => {
  const r = await run(['cdn.widgets.com'], { resolve: resolver({ 'cdn.widgets.com *': err('ETIMEOUT'), 'widgets.com A': ['192.0.2.1'] }) });
  assert.deepEqual(kinds(r), []);
  assert.match(r.notes.join(' '), /cdn\.widgets\.com.*unchecked/);
});

test('flags expiry within 30 days', async () => {
  const r = await run(['cdn.widgets.com'], { fetchImpl: fetcher({ 'https://rdap.registry-a.test/domain/widgets.com': rdap({ expires: inDays(10) }) }) });
  assert.deepEqual(kinds(r), ['domain-expiring:medium:widgets.com']);
  assert.deepEqual(r.results.domains['widgets.com'], { registrar: 'Example Registrar, Inc.', registered: '2015-03-01', expires: inDays(10).slice(0, 10) });
  assert.deepEqual(kinds(await run(['cdn.widgets.com'], { fetchImpl: fetcher({ 'https://rdap.registry-a.test/domain/widgets.com': rdap({ expires: inDays(45) }) }) })), []);
});

test('flags a registrar change and a re-registration', async () => {
  const prior = { domainCheck: '2026-11-10', domains: { 'widgets.com': { registrar: 'Old Registrar LLC', registered: '2015-03-01', expires: '2027-01-01' } } };
  const r = await run(['cdn.widgets.com'], { prior });
  assert.deepEqual(kinds(r), ['domain-changed:medium:widgets.com']);
  assert.match(r.findings[0].reasons[0], /Old Registrar LLC.*Example Registrar/);
  const reReg = { ...prior, domains: { 'widgets.com': { registrar: 'Example Registrar, Inc.', registered: '2010-01-01', expires: '2027-01-01' } } };
  assert.deepEqual(kinds(await run(['cdn.widgets.com'], { prior: reReg })), ['domain-changed:medium:widgets.com']);
});

test('treats an RDAP 500 or a malformed answer as unchecked', async () => {
  const prior = { domainCheck: '2026-11-10', domains: { 'widgets.com': { registrar: 'Old Registrar LLC', registered: '2015-03-01', expires: '2027-01-01' } } };
  for (const answer of [{ status: 500, body: 'oops' }, { body: '{"objectClassName":"domain"}' }, { body: 'not json' }]) {
    const r = await run(['cdn.widgets.com'], { prior, fetchImpl: fetcher({ 'https://rdap.registry-a.test/domain/widgets.com': answer }) });
    assert.deepEqual(kinds(r), []);
    assert.match(r.notes.join(' '), /widgets\.com.*unchecked/);
    assert.deepEqual(r.results.domains['widgets.com'], prior.domains['widgets.com'], 'the last known data is kept');
  }
});

test('skips checks within 7 days of the last, repeating the last findings', async () => {
  const resolve = resolver(ok);
  const fetchImpl = fetcher({});
  const kept = [{ kind: 'domain-expiring', key: 'domain-expiring|widgets.com|*', severity: 'medium', subject: 'widgets.com', reasons: ['expires soon'] }];
  const r = await run(['cdn.widgets.com'], { resolve, fetchImpl, prior: { domainCheck: '2026-11-21', domains: {}, domainFindings: kept } });
  assert.equal(r.checked, false);
  assert.deepEqual(resolve.calls, []);
  assert.deepEqual(fetchImpl.calls, []);
  assert.deepEqual(kinds(r), ['domain-expiring:medium:widgets.com']);
  const due = await run(['cdn.widgets.com'], { prior: { domainCheck: '2026-11-17', domains: {} } });
  assert.equal(due.checked, true);
  assert.equal(due.results.domainCheck, '2026-11-24');
});

test('finds the registrable domain by adding labels on not-found', async () => {
  const fetchImpl = fetcher({ 'https://rdap.registry-b.test/domain/shop.co.uk': rdap() });
  const r = await run(['cdn.shop.co.uk'], { resolve: resolver({ 'cdn.shop.co.uk A': ['192.0.2.1'], 'shop.co.uk A': ['192.0.2.1'] }), fetchImpl });
  assert.deepEqual(fetchImpl.calls, ['https://rdap.registry-b.test/domain/co.uk', 'https://rdap.registry-b.test/domain/shop.co.uk']);
  assert.ok(r.results.domains['shop.co.uk']);
});

test('one RDAP lookup per registrable domain', async () => {
  const fetchImpl = fetcher({ 'https://rdap.registry-a.test/domain/widgets.com': rdap() });
  await run(['cdn.widgets.com', 'api.widgets.com', 'widgets.com'], { resolve: resolver({ 'cdn.widgets.com A': ['192.0.2.1'], 'api.widgets.com A': ['192.0.2.1'], 'widgets.com A': ['192.0.2.1'] }), fetchImpl });
  assert.deepEqual(fetchImpl.calls, ['https://rdap.registry-a.test/domain/widgets.com']);
});

test('domainsToCheck lists approved and referenced third-party hosts, never own or undelegated ones', () => {
  const appr = approved({
    own: ['https://static.shop.example'],
    scripts: [entry({ id: 'w', match: 'https://cdn.widgets.com/w.js', trust: 'origin' }), entry({ id: 'own', match: `${SITE}/app.js`, trust: 'deploy' })],
    destinations: [{ match: 'https://*.payments.net', reason: 'r', approved: '2026-11-01' }, { match: 'POST https://api.tracker.io/c', reason: 'r', approved: '2026-11-01' }],
  });
  const snap = snapshot([{ path: '/', observed: { scripts: [ext('https://tags.adnetwork.com/t.js'), ext('https://static.shop.example/a.js'), ext('https://10.0.0.5/x.js'), ext('https://cdn.lab.test/y.js')] } }]);
  assert.deepEqual(domainsToCheck(appr, snap, SITE), ['api.tracker.io', 'cdn.widgets.com', 'payments.net', 'tags.adnetwork.com']);
});
