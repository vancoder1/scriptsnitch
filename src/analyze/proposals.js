// Turning findings into proposed changes to the approved file (design §9, §10): High findings are
// pending, Medium ones routine, the first run uses its own split, and stale entries are proposed
// for removal. Proposal = { site, finding, severity, section, mode, entry | id+add | id+remove }.
import { classifyUrl, slotOf } from './urls.js';
import { accountKey, accountKeyParams, sharedHostKind, wildcardCoversTenants, ownOrigins } from './hosts.js';
import { firstRunSplit } from './firstrun.js';
import { cspBaseline, parseCsp } from './csp.js';
import { siteSection, addEntry, addToEntry, removeEntry, addPending, setHeaders, entryKey, seenKeyOf, SECTIONS } from '../config/approved.js';
import { coversPage } from '../config/patterns.js';
import { isoDate, daysBetween } from '../util/time.js';

export const TODO_REASON = 'TODO: why does this page need it?';
const STALE_DAYS = 30;
const BANDS = ['plain', 'minified', 'packed'];
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu']);

const slug = (s) => s.toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\{token\}/g, 'build').replace(/\{version\}/g, 'v').replace(/\*/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');

// The pages an entry should cover: every page (`**`) if it was seen on any ordinary page, plus each
// sensitive page by its exact path, since a pattern never covers a sensitive page.
function pagesFor(f) {
  const sensitive = f.sensitivePages ?? [];
  const ordinary = (f.seenOn ?? []).filter((p) => !sensitive.includes(p));
  const pages = [...(ordinary.length ? ['**'] : []), ...sensitive];
  return pages.length ? pages : ['**'];
}

// A build folder: `/assets/index-{token}.js` -> `/assets/*-{token}.js`.
function folderPattern(slot) {
  const cut = slot.lastIndexOf('/') + 1;
  const name = slot.slice(cut);
  const at = name.indexOf('{token}');
  return at > 1 && /[-._]/.test(name[at - 1]) ? `${slot.slice(0, cut)}*${name.slice(at - 1)}` : slot;
}

function scriptTarget(d) {
  const u = new URL(d.url);
  if (d.own) {
    if (d.kind === 'hashed') return { match: folderPattern(d.slot), trust: 'deploy' };
    if (d.kind === 'versioned') return { match: d.slot.replace(/=\{version\}/g, '=*'), trust: 'deploy' };
    return { match: d.url, trust: 'deploy' };
  }
  if (d.kind === 'floating' && sharedHostKind(u.hostname) !== 'path') {
    const key = accountKey(d.url);
    return { match: `${u.origin}${u.pathname}${key?.where === 'query' ? `?${key.param}=${encodeURIComponent(key.key)}` : ''}`, trust: 'origin' };
  }
  return { match: d.url, trust: 'exact', sha256: [...new Set(d.hashes ?? [d.hash])] };
}

// The trust level §9 proposes for an external script by default.
export function suggestTrust(url, own) {
  const cls = classifyUrl(url);
  return scriptTarget({ url, own, kind: cls.kind, slot: slotOf(url, cls), hashes: [] }).trust;
}

const defaultBehavior = (inline = false) => ({ hosts: [], listens: [], input: false, eval: false, obfuscation: inline ? 'plain' : 'minified' });

function proposalFor(f, section, today) {
  const d = f.data ?? {};
  const base = { site: f.site, finding: f.key, severity: f.severity, mode: f.severity === 'high' ? 'pending' : 'routine' };
  const entry = (sectionName, fields) => ({ ...base, section: sectionName, entry: { ...fields, reason: TODO_REASON, approved: today } });
  const add = (sectionName, id, fields) => ({ ...base, section: sectionName, id, add: fields });
  switch (f.kind) {
    case 'new-origin': case 'new-slot': case 'new-own-script':
      return { ...entry('scripts', { id: slug(d.url), ...scriptTarget(d), pages: pagesFor(f), behavior: d.behavior ?? defaultBehavior() }), ...(d.sri && !d.own ? { sri: d.sri } : {}) };
    case 'new-version': {
      const old = section.scripts.find((e) => e.id === d.entryId);
      return { ...entry('scripts', { id: slug(d.url), match: d.url, trust: 'exact', sha256: [...new Set(d.hashes ?? [d.hash])], pages: old?.pages ?? pagesFor(f), behavior: mergeBehavior(old?.behavior ?? defaultBehavior(), d.behavior ?? defaultBehavior()) }), ...(d.sri ? { sri: d.sri } : {}) };
    }
    case 'new-inline': {
      const behavior = d.behavior ?? defaultBehavior(true);
      if (d.sensitive) {
        const existing = section.scripts.find((e) => e.match === 'inline' && e.trust === 'exact' && e.pages.includes(d.page));
        return existing ? add('scripts', existing.id, { template: [d.template] }) : entry('scripts', { id: `inline-${slug(d.page) || 'home'}`, match: 'inline', trust: 'exact', template: [d.template], pages: [d.page], behavior });
      }
      const existing = section.scripts.find((e) => e.match === 'inline' && e.trust === 'deploy' && coversPage(e.pages, d.page, false));
      return existing ? add('scripts', existing.id, { template: [d.template] }) : entry('scripts', { id: 'inline', match: 'inline', trust: 'deploy', template: [d.template], pages: ['**'], behavior });
    }
    case 'content-mismatch': return add('scripts', d.entryId, { sha256: f.evidence });
    case 'in-place-change': case 'own-change': case 'build-file': return add('scripts', d.entryId, { sha256: [d.hash] });
    case 'scope': return add('scripts', d.entryId, { pages: [d.page] });
    case 'listener': return d.entryId ? add('scripts', d.entryId, { listens: [d.listener] }) : null;
    case 'input-code': return d.entryId ? add('scripts', d.entryId, { input: true }) : null;
    case 'eval': return add('scripts', d.entryId, { eval: true });
    case 'obfuscation': return add('scripts', d.entryId, { obfuscation: d.band });
    case 'hostname': return add('scripts', d.entryId, { hosts: [d.host] });
    case 'new-destination': return entry('destinations', { match: d.destination, pages: pagesFor(f) });
    case 'probe-exfil': return d.approvable ? add('destinations', d.entry ?? d.destination, { receives: d.kinds ?? [d.kind] }) : null;
    case 'new-field': {
      const { frame, form, field, kind, count } = d.field;
      const existing = section.fields.find((e) => entryKey('fields', e) === entryKey('fields', d.field));
      if (existing) return add('fields', entryKey('fields', existing), { count: Math.max(count, existing.count ?? 1), ...(coversPage(existing.pages, d.page, f.sensitivePages?.includes(d.page)) ? {} : { pages: [d.page] }) });
      return entry('fields', { frame, form, field, kind, count, pages: pagesFor(f) });
    }
    case 'frame-field': {
      const existing = section.frames.find((e) => e.match === d.origin);
      return existing ? add('frames', existing.match, { fields: [d.kind] }) : entry('frames', { match: d.origin, fields: [d.kind], pages: pagesFor(f) });
    }
    case 'new-frame': return entry('frames', { match: d.origin, pages: pagesFor(f) });
    case 'peer-connection': return entry('allow', { what: 'peer-connection', pages: [d.page] });
    case 'headers-weaker': case 'csp-source': return { ...base, section: 'headers', id: d.page, add: { [d.header]: d.value } };
    default: return null;
  }
}

function mergeBehavior(a, b) {
  return {
    hosts: [...new Set([...(a.hosts ?? []), ...(b.hosts ?? [])])].sort(),
    listens: [...new Set([...(a.listens ?? []), ...(b.listens ?? [])])].sort(),
    input: Boolean(a.input || b.input),
    eval: Boolean(a.eval || b.eval),
    obfuscation: BANDS[Math.max(BANDS.indexOf(a.obfuscation ?? 'minified'), BANDS.indexOf(b.obfuscation ?? 'minified'))],
  };
}

function mergeFields(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === 'behavior') out.behavior = mergeBehavior(a.behavior ?? {}, v);
    else if (Array.isArray(v)) out[k] = [...new Set([...(a[k] ?? []), ...v])];
    else if (typeof v === 'boolean') out[k] = Boolean(a[k] || v);
    else if (k === 'count') out[k] = Math.max(a[k] ?? 1, v);
    else if (k === 'obfuscation') out[k] = BANDS[Math.max(BANDS.indexOf(a[k] ?? 'minified'), BANDS.indexOf(v))];
    else if (!(k in a)) out[k] = v;
  }
  if (out.pages?.includes('**')) out.pages = ['**', ...out.pages.filter((p) => p !== '**')];
  return out;
}

