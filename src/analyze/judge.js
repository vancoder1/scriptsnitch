// The report job's judgment (design §10): turns a snapshot's observations into findings, using the
// approved file and the cross-run state. Pure: returns the findings and the updated state.
import { siteSection } from '../config/approved.js';
import { coversPage } from '../config/patterns.js';
import { ownOrigins } from './hosts.js';
import { siteState } from '../state.js';
import { entrySlotsOf, deployEvident } from './deploy.js';
import { judgeScripts } from './judge-scripts.js';
import { judgeBehaviour } from './judge-behaviour.js';
import { createCollector, scriptIdentity } from './keys.js';
import { DRILL_ORIGIN } from '../capture/drill.js';

const CONTENT_KINDS = new Set(['new-origin', 'new-slot', 'new-version', 'content-mismatch', 'in-place-change', 'own-change', 'new-own-script', 'build-file', 'new-inline', 'cloaking', 'accepted']);
const BEHAVIOUR_SIGNS = new Set(['new-destination', 'listener', 'input-code', 'probe-exfil']);
const DRILL_EXPECTED = ['new-origin', 'listener', 'probe-exfil'];
const WINDOW = 7;

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

function siteContext({ site, approved, status, snapshot, now, pages, includeVisit, collector, drill }) {
  const section = siteSection(approved, site);
  const own = ownOrigins(site, section);
  const st = siteState(status, site);
  const visits = pages.flatMap((p) => Object.values(p.profiles).filter((r) => r?.conclusive).flatMap((r) => r.visits.filter((v) => v.conclusive && includeVisit(v))));
  const current = entrySlotsOf(visits, own);
  const currentMarker = snapshot.sites?.[site]?.deployMarker ?? null;
  const evident = deployEvident({ previousEntrySlots: st.entrySlots, currentEntrySlots: current, previousMarker: st.marker, currentMarker });
  const inherited = new Map();
  const changed = new Set();
  return {
    site, section, own, st, run: status.run, snapshot, now, evident, pages, includeVisit, changed,
    entry: { previous: st.entrySlots, current },
    marker: currentMarker,
    firstRun: !approved.sites[site],
    inherit: (path, url, entries) => inherited.set(`${path} ${url}`, entries),
    inherited: (path, url) => inherited.get(`${path} ${url}`),
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

function notSeen(ctx) {
  const judged = ctx.pages.filter((p) => Object.values(p.profiles).some((r) => r?.conclusive));
  for (const e of ctx.section.scripts) {
    if (ctx.st.seen[e.id] === ctx.run) continue;
    if (!judged.some((p) => coversPage(e.pages, p.path, p.sensitive))) continue;
    ctx.add({ kind: 'not-seen', subject: e.id, severity: 'info', reasons: [`${e.id} was not seen on any page it covers in this run`] });
  }
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
  const inconclusive = [];

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
    const ctx = judgeSite({ site, approved, status, snapshot, now, pages, includeVisit: (v) => v.role !== 'drill', collector, drill: false });
    if (ctx.firstRun) firstRunSites.add(site);
    notSeen(ctx);
    for (const c of snapshot.crossCheck) {
      if (c.note && pages.some((p) => Object.values(p.profiles).some((r) => r?.visits.some((v) => v.scripts.some((s) => s.ref.url === c.url))))) {
        ctx.add({ kind: 'note', subject: `cross-check ${c.url}`, severity: 'info', reasons: [`the cloaking cross-check could not compare ${c.url}: ${c.note}`] });
      }
    }
    // Entry slots of pages that were inconclusive this run are kept, so a replacement next run is
    // still recognised as a deploy.
    ctx.st.entrySlots = { ...(ctx.st.entrySlots ?? {}), ...ctx.entry.current };
    ctx.st.marker = ctx.marker ?? ctx.st.marker;
    // Drill visits are judged on a throwaway copy of the state, so they change nothing that lasts.
    const scratch = structuredClone({ ...status, sites: { ...status.sites, [site]: state.sites?.[site] } });
    judgeSite({ site, approved, status: scratch, snapshot, now, pages, includeVisit: (v) => v.role === 'drill', collector: drillCollector, drill: true });
  }

  const all = combine(collector.all());
  for (const f of all) f.firstRun = firstRunSites.has(f.site);
  const { reportable, pendingSightings } = confirm(all, status, run);
  const drillFindings = combine(drillCollector.all()).filter((f) => f.severity !== 'info');
  return {
    findings: reportable,
    held: pendingSightings,
    info: all.filter((f) => f.severity === 'info'),
    drill: drillResult(drillFindings, snapshot.pages),
    inconclusive,
    state: status,
  };
}
