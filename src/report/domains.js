// Domain risk (design §8): once every 7 days, each domain behind an approved script or destination,
// and each third-party host a page still uses, is checked. DNS: a host, or its CNAME target, that no
// longer resolves is dangling (anyone could register it and serve code to your pages). RDAP: expiry
// within 30 days, and a registrar change or re-registration since the last check. A lookup that fails
// is skipped for that week and noted, never reported as safe.
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';
import { siteSection } from '../config/approved.js';
import { parseDestinationPattern } from '../config/patterns.js';
import { ownOrigins, registrableCandidates, isKnownTld } from '../analyze/hosts.js';
import { findingKey } from '../analyze/keys.js';
import { isoDate, daysBetween } from '../util/time.js';

const CHECK_EVERY_DAYS = 7;
const EXPIRING_DAYS = 30;
const BOOTSTRAP_URL = 'https://data.iana.org/rdap/dns.json';
const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

const hostOfPattern = (pattern) => {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(parseDestinationPattern(pattern).url ?? pattern);
  return m ? m[1].toLowerCase().replace(/^\*\./, '') : null;
};
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return null; } };
const checkable = (h) => h && !isIP(h) && !h.includes('*') && h.includes('.') && isKnownTld(h.split('.').at(-1));

export function domainsToCheck(approved, snapshot, site) {
  const section = siteSection(approved, site);
  const own = new Set([...ownOrigins(site, section)].map(hostOf));
  const hosts = new Set();
  for (const name of ['scripts', 'destinations', 'frames']) {
    for (const e of section[name]) if (e.match && e.match !== 'inline') hosts.add(hostOfPattern(e.match));
  }
  for (const page of snapshot.pages.filter((p) => p.site === site)) {
    for (const r of Object.values(page.profiles)) {
      for (const v of r?.visits ?? []) {
        if (!v.conclusive || v.role === 'drill') continue;
        for (const s of v.scripts) hosts.add(hostOf(s.ref.url));
        for (const d of v.destinations) hosts.add(hostOf(d.url));
        for (const f of v.frames) hosts.add(hostOf(f.origin));
      }
    }
  }
  return [...hosts].filter((h) => checkable(h) && !own.has(h)).sort();
}

async function lookup(resolve, host, type) {
  try { return { records: await resolve(host, type) }; } catch (e) { return NOT_FOUND.has(e.code) ? { missing: true } : { error: e.code ?? e.message }; }
}

// 'ok', 'dangling' with the name that does not resolve, or 'unchecked'.
async function checkDns(resolve, host) {
  const cname = await lookup(resolve, host, 'CNAME');
  if (cname.error) return { status: 'unchecked', why: cname.error };
  const target = cname.records?.[0] ?? host;
  const a = await lookup(resolve, target, 'A');
  if (a.records?.length) return { status: 'ok' };
  const aaaa = await lookup(resolve, target, 'AAAA');
  if (aaaa.records?.length) return { status: 'ok' };
  if (a.error || aaaa.error) return { status: 'unchecked', why: a.error ?? aaaa.error };
  return { status: 'dangling', target };
}

function rdapServer(bootstrap, domain) {
  const tld = domain.split('.').at(-1);
  const service = bootstrap?.services?.find(([tlds]) => tlds.includes(tld));
  return service?.[1]?.find((u) => u.startsWith('https://')) ?? null;
}

function parseRdap(body) {
  const event = (action) => body.events?.find((e) => e.eventAction === action)?.eventDate;
  const expires = event('expiration');
  const registered = event('registration');
  if (!expires && !registered) return null;
  const registrar = body.entities?.find((e) => e.roles?.includes('registrar'));
  const fn = registrar?.vcardArray?.[1]?.find((f) => f[0] === 'fn')?.[3];
  return { registrar: fn ?? registrar?.handle ?? null, registered: registered?.slice(0, 10) ?? null, expires: expires?.slice(0, 10) ?? null };
}

