// State kept in issue bodies (design §6): an HTML comment `<!-- scriptsnitch:<name> <json> -->` at
// the top. `<` and `>` are written as JSON escapes, so no value (a script URL, say) can end the
// comment early. Only a marker at the very start of a body counts: page text quoted further down
// (a field name, a script URL, a diff) may carry a marker of its own.

const markerRe = (name) => new RegExp(`^<!-- scriptsnitch:${name} ([\\s\\S]*?) -->\\n?`);

export function readMarker(body, name) {
  const m = markerRe(name).exec(body ?? '');
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export function markerText(name, data) {
  return `<!-- scriptsnitch:${name} ${JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')} -->`;
}

export function writeMarker(body, name, data) {
  const rest = String(body ?? '').replace(markerRe(name), '');
  return `${markerText(name, data)}\n${rest}`;
}

const size = (state) => markerText('status', state).length;

// Removes keys of `map` in steps of a twentieth, in the given order, until `fits()`.
function trim(map, order, fits) {
  for (let i = 0; !fits() && i < order.length;) {
    const step = Math.max(1, Math.ceil((order.length - i) / 20));
    for (const k of order.slice(i, i + step)) delete map[k];
    i += step;
  }
}

// The site marker keeps under `limit`, leaving the rest of the issue body for the text. What goes,
// in order: the details of findings the issue no longer shows (dropped, muted), those findings
// themselves, every finding's reasons beyond the first, then the findings seen longest ago, Medium
// before High. A finding forgotten this way is new again if it comes back.
export function fitSiteState(state, limit = 30000) {
  const fits = (s) => markerText('site', s).length <= limit;
  if (fits(state)) return state;
  const out = structuredClone(state);
  const entries = () => Object.entries(out.findings);
  for (const [, e] of entries()) if (e.droppedAt || e.muted) { delete e.reasons; delete e.observedAs; }
  const dropped = entries().filter(([, e]) => e.droppedAt).sort((a, b) => a[1].droppedAt.localeCompare(b[1].droppedAt)).map(([k]) => k);
  trim(out.findings, dropped, () => fits(out));
  if (fits(out)) return out;
  for (const [, e] of entries()) if (e.reasons) e.reasons = e.reasons.slice(0, 1).map((r) => r.slice(0, 200));
  const rank = ([, e]) => (e.muted ? 0 : e.severity === 'high' ? 2 : 1);
  const order = entries().sort((a, b) => rank(a) - rank(b) || String(a[1].last).localeCompare(String(b[1].last))).map(([k]) => k);
  trim(out.findings, order, () => fits(out));
  return out;
}

// GitHub limits an issue body to 65536 characters; the status marker keeps under `limit`, dropping
// the oldest Medium sightings first, then the oldest run-log lines, then own-file hashes (a file
// whose hash is forgotten is taken as it is the next time it is seen).
export function fitStatusState(state, limit = 60000) {
  if (size(state) <= limit) return state;
  const out = structuredClone(state);
  const pairs = Object.entries(out.sightings).flatMap(([key, list]) => list.map((run) => [run, key])).sort((a, b) => a[0] - b[0]);
  for (let i = 0; size(out) > limit && i < pairs.length;) {
    const step = Math.max(1, Math.ceil((pairs.length - i) / 20));
    for (const [run, key] of pairs.slice(i, i + step)) {
      if (!out.sightings[key]) continue;
      const kept = out.sightings[key].filter((x) => x !== run);
      if (kept.length) out.sightings[key] = kept;
      else delete out.sightings[key];
    }
    i += step;
  }
  while (size(out) > limit && out.log.length > 1) out.log.splice(0, Math.max(1, Math.min(out.log.length - 1, Math.ceil(out.log.length / 20))));
  for (const site of Object.values(out.sites ?? {})) {
    if (site.ownHashes) trim(site.ownHashes, Object.keys(site.ownHashes), () => size(out) <= limit);
  }
  return out;
}