const mergeKey = (p) => {
  if (p.entry) {
    const e = p.entry;
    const name = p.section === 'scripts' ? `${e.match}|${e.trust}|${e.match === 'inline' ? e.pages.join(',') : ''}` : entryKey(p.section, e);
    return `${p.site}|${p.section}|entry|${name}`;
  }
  return `${p.site}|${p.section}|${p.remove ? 'remove' : 'add'}|${p.id}`;
};

// Routine proposals for the same target merge into one; pending ones stay one per finding, since
// each pending item names its finding key.
function merge(proposals) {
  const out = [];
  const byKey = new Map();
  for (const p of proposals) {
    const key = p.mode === 'routine' ? mergeKey(p) : `${p.finding}|${mergeKey(p)}`;
    const existing = byKey.get(key);
    if (!existing) { byKey.set(key, p); out.push(p); continue; }
    if (p.entry) existing.entry = mergeFields(existing.entry, p.entry);
    else if (p.add) existing.add = mergeFields(existing.add, p.add);
    if (p.finding && p.finding !== existing.finding) existing.also = [...new Set([...(existing.also ?? []), p.finding])];
  }
  return out;
}

function uniqueIds(proposals, approved) {
  const taken = new Map();
  const idsFor = (site) => {
    if (!taken.has(site)) taken.set(site, new Set(siteSection(approved, site).scripts.map((e) => e.id)));
    return taken.get(site);
  };
  for (const p of proposals) {
    if (p.section !== 'scripts' || !p.entry) continue;
    const ids = idsFor(p.site);
    let id = p.entry.id || 'script';
    for (let n = 2; ids.has(id); n++) id = `${p.entry.id}-${n}`;
    ids.add(id);
    p.entry = { ...p.entry, id };
  }
  return proposals;
}

