// Finding keys (design §5 "Finding"): kind|subject|page. Stable across runs; changing how a key is
// built rewrites every open issue.

export const findingKey = (kind, subject, page = '*') => `${kind}|${subject}|${page}`;

export function parseKey(key) {
  const first = key.indexOf('|');
  const last = key.lastIndexOf('|');
  return { kind: key.slice(0, first), subject: key.slice(first + 1, last), page: key.slice(last + 1) };
}

const RANK = { info: 0, medium: 1, high: 2 };
export const maxSeverity = (a, b) => (RANK[a] >= RANK[b] ? a : b);
export const severityRank = (s) => RANK[s];

// Collects findings, merging the same key seen on several pages, profiles or visits.
export function createCollector() {
  const byKey = new Map();
  return {
    add({ kind, subject, page = '*', severity, site, profile, reasons = [], evidence = [], attributedTo = null, data = {}, drill = false }) {
      const key = findingKey(kind, subject, page);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { kind, key, severity, site, page, profiles: profile ? [profile] : [], subject, reasons: [...new Set(reasons)], evidence: [...new Set(evidence)], attributedTo, data, proposal: null, drill, sightings: 1 });
        return;
      }
      existing.severity = maxSeverity(existing.severity, severity);
      if (profile && !existing.profiles.includes(profile)) existing.profiles = [...existing.profiles, profile].sort();
      existing.reasons = [...new Set([...existing.reasons, ...reasons])];
      existing.evidence = [...new Set([...existing.evidence, ...evidence])];
      existing.sightings++;
    },
    all: () => [...byKey.values()],
  };
}
