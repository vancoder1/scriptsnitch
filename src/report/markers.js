// State kept in issue bodies (design §6): an HTML comment `<!-- scriptsnitch:<name> <json> -->` at
// the top. `<` and `>` are written as JSON escapes, so no value (a script URL, say) can end the
// comment early.

const markerRe = (name) => new RegExp(`<!-- scriptsnitch:${name} ([\\s\\S]*?) -->\\n?`);

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

// GitHub limits an issue body to 65536 characters; the status marker keeps under `limit`, dropping
// the oldest Medium sightings first, then the oldest run-log lines.
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
  while (size(out) > limit && out.log.length) out.log.splice(0, Math.max(1, Math.ceil(out.log.length / 20)));
  return out;
}