// The header baseline for observed headers of a site's pages ({ [path]: { name: value } }): a value
// every page shares goes under `**`, the others under their page.
export function headerBaseline(byPath) {
  const paths = Object.keys(byPath);
  const norm = (name, value) => (name.startsWith('content-security-policy') ? cspBaseline(parseCsp(value)) : value);
  const out = {};
  const names = [...new Set(paths.flatMap((p) => Object.keys(byPath[p])))].sort();
  for (const name of names) {
    const values = paths.map((p) => byPath[p][name]);
    if (values.every((v) => v !== undefined && JSON.stringify(norm(name, v)) === JSON.stringify(norm(name, values[0])))) {
      (out['**'] ??= {})[name] = norm(name, values[0]);
      continue;
    }
    for (const p of paths) if (byPath[p][name] !== undefined) (out[p] ??= {})[name] = norm(name, byPath[p][name]);
  }
  return out;
}

export function proposalsFor(findings, approved, { now = Date.now(), headers = {} } = {}) {
  const today = isoDate(now);
  const proposals = [];
  for (const f of findings) {
    if (f.severity === 'info') continue;
    const p = proposalFor(f, siteSection(approved, f.site), today);
    if (p) proposals.push(p);
  }
  const firstRunSites = new Set([...findings.map((f) => f.site), ...Object.keys(headers)].filter((s) => !approved.sites[s]));
  for (const site of firstRunSites) {
    for (const [pattern, values] of Object.entries(headerBaseline(headers[site] ?? {}))) {
      proposals.push({ site, finding: null, severity: null, section: 'headers', mode: 'routine', id: pattern, add: values });
    }
  }
  const split = proposals.map((p) => (firstRunSites.has(p.site) && p.section !== 'headers' ? firstRunSplit([p], ownOrigins(p.site, siteSection(approved, p.site)))[0] : p));
  return uniqueIds(groupSiblings(merge(split)), approved);
}