// Asks for the last two labels first, adding one while the registry answers "not found".
async function checkRdap(fetchImpl, bootstrap, host) {
  const candidates = registrableCandidates(host);
  for (const domain of candidates) {
    const base = rdapServer(bootstrap, domain);
    if (!base) return { status: 'unchecked', domain: candidates[0], why: 'no RDAP server for its top-level domain' };
    let res;
    try { res = await fetchImpl(`${base}domain/${domain}`, { headers: { accept: 'application/rdap+json' }, signal: AbortSignal.timeout(15000) }); } catch (e) { return { status: 'unchecked', domain, why: e.message }; }
    if (res.status === 404) continue;
    if (!res.ok) return { status: 'unchecked', domain, why: `HTTP ${res.status}` };
    let parsed = null;
    try { parsed = parseRdap(JSON.parse(await res.text())); } catch { parsed = null; }
    return parsed ? { status: 'ok', domain, data: parsed } : { status: 'unchecked', domain, why: 'an answer without registration or expiry dates' };
  }
  return { status: 'unchecked', domain: candidates.at(-1) ?? host, why: 'the registry does not know it' };
}

const finding = (site, kind, subject, severity, reasons, data = {}) => ({ kind, key: findingKey(kind, subject), severity, site, page: '*', profiles: [], subject, reasons, evidence: [], attributedTo: null, data, seenOn: [], firstRun: false, drill: false });

export async function checkDomains(hosts, { site, resolve = dns.resolve, fetchImpl = fetch, prior = {}, now = Date.now(), bootstrap = null }) {
  const today = isoDate(now);
  const domains = { ...(prior.domains ?? {}) };
  if (prior.domainCheck && daysBetween(prior.domainCheck, today) < CHECK_EVERY_DAYS) {
    return { checked: false, findings: prior.domainFindings ?? [], notes: [], results: { domains, domainCheck: prior.domainCheck, domainFindings: prior.domainFindings ?? [] } };
  }
  const findings = [];
  const notes = [];
  for (const host of hosts) {
    const r = await checkDns(resolve, host);
    if (r.status === 'dangling') findings.push(finding(site, 'domain-dangling', host, 'high', [r.target === host ? `${host} no longer resolves in DNS: whoever registers it can serve code to your pages` : `${host} points (CNAME) at ${r.target}, which no longer resolves: whoever claims it can serve code to your pages`], { host, target: r.target }));
    if (r.status === 'unchecked') notes.push(`DNS for ${host} was unchecked this week (${r.why})`);
  }
  let boot = bootstrap;
  if (!boot) {
    try { const res = await fetchImpl(BOOTSTRAP_URL, { signal: AbortSignal.timeout(15000) }); boot = res.ok ? await res.json() : null; } catch { boot = null; }
    if (!boot) notes.push('the RDAP bootstrap file could not be fetched, so registrations were unchecked this week');
  }
  if (boot) {
    const done = new Set();
    for (const host of hosts) {
      const first = registrableCandidates(host)[0];
      if (!first || done.has(first)) continue;
      const r = await checkRdap(fetchImpl, boot, host);
      done.add(first);
      done.add(r.domain);
      if (r.status !== 'ok') { notes.push(`the registration of ${r.domain} was unchecked this week (${r.why})`); continue; }
      const before = prior.domains?.[r.domain];
      const found = r.data;
      if (found.expires && daysBetween(today, found.expires) <= EXPIRING_DAYS) findings.push(finding(site, 'domain-expiring', r.domain, 'medium', [`${r.domain} expires on ${found.expires}; if it lapses, someone else can register it and serve code to your pages`], found));
      if (before?.registrar && found.registrar && before.registrar !== found.registrar) findings.push(finding(site, 'domain-changed', r.domain, 'medium', [`the registrar of ${r.domain} changed from ${before.registrar} to ${found.registrar}: a sale or transfer, the way polyfill.io began`], { before, after: found }));
      else if (before?.registered && found.registered && found.registered > before.registered) findings.push(finding(site, 'domain-changed', r.domain, 'medium', [`${r.domain} was registered again on ${found.registered} (it was ${before.registered}): it may have a new owner`], { before, after: found }));
      domains[r.domain] = found;
    }
  }
  const kept = findings.map(({ kind, key, severity, site: s, page, subject, reasons }) => ({ kind, key, severity, site: s, page, profiles: [], subject, reasons, evidence: [], seenOn: [], firstRun: false }));
  return { checked: true, findings, notes, results: { domains, domainCheck: today, domainFindings: kept } };
}
