// Cross-run state (design §6 "State, in full"), kept in two issue markers.
//
// StatusState, in the status issue:
//   { v: 1, run,
//     pages: { "<site><path>|<profile>": { lastConclusiveRun, inconclusiveStreak } },
//     sites: { [site]: { entrySlots: { [slot]: token }, marker, ownHashes: { [url]: short },
//                        inline: { [path]: short[] }, deployTokens: [token], seen: { [entryId]: run },
//                        domains: { [domain]: { registrar, registered, expires } }, domainCheck,
//                        domainFindings: [the last domain check's findings, repeated until the next] } },
//     sightings: { [findingKey]: [run, ...] },
//     log: [[isoDate, conclusivePages, high, medium, drill]] }
//
// SiteState, in each site issue:
//   { v: 1, site, findings: { [key]: { first, last, reported, missed, muted, droppedAt } } }

export function emptyStatusState() {
  return { v: 1, run: 0, pages: {}, sites: {}, sightings: {}, log: [] };
}

export function emptySiteState(site) {
  return { v: 1, site, findings: {} };
}

export function siteState(status, site) {
  status.sites[site] ??= { entrySlots: null, marker: null, ownHashes: {}, inline: {}, deployTokens: [], seen: {}, domains: {}, domainCheck: null, domainFindings: [] };
  return status.sites[site];
}
