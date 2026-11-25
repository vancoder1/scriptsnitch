// The report job's judgment (design §10): turns a snapshot's observations into findings, using the
// approved file and the cross-run state. Pure: returns the findings and the updated state.
import { siteSection, seenKeyOf, emptyApproved } from '../config/approved.js';
import { coversPage } from '../config/patterns.js';
import { ownOrigins } from './hosts.js';
import { siteState, emptyStatusState, ownKey } from '../state.js';
import { entrySlotsOf, deployEvident } from './deploy.js';
import { judgeScripts } from './judge-scripts.js';
import { judgeBehaviour } from './judge-behaviour.js';
import { createCollector, scriptIdentity, bound } from './keys.js';
import { DRILL_ORIGIN } from '../capture/drill.js';
import { TRACKED_HEADERS } from './headers.js';
import { isoDate } from '../util/time.js';
import { short } from '../util/hash.js';

const CONTENT_KINDS = new Set(['new-origin', 'new-slot', 'new-version', 'content-mismatch', 'in-place-change', 'own-change', 'new-own-script', 'build-file', 'new-inline', 'cloaking', 'accepted']);
const BEHAVIOUR_SIGNS = new Set(['new-destination', 'listener', 'input-code', 'probe-exfil']);
const DRILL_EXPECTED = ['new-origin', 'listener', 'probe-exfil'];
const NEW_SCRIPT_KINDS = new Set(['new-origin', 'new-slot', 'new-own-script', 'new-inline', 'new-version']);
const WINDOW = 7;

// How a finding can be recognised in a later run's observations, whatever is approved by then: a
// finding no longer raised but still observed was approved (or accepted) and is resolved; one no
// longer observed has vanished, and a vanished High stays listed (attackers remove skimmers).
export function observedAs(f) {
  return observedAsRaw(f).map((x) => bound(x, 320));
}

function observedAsRaw(f) {
  const d = f.data ?? {};
  switch (f.kind) {
    case 'new-origin': case 'new-slot': case 'new-own-script': case 'new-version': case 'build-file': case 'in-place-change': case 'own-change':
      return d.url ? [...new Set(d.hashes ?? [d.hash])].filter(Boolean).map((h) => `content:${d.url}|${h}`) : [];
    case 'content-mismatch': case 'cloaking': return d.url ? f.evidence.map((h) => `content:${d.url}|${h}`) : [];
    case 'new-inline': case 'new-destination': case 'probe-exfil': case 'new-field': case 'frame-field': case 'new-frame': return [`subject:${f.subject}`];
    case 'listener': return [`listener:${scriptIdentity(d.script)}|${d.listener}`];
    case 'input-code': return [`input:${scriptIdentity(d.script)}`];
    case 'peer-connection': return [`peer:${f.page}`];
    case 'headers-weaker': case 'csp-source': return [`headers:${f.page}|${f.subject}`];
    default: return [];
  }
}

// Everything this snapshot observed, in observedAs terms: the snapshot judged with nothing approved.
export function observedIndex(snapshot, now = Date.now()) {
  const r = judge({ snapshot, approved: emptyApproved(), state: emptyStatusState(), now });
  const index = new Set();
  for (const f of [...r.findings, ...r.held, ...r.info]) for (const x of f.observedAs) index.add(x);
  for (const p of snapshot.pages) {
    if (Object.values(p.profiles).some((x) => x?.conclusive)) for (const h of TRACKED_HEADERS) index.add(`headers:${p.path}|${h}`);
  }
  return index;
}

// §10 "Combination": a script with two or more findings, one of them a behaviour sign, has all of
// them raised to High. Info entries are notes, not findings, and do not count.
export function combine(findings) {
  const byScript = new Map();
  for (const f of findings) {
    const id = f.severity !== 'info' ? scriptIdentity(f.attributedTo) : null;
    if (!id) continue;
    if (!byScript.has(id)) byScript.set(id, []);
    byScript.get(id).push(f);
  }
  for (const group of byScript.values()) {
    if (group.length < 2 || !group.some((f) => BEHAVIOUR_SIGNS.has(f.kind))) continue;
    for (const f of group) {
      if (f.severity !== 'high') f.reasons = [...f.reasons, 'raised to High: the same script shows a behaviour sign in this run'];
      f.severity = 'high';
    }
  }
  return findings;
}

// §10 "Confirmation": High counts on one sighting; Medium needs two, in two visits of one run or in
// two runs within the last 7. Records each run a Medium was seen, per key, in state.sightings.
export function confirm(findings, state, run) {
  const reportable = [];
  const pendingSightings = [];
  for (const [key, runs] of Object.entries(state.sightings)) {
    const kept = runs.filter((r) => r > run - WINDOW);
    if (kept.length) state.sightings[key] = kept;
    else delete state.sightings[key];
  }
  for (const f of findings) {
    if (f.severity === 'high') { reportable.push(f); continue; }
    if (f.severity !== 'medium') continue;
    const prior = (state.sightings[f.key] ?? []).filter((r) => r < run);
    state.sightings[f.key] = [...prior, run];
    if ((f.seen ?? 1) >= 2 || prior.length) reportable.push(f);
    else pendingSightings.push(f);
  }
  return { reportable, pendingSightings };
}

