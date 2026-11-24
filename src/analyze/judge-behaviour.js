// Behaviour, field, frame and header findings (design §10): computed on every visit for every
// script, because behaviour can change while content does not. Behaviour fields of an entry
// (eval, obfuscation, hostnames) are judged only for approved scripts: a new script's proposal
// already carries what it was seen doing.
import { classifyUrl, slotOf } from './urls.js';
import { accountKey, sharedHostKind } from './hosts.js';
import { coveringScripts, coveringDestinations, originOf } from './approval.js';
import { isIgnoredHost } from './hostnames.js';
import { BAND_ORDER } from './obfuscation.js';
import { baselineFor, compareHeaders } from './headers.js';
import { cspBaseline, parseCsp } from './csp.js';
import { scriptIdentity } from './keys.js';
import { judgedVisits } from './judge-scripts.js';
import { coversPage, matchListener, matchUrl } from '../config/patterns.js';
import { short } from '../util/hash.js';

const SENSITIVE = new Set(['password', 'card', 'iban']);
const FIELD_ROLES = new Set(['field', 'form', 'submit']);
const STATIC_PATH = /\.(jpe?g|png|gif|svg|css|js|ico|woff2?)$/i;
const STORAGE_KINDS = new Set(['card', 'password']);

const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } };
const patternHost = (pattern) => /^(?:[A-Z]+\s+)?[a-z]+:\/\/([^/?#:]+)/i.exec(pattern)?.[1]?.toLowerCase() ?? null;
const hostMatches = (pattern, host) => (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern);
const clip = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

// The subject of a destination: its origin, plus the account key on keyed services and the path on
// hosts that serve anyone's files.
export function destinationSubject(url) {
  let u;
  try { u = new URL(url); } catch { return url; }
  const origin = `${u.protocol}//${u.host}`;
  const key = accountKey(url);
  if (key?.where === 'query') return `${origin}${u.pathname}?${key.param}=${key.key}`;
  if (key?.where === 'path' || sharedHostKind(u.hostname) === 'path') return `${origin}${u.pathname}`;
  return origin;
}

// The entries that approve a script on a page, including trust inherited from an approved loader.
// Memoised per page and script: the same lookups repeat for every visit and behaviour.
function approvalsFor(ctx, ref, page) {
  if (!ref || (!ref.url && !ref.template)) return [];
  const key = `${page.path}
${ref.url ?? ref.template}`;
  let entries = ctx.approvals.get(key);
  if (!entries) {
    const covering = coveringScripts(ref, ctx.section, page.path, page.sensitive);
    entries = covering.length ? covering : (ref.url && ctx.inherited(page.path, ref.url)) || [];
    ctx.approvals.set(key, entries);
  }
  return entries;
}

// What each script was seen doing in this run, for its proposal: { hosts, listens, input, eval, obfuscation }.
function observe(ctx, ref) {
  const id = scriptIdentity(ref) ?? 'unknown';
  let o = ctx.observed.get(id);
  if (!o) { o = { hosts: new Set(), listens: new Set(), input: false, eval: false, obfuscation: ref?.template ? 'plain' : 'minified' }; ctx.observed.set(id, o); }
  return o;
}

const isOwnRef = (ctx, ref) => Boolean(ref?.template) || (Boolean(ref?.url) && ctx.own.has(originOf(ref.url)));

function labelOf(ref, entries) {
  if (entries[0]) return entries[0].id;
  if (ref?.url) return slotOf(ref.url, classifyUrl(ref.url));
  if (ref?.template) return `inline ${short(ref.template)}`;
  return ref?.contentHash ? `code ${short(ref.contentHash)}` : 'unknown script';
}

function judgeDestinations(ctx, page, profile, v, id) {
  const base = { site: ctx.site, profile, path: page.path, visits: [id] };
  for (const d of v.destinations) {
    const covering = coveringDestinations(d.url, d.method, ctx.section, page.path, page.sensitive);
    for (const e of covering) ctx.markSeen('destinations', e);
    if (covering.length) continue;
    const changed = ctx.changed.has(scriptIdentity(d.initiator));
    const reasons = [];
    if (d.phase === 'probe') reasons.push('contacted while the probe held the network');
    if (page.sensitive && d.viaCode) reasons.push('sent by code created at runtime, which has no URL of its own');
    if (page.sensitive && changed) reasons.push('sent by a script whose content changed in this run');
    const subject = destinationSubject(d.url);
    ctx.add({
      ...base, kind: 'new-destination', subject, severity: reasons.length ? 'high' : 'medium', attributedTo: d.initiator,
      reasons: reasons.length ? reasons : [`a request to ${subject}, which no destination entry approves for ${page.path}`],
      evidence: [clip(`${d.method} ${d.url}`)], data: { url: d.url, method: d.method, type: d.type, destination: subject, page: page.path, sensitive: page.sensitive },
    });
  }
  const forPage = ctx.section.destinations.filter((d) => coversPage(d.pages, page.path, page.sensitive) && patternHost(d.match));
  for (const host of v.linkHosts) {
    const covering = forPage.filter((d) => hostMatches(patternHost(d.match), host.toLowerCase()));
    for (const e of covering) ctx.markSeen('destinations', e);
    if (covering.length) continue;
    const subject = `https://${host.toLowerCase()}`;
    ctx.add({ ...base, kind: 'new-destination', subject, severity: 'medium', reasons: [`a <link> prefetch or preconnect to ${host}, which no destination entry approves`], evidence: [host], data: { url: subject, method: 'GET', type: 'Link', destination: subject, page: page.path, sensitive: page.sensitive } });
  }
}

function judgeProbe(ctx, page, profile, v, id) {
  if (!v.probe) return;
  const base = { site: ctx.site, profile, path: page.path, visits: [id] };
  const methodOf = (url) => v.destinations.find((d) => d.url === url)?.method ?? 'POST';
  const covering = (url) => coveringDestinations(url, methodOf(url), ctx.section, page.path, page.sensitive);
  for (const h of v.probe.hits) {
    let u;
    try { u = new URL(h.url); } catch { u = null; }
    const subject = destinationSubject(h.url);
    if (u && STATIC_PATH.test(u.pathname)) {
      ctx.add({ ...base, kind: 'probe-exfil', subject: `static ${u.origin}${u.pathname} ${h.kind}`, severity: 'high', attributedTo: h.initiator, reasons: [`a ${h.kind} value from the probe was sent to a static-file path (${h.encoding}); no approval can allow this`], evidence: [clip(h.url)], data: { url: h.url, kind: h.kind, approvable: false, page: page.path } });
      continue;
    }
    const entries = covering(h.url);
    if (entries.some((e) => e.receives?.includes(h.kind))) continue;
    ctx.add({ ...base, kind: 'probe-exfil', subject: `${subject} ${h.kind}`, severity: 'high', attributedTo: h.initiator, reasons: [`a ${h.kind} value from the probe reached ${subject} (${h.encoding}), which may not receive it`], evidence: [clip(h.url)], data: { url: h.url, kind: h.kind, destination: subject, entry: entries[0]?.match ?? null, approvable: true, page: page.path } });
  }
  const typed = [...new Set(v.fields.map((f) => f.kind).filter((k) => SENSITIVE.has(k)))].sort();
  for (const g of v.probe.growth) {
    const entries = covering(g.url);
    if (entries.some((e) => e.receives?.length)) continue;
    const subject = destinationSubject(g.url);
    ctx.add({ ...base, kind: 'probe-exfil', subject: `${subject} growth`, severity: 'high', reasons: [`the ${g.field} of a request to ${subject} grew with the length of the values typed, as an encrypted copy would`], evidence: [clip(g.url)], data: { url: g.url, destination: subject, kinds: typed.length ? typed : ['card'], entry: entries[0]?.match ?? null, approvable: true, page: page.path } });
  }
  for (const s of v.probe.storage) {
    if (!STORAGE_KINDS.has(s.kind)) continue;
    ctx.add({ ...base, kind: 'probe-exfil', subject: `storage ${s.kind} ${s.where}`, severity: 'high', reasons: [`a ${s.kind} value from the probe was kept in ${s.where}; no approval can allow this`], data: { kind: s.kind, where: s.where, approvable: false, page: page.path } });
  }
}

function judgeListeners(ctx, page, profile, v, id) {
  for (const l of v.listeners) {
    observe(ctx, l.script).listens.add(`${l.kind}:${l.role}:${l.event}`);
    const entries = approvalsFor(ctx, l.script, page);
    if (entries.some((e) => e.behavior?.listens?.some((p) => matchListener(p, l)))) continue;
    const listener = `${l.kind}:${l.role}:${l.event}`;
    const high = FIELD_ROLES.has(l.role) && !(entries.length && isOwnRef(ctx, l.script));
    const who = l.script ? labelOf(l.script, entries) : 'a script scriptsnitch could not name';
    ctx.add({ site: ctx.site, profile, path: page.path, visits: [id], kind: 'listener', subject: `${labelOf(l.script, entries)} ${listener}`, severity: high ? 'high' : 'medium', attributedTo: l.script, reasons: [`${who} listens for ${l.event} on a ${l.kind} ${l.role}${entries.length ? ', which its entry does not approve' : ''}`], data: { listener, entryId: entries[0]?.id ?? null, script: l.script, page: page.path } });
  }
}

function judgeInputCode(ctx, page, profile, v, id) {
  for (const ref of v.inputCode) {
    observe(ctx, ref).input = true;
    const entries = approvalsFor(ctx, ref, page);
    if (entries.some((e) => e.behavior?.input)) continue;
    const label = labelOf(ref, entries);
    ctx.add({ site: ctx.site, profile, path: page.path, visits: [id], kind: 'input-code', subject: label, severity: entries.length ? 'medium' : 'high', attributedTo: ref, reasons: [entries.length ? `${label} ran code while sensitive fields were being filled, which its entry does not approve` : `${label}, which nothing approves, ran code while sensitive fields were being filled`], data: { entryId: entries[0]?.id ?? null, script: ref, page: page.path } });
  }
}

function judgeFields(ctx, page, profile, v, id) {
  const base = { site: ctx.site, profile, path: page.path, visits: [id] };
  for (const f of v.fields) {
    if (!SENSITIVE.has(f.kind)) continue;
    const approvals = ctx.section.fields.filter((a) => a.frame === f.frame && a.form === f.form && a.field === f.field && a.kind === f.kind && coversPage(a.pages, page.path, page.sensitive));
    const allowed = Math.max(0, ...approvals.map((a) => a.count ?? 1));
    for (const a of approvals) ctx.markSeen('fields', a);
    if (approvals.length && f.count <= allowed) continue;
    const subject = `${f.frame} ${f.form} ${f.field} ${f.kind}`;
    ctx.add({ ...base, kind: 'new-field', subject, severity: 'high', reasons: [approvals.length ? `${f.count} ${f.kind} fields with this signature, where ${allowed} is approved` : `a ${f.kind} field that no entry approves`], data: { field: f, page: page.path } });
  }
  for (const fr of v.frames) {
    if (ctx.own.has(fr.origin)) continue;
    const approvals = ctx.section.frames.filter((a) => matchUrl(a.match, fr.origin) && coversPage(a.pages, page.path, page.sensitive));
    for (const a of approvals) ctx.markSeen('frames', a);
    const kinds = fr.fieldKinds.filter((k) => SENSITIVE.has(k));
    for (const k of kinds) {
      if (approvals.some((a) => a.fields?.includes(k))) continue;
      ctx.add({ ...base, kind: 'frame-field', subject: `${fr.origin} ${k}`, severity: 'high', reasons: [`an iframe from ${fr.origin} contains a ${k} field, which no frame entry approves`], data: { origin: fr.origin, kind: k, page: page.path } });
    }
    if (!kinds.length && !approvals.length && /^https?:\/\//.test(fr.origin)) {
      ctx.add({ ...base, kind: 'new-frame', subject: fr.origin, severity: 'medium', reasons: [`an iframe from ${fr.origin}, which no frame entry approves for ${page.path}`], data: { origin: fr.origin, page: page.path } });
    }
  }
}

function judgeCode(ctx, page, profile, v, id) {
  const base = { site: ctx.site, profile, path: page.path, visits: [id] };
  const known = ctx.knownHosts;
  for (const s of v.scripts) {
    const ref = s.kind === 'code' ? s.creator : s.ref;
    if (!ref) continue;
    const scriptHost = ref.url ? hostOf(ref.url) : hostOf(page.url);
    const newHosts = s.hosts.map((h) => h.toLowerCase()).filter((host) => !(host === scriptHost || isIgnoredHost(host) || known.own.has(host) || known.patterns.some((p) => hostMatches(p, host))));
    const seen = observe(ctx, ref);
    for (const h of newHosts) seen.hosts.add(h);
    if (s.kind === 'code') seen.eval = true;
    else if (BAND_ORDER[s.band] > BAND_ORDER[seen.obfuscation]) seen.obfuscation = s.band;
    const entries = approvalsFor(ctx, ref, page);
    if (!entries.length) continue;
    const label = labelOf(ref, entries);
    if (s.kind === 'code' && !entries.some((e) => e.behavior?.eval)) {
      ctx.add({ ...base, kind: 'eval', subject: label, severity: 'medium', attributedTo: ref, reasons: [`${label} creates code at runtime, which its entry does not approve`], data: { entryId: entries[0].id } });
    }
    if (s.kind !== 'code') {
      const allowed = Math.max(...entries.map((e) => BAND_ORDER[e.behavior?.obfuscation ?? 'minified']));
      if (BAND_ORDER[s.band] > allowed) {
        ctx.add({ ...base, kind: 'obfuscation', subject: label, severity: 'medium', attributedTo: ref, reasons: [`${label} now looks ${s.band}, beyond its approved band`], data: { entryId: entries[0].id, band: s.band } });
      }
    }
    for (const host of newHosts) {
      const severity = page.sensitive && !(isOwnRef(ctx, ref) && ctx.evident) ? 'medium' : 'info';
      ctx.add({ ...base, kind: 'hostname', subject: `${label} ${host}`, severity, attributedTo: ref, reasons: [`${label}'s code mentions ${host}, a host name not seen there before`], evidence: [host], data: { entryId: entries[0].id, host } });
    }
  }
}

function judgeHeaders(ctx, page, profile, v, id) {
  const baseline = baselineFor(ctx.section.headers, page.path);
  const names = Object.keys(baseline);
  if (!names.length) return;
  const observed = Object.fromEntries(Object.entries(v.document.headers).map(([k, val]) => [k.toLowerCase(), val]));
  if (!observed['content-security-policy'] && v.document.metaCsp?.length) observed['content-security-policy'] = v.document.metaCsp[0];
  const base = { site: ctx.site, profile, path: page.path, visits: [id], page: page.path };
  for (const name of names) {
    if (baseline[name] === null) continue;
    const r = compareHeaders({ [name]: baseline[name] }, observed);
    const value = name.startsWith('content-security-policy') ? cspBaseline(parseCsp(observed[name])) : observed[name] ?? null;
    if (r.weaker.length) ctx.add({ ...base, kind: 'headers-weaker', subject: name, severity: 'high', reasons: r.weaker, data: { header: name, value, page: page.path } });
    else if (r.newCspSources.length) ctx.add({ ...base, kind: 'csp-source', subject: name, severity: 'medium', reasons: r.newCspSources.map((s) => `new source ${s}`), data: { header: name, value, sources: r.newCspSources, page: page.path } });
    if (r.stronger.length) ctx.add({ ...base, kind: 'headers-stronger', subject: name, severity: 'info', reasons: r.stronger });
    if (r.reportOnlyChanged) ctx.add({ ...base, kind: 'csp-report-only', subject: name, severity: 'info', reasons: ['the report-only policy changed'] });
    for (const changed of r.changed) ctx.add({ ...base, kind: 'note', subject: `header ${changed}`, severity: 'info', reasons: [`${changed} changed`] });
  }
}

function judgePeers(ctx, page, profile, visits) {
  const withPeers = visits.filter(({ v }) => v.peers > 0);
  if (!withPeers.length) return;
  const allows = ctx.section.allow.filter((a) => a.what === 'peer-connection' && coversPage(a.pages, page.path, page.sensitive));
  for (const a of allows) ctx.markSeen('allow', a);
  if (allows.length) return;
  const count = Math.max(...withPeers.map(({ v }) => v.peers));
  ctx.add({ site: ctx.site, profile, path: page.path, visits: withPeers.map(({ id }) => id), kind: 'peer-connection', subject: 'RTCPeerConnection', page: page.path, severity: 'high', reasons: [`${count} live peer connection${count > 1 ? 's' : ''} (WebRTC), which can send data without any request scriptsnitch sees`], data: { page: page.path } });
}

export function judgeBehaviour(ctx, pages) {
  const ownHosts = new Set([...ctx.own].map(hostOf));
  const patterns = [
    ...ctx.section.destinations.map((d) => patternHost(d.match)).filter(Boolean),
    ...ctx.section.scripts.flatMap((e) => e.behavior?.hosts ?? []).map((h) => h.toLowerCase()),
  ];
  ctx.knownHosts = { own: ownHosts, patterns };
  ctx.approvals = new Map();
  ctx.observed = new Map();
  for (const { page, profile, visits } of judgedVisits(ctx, pages)) {
    for (const { v, id } of visits) {
      judgeDestinations(ctx, page, profile, v, id);
      judgeProbe(ctx, page, profile, v, id);
      judgeListeners(ctx, page, profile, v, id);
      judgeInputCode(ctx, page, profile, v, id);
      judgeFields(ctx, page, profile, v, id);
      judgeCode(ctx, page, profile, v, id);
      judgeHeaders(ctx, page, profile, v, id);
      if (v.consent?.found && !v.consent.accepted) ctx.add({ site: ctx.site, profile, path: page.path, kind: 'note', subject: `consent ${v.consent.found} ${page.path}`, severity: 'info', reasons: [`a ${v.consent.found} consent banner was found but not accepted, so tags loaded after consent were not seen`] });
    }
    judgePeers(ctx, page, profile, visits);
  }
}
