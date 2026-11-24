// The report job's judgment (design §10): turns a snapshot's observations into findings, using the
// approved file and the cross-run state. Pure: returns the findings and the updated state.
import { siteSection } from '../config/approved.js';
import { ownOrigins } from './hosts.js';
import { siteState } from '../state.js';
import { entrySlotsOf, deployEvident } from './deploy.js';
import { judgeScripts } from './judge-scripts.js';
import { createCollector } from './keys.js';

export function judge({ snapshot, approved, state, now = Date.now(), extraJudges = [] }) {
  const status = structuredClone(state);
  status.run += 1;
  const collector = createCollector();
  const sites = [...new Set(snapshot.pages.map((p) => p.site))];
  const contexts = [];

  for (const site of sites) {
    const section = siteSection(approved, site);
    const own = ownOrigins(site, section);
    const st = siteState(status, site);
    const pages = snapshot.pages.filter((p) => p.site === site);
    const visits = pages.flatMap((p) => Object.values(p.profiles).filter((r) => r?.conclusive).flatMap((r) => r.visits));
    const current = entrySlotsOf(visits, own);
    const currentMarker = snapshot.sites?.[site]?.deployMarker ?? null;
    const evident = deployEvident({ previousEntrySlots: st.entrySlots, currentEntrySlots: current, previousMarker: st.marker, currentMarker });
    if (evident) st.deployTokens = [];
    const ctx = {
      site, section, own, st, run: status.run, snapshot, now, evident, pages,
      entry: { previous: st.entrySlots, current },
      firstRun: !approved.sites[site],
      add: (f) => collector.add({ ...f, site }),
    };
    judgeScripts(ctx, pages);
    for (const extra of extraJudges) extra(ctx, pages);
    contexts.push(ctx);
    st.entrySlots = current;
    st.marker = currentMarker;
  }

  const all = collector.all();
  const firstRunSites = new Set(contexts.filter((c) => c.firstRun).map((c) => c.site));
  for (const f of all) f.firstRun = firstRunSites.has(f.site);
  return {
    findings: all.filter((f) => f.severity !== 'info'),
    info: all.filter((f) => f.severity === 'info'),
    state: status,
  };
}