function siteContext({ site, approved, status, snapshot, now, pages, includeVisit, collector, drill, acceptedByDeploy = new Set() }) {
  const section = siteSection(approved, site);
  const own = ownOrigins(site, section);
  const st = siteState(status, site);
  const visits = pages.flatMap((p) => Object.values(p.profiles).filter((r) => r?.conclusive).flatMap((r) => r.visits.filter((v) => v.conclusive && includeVisit(v))));
  const current = entrySlotsOf(visits, own);
  const currentMarker = snapshot.sites?.[site]?.deployMarker ?? null;
  const evident = deployEvident({ previousEntrySlots: st.entrySlots, currentEntrySlots: current, previousMarker: st.marker, currentMarker });
  const inherited = new Map();
  const changed = new Set();
  const seenNow = new Set();
  const today = isoDate(now);
  return {
    site, section, own, st, run: status.run, snapshot, now, evident, pages, includeVisit, changed, seenNow,
    markSeen: (sectionName, e) => { const k = seenKeyOf(sectionName, e); seenNow.add(k); st.seen[k] = today; },
    entry: { previous: st.entrySlots, current },
    // Own files known before this run: only these, and entry files of known slots, vouch for others.
    ownBaseline: new Set(Object.keys(st.ownHashes)),
    marker: currentMarker,
    firstRun: !approved.sites[site],
    inherit: (path, url, entries) => inherited.set(`${path} ${url}`, entries),
    inherited: (path, url) => inherited.get(`${path} ${url}`),
    // What a deploy (or the build's chunk map) accepted, not an approval, in observedAs terms.
    acceptByDeploy: (x) => acceptedByDeploy.add(bound(x, 320)),
    add: (f) => {
      collector.add({ ...f, site, drill });
      if (CONTENT_KINDS.has(f.kind)) changed.add(scriptIdentity(f.attributedTo));
    },
  };
}

function judgeSite(args) {
  const ctx = siteContext(args);
  if (ctx.evident) ctx.st.deployTokens = [];
  judgeScripts(ctx, args.pages);
  judgeBehaviour(ctx, args.pages);
  return ctx;
}

// When every page of a site was conclusive, the per-file state is cut down to what this run loaded,
// so hashes, accepted templates and entry slots of old builds do not pile up in the status marker.
function prune(st, pages) {
  const seen = pages.flatMap((p) => Object.values(p.profiles).filter((r) => r?.conclusive).flatMap((r) => r.visits).filter((v) => v.conclusive && v.role !== 'drill').map((v) => ({ v, path: p.path })));
  const urls = new Set(seen.flatMap(({ v }) => v.scripts.map((s) => s.ref.url).filter(Boolean)));
  const loaded = new Set([...urls].map(ownKey));
  for (const k of Object.keys(st.ownHashes)) if (!loaded.has(k)) delete st.ownHashes[k];
  const templates = new Map();
  for (const { v, path } of seen) for (const s of v.scripts) if (s.kind === 'inline') (templates.get(path) ?? templates.set(path, new Set()).get(path)).add(short(s.ref.template));
  for (const path of Object.keys(st.inline)) {
    const keep = st.inline[path].filter((t) => templates.get(path)?.has(t));
    if (keep.length) st.inline[path] = keep;
    else delete st.inline[path];
  }
}

function notSeen(ctx) {
  const judged = ctx.pages.filter((p) => Object.values(p.profiles).some((r) => r?.conclusive));
  for (const e of ctx.section.scripts) {
    if (ctx.seenNow.has(e.id)) continue;
    if (!judged.some((p) => coversPage(e.pages, p.path, p.sensitive))) continue;
    ctx.add({ kind: 'not-seen', subject: e.id, severity: 'info', reasons: [`${e.id} was not seen on any page it covers in this run`] });
  }
}

// The tracked security headers each page served, from its first judged visit: the first run's
// proposal and `approve --headers` adopt these.
function observedHeaders(pages) {
  const out = {};
  for (const p of pages) {
    const v = Object.values(p.profiles).filter((r) => r?.conclusive).flatMap((r) => r.visits).find((x) => x.conclusive && x.role !== 'drill');
    if (!v) continue;
    const headers = Object.fromEntries(Object.entries(v.document.headers).map(([k, val]) => [k.toLowerCase(), val]).filter(([k]) => TRACKED_HEADERS.includes(k)));
    if (!headers['content-security-policy'] && v.document.metaCsp?.length) headers['content-security-policy'] = v.document.metaCsp[0];
    out[p.path] = headers;
  }
  return out;
}