// Three or more routine destinations on sibling subdomains of one parent become one `*.parent`
// pattern, except on shared hosts and account-keyed services.
export function groupSiblings(proposals) {
  const groups = new Map();
  const candidate = (p) => {
    if (p.section !== 'destinations' || p.mode !== 'routine' || !p.entry || p.entry.receives?.length) return null;
    const m = /^(https?|wss?):\/\/([a-z0-9.-]+)$/i.exec(p.entry.match);
    if (!m || accountKeyParams(`${p.entry.match}/`).length || accountKey(`${p.entry.match}/`)) return null;
    const labels = m[2].toLowerCase().split('.');
    if (labels.length < 3) return null;
    const parent = labels.slice(1).join('.');
    const pl = parent.split('.');
    if (pl.length === 2 && pl[1].length === 2 && SECOND_LEVEL.has(pl[0])) return null;
    if (sharedHostKind(m[2]) || wildcardCoversTenants(`*.${parent}`)) return null;
    return `${p.site}|${m[1].toLowerCase()}|${parent}`;
  };
  for (const p of proposals) {
    const key = candidate(p);
    if (key) groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const replaced = new Map();
  for (const [key, members] of groups) {
    if (members.length < 3) continue;
    const [, scheme, parent] = key.split('|');
    const [first, ...rest] = members;
    const grouped = { ...first, entry: rest.reduce((e, p) => mergeFields(e, p.entry), { ...first.entry, match: `${scheme}://*.${parent}` }), also: [...new Set([...(first.also ?? []), ...rest.flatMap((p) => [p.finding, ...(p.also ?? [])])])] };
    replaced.set(first, grouped);
    for (const p of rest) replaced.set(p, null);
  }
  return proposals.map((p) => (replaced.has(p) ? replaced.get(p) : p)).filter(Boolean);
}

// Entries not seen in any conclusive run for 30 days (or never, 30 days after approval).
export function staleProposals(approved, state, now = Date.now()) {
  const today = isoDate(now);
  const out = [];
  for (const site of Object.keys(approved.sites)) {
    const section = siteSection(approved, site);
    const seen = state.sites?.[site]?.seen ?? {};
    for (const name of SECTIONS) {
      for (const e of section[name]) {
        const last = seen[seenKeyOf(name, e)] ?? e.approved;
        if (daysBetween(last, today) >= STALE_DAYS) out.push({ site, finding: null, severity: null, section: name, mode: 'routine', id: entryKey(name, e), remove: true });
      }
    }
  }
  return out;
}

// Applies proposals for one site: routine ones to the live sections, pending ones to `pending`.
// A routine addition whose entry does not exist yet (its entry is itself still pending) is kept as
// a pending item so nothing is lost.
export function applyProposals(approved, site, proposals) {
  let next = approved;
  const order = (p) => (p.remove ? 0 : p.entry ? 1 : 2);
  for (const p of [...proposals].filter((x) => !x.site || x.site === site).sort((a, b) => order(a) - order(b))) {
    const asPending = () => addPending(next, site, { finding: p.finding, severity: p.severity, into: p.section, ...(p.section === 'headers' ? { add: { [p.id]: p.add } } : p.entry ? { entry: p.entry } : { id: p.id, add: p.add }) });
    if (p.mode === 'pending') { next = asPending(); continue; }
    if (p.remove) next = removeEntry(next, site, p.section, p.id);
    else if (p.section === 'headers') next = setHeaders(next, site, p.id, p.add);
    else if (p.entry) next = addEntry(next, site, p.section, p.entry);
    else {
      const exists = siteSection(next, site)[p.section].some((e) => entryKey(p.section, e) === p.id);
      next = exists ? addToEntry(next, site, p.section, p.id, p.add) : p.finding ? asPending() : next;
    }
  }
  return next;
}
