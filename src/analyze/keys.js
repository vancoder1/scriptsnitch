// Finding keys (design §5 "Finding"): kind|subject|page. Stable across runs; changing how a key is
// built rewrites every open issue.
import { short } from '../util/hash.js';

export const findingKey = (kind, subject, page = '*') => `${kind}|${subject}|${page}`;

export function parseKey(key) {
  const first = key.indexOf('|');
  const last = key.lastIndexOf('|');
  return { kind: key.slice(0, first), subject: key.slice(first + 1, last), page: key.slice(last + 1) };
}

const RANK = { info: 0, medium: 1, high: 2 };
export const maxSeverity = (a, b) => (RANK[a] >= RANK[b] ? a : b);
export const severityRank = (s) => RANK[s];

// One string per script identity: its URL, its inline template, or the hash of code without a URL.
export function scriptIdentity(ref) {
  if (!ref) return null;
  if (ref.url) return ref.url;
  if (ref.template) return `inline ${short(ref.template)}`;
  return ref.contentHash ? `code ${short(ref.contentHash)}` : null;
}

// Collects findings, merging the same key seen on several pages, profiles or visits. `visits` are
// ids of the visits the finding was observed in (confirmation counts them); `path` is the page.
export function createCollector() {
  const byKey = new Map();
  return {
    add({ kind, subject, page = '*', path = page, severity, site, profile, visits = [], reasons = [], evidence = [], attributedTo = null, data = {}, drill = false }) {
      const key = findingKey(kind, subject, page);
      let f = byKey.get(key);
      if (!f) {
        f = { kind, key, severity, site, page, profiles: [], subject, reasons: [], evidence: [], attributedTo, data, proposal: null, drill, seenOn: [], seen: 0, visitIds: new Set() };
        byKey.set(key, f);
      }
      f.severity = maxSeverity(f.severity, severity);
      if (profile && !f.profiles.includes(profile)) f.profiles = [...f.profiles, profile].sort();
      if (path !== '*' && !f.seenOn.includes(path)) f.seenOn = [...f.seenOn, path].sort();
      f.reasons = [...new Set([...f.reasons, ...reasons])];
      f.evidence = [...new Set([...f.evidence, ...evidence])];
      f.attributedTo ??= attributedTo;
      // The value kinds of one probe-exfil finding (several kinds to one endpoint) are merged.
      if (f.data.kinds && data.kinds) f.data.kinds = [...new Set([...f.data.kinds, ...data.kinds])].sort();
      for (const v of visits) f.visitIds.add(v);
      f.seen = f.visitIds.size;
    },
    all: () => [...byKey.values()].map(({ visitIds, ...f }) => f),
  };
}