function drillResult(findings, pages) {
  const drilled = pages.filter((p) => Object.values(p.profiles).some((r) => r?.conclusive && r.visits.some((v) => v.role === 'drill' && v.conclusive)));
  if (!drilled.length) return null;
  const fromDrill = (f) => f.subject.includes(DRILL_ORIGIN) || f.attributedTo?.url?.startsWith(DRILL_ORIGIN);
  const missed = DRILL_EXPECTED.filter((kind) => !findings.some((f) => f.kind === kind && fromDrill(f)));
  return { findings, result: missed.length ? 'fail' : 'pass', missed };
}

export function judge({ snapshot, approved, state, now = Date.now() }) {
  const status = structuredClone(state);
  status.run += 1;
  const run = status.run;
  const collector = createCollector();
  const drillCollector = createCollector();
  const sites = [...new Set(snapshot.pages.map((p) => p.site))];
  const firstRunSites = new Set();
  const acceptedByDeploy = new Set();
  const inconclusive = [];
  const observed = new Map();
  const headers = {};

  for (const p of snapshot.pages) {
    for (const [profile, r] of Object.entries(p.profiles)) {
      if (!r) continue;
      const key = `${p.site}${p.path}|${profile}`;
      const prev = status.pages[key] ?? { lastConclusiveRun: null, inconclusiveStreak: 0 };
      status.pages[key] = r.conclusive ? { lastConclusiveRun: run, inconclusiveStreak: 0 } : { lastConclusiveRun: prev.lastConclusiveRun, inconclusiveStreak: prev.inconclusiveStreak + 1 };
      if (!r.conclusive) inconclusive.push({ site: p.site, page: p.path, profile, reason: r.reason });
    }
  }

  for (const site of sites) {
    const pages = snapshot.pages.filter((p) => p.site === site);
    const ctx = judgeSite({ site, approved, status, snapshot, now, pages, includeVisit: (v) => v.role !== 'drill', collector, drill: false, acceptedByDeploy });
    if (ctx.firstRun) firstRunSites.add(site);
    for (const [id, o] of ctx.observed) observed.set(`${site} ${id}`, o);
    headers[site] = observedHeaders(pages);
    notSeen(ctx);
    for (const c of snapshot.crossCheck) {
      if (c.note && pages.some((p) => Object.values(p.profiles).some((r) => r?.visits.some((v) => v.scripts.some((s) => s.ref.url === c.url))))) {
        ctx.add({ kind: 'note', subject: `cross-check ${c.url}`, severity: 'info', reasons: [`the cloaking cross-check could not compare ${c.url}: ${c.note}`] });
      }
    }
    // Entry slots of pages that were inconclusive this run are kept, so a replacement next run is
    // still recognised as a deploy; when all were conclusive, only this run's slots are kept.
    const allConclusive = pages.every((p) => Object.values(p.profiles).every((r) => !r || r.conclusive));
    if (allConclusive) prune(ctx.st, pages);
    ctx.st.entrySlots = allConclusive ? ctx.entry.current : { ...(ctx.st.entrySlots ?? {}), ...ctx.entry.current };
    ctx.st.marker = ctx.marker ?? ctx.st.marker;
    // Drill visits are judged on a throwaway copy of the state, so they change nothing that lasts.
    const scratch = structuredClone({ ...status, sites: { ...status.sites, [site]: state.sites?.[site] } });
    judgeSite({ site, approved, status: scratch, snapshot, now, pages, includeVisit: (v) => v.role === 'drill', collector: drillCollector, drill: true });
  }

  const all = combine(collector.all());
  const sensitive = new Set(snapshot.pages.filter((p) => p.sensitive).map((p) => `${p.site}${p.path}`));
  for (const f of all) {
    f.firstRun = firstRunSites.has(f.site);
    f.observedAs = observedAs(f);
    f.sensitivePages = f.seenOn.filter((p) => sensitive.has(`${f.site}${p}`));
    const o = NEW_SCRIPT_KINDS.has(f.kind) ? observed.get(`${f.site} ${scriptIdentity(f.attributedTo)}`) : null;
    if (o) f.data.behavior = { hosts: [...o.hosts].sort(), listens: [...o.listens].sort(), input: o.input, eval: o.eval, obfuscation: o.obfuscation };
  }
  const { reportable, pendingSightings } = confirm(all, status, run);
  const drillFindings = combine(drillCollector.all()).filter((f) => f.severity !== 'info').map((f) => ({ ...f, observedAs: [] }));
  return {
    findings: reportable,
    held: pendingSightings,
    info: all.filter((f) => f.severity === 'info'),
    drill: drillResult(drillFindings, snapshot.pages),
    inconclusive,
    headers,
    acceptedByDeploy: [...acceptedByDeploy],
    state: status,
  };
}
