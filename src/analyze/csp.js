// Content-Security-Policy parsing and comparison on the policy that actually takes effect under CSP
// level 3 (design §10 "Weaker headers"). Nonces and hashes become the markers 'nonce' and 'hash', so
// their per-request churn never counts as a change.

const SCRIPT_DIRECTIVES = new Set(['script-src', 'script-src-elem', 'default-src']);
const WEAKNESS_DIRECTIVES = new Set(['script-src', 'script-src-elem', 'default-src', 'connect-src']);
const NEW_SOURCE_DIRECTIVES = new Set(['script-src', 'script-src-elem', 'default-src', 'connect-src', 'frame-src', 'child-src', 'worker-src', 'form-action']);
const WEAK_KEYWORDS = new Set(["'unsafe-inline'", "'unsafe-eval'", "'unsafe-hashes'"]);
const SCHEME_SOURCE = /^[a-z][a-z0-9+.-]*:$/;

function normalizeSource(source) {
  if (/^'nonce-/i.test(source)) return "'nonce'";
  if (/^'sha(256|384|512)-/i.test(source)) return "'hash'";
  if (source.startsWith("'")) return source.toLowerCase();
  const at = source.indexOf('://');
  if (at === -1) return source.toLowerCase();
  const slash = source.indexOf('/', at + 3);
  return slash === -1 ? source.toLowerCase() : source.slice(0, slash).toLowerCase() + source.slice(slash);
}

// A policy is a Map of directive -> Set of sources, the first occurrence of a directive winning, as
// browsers do. Policies are separated by commas, and Chrome joins two headers with a newline. Only the
// first is compared: any further policy can only restrict more.
export function parseCsp(value) {
  if (value === null || value === undefined || !String(value).trim()) return null;
  const policy = new Map();
  for (const part of String(value).split(/[,\n]/)[0].split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    const directive = name.toLowerCase();
    if (!policy.has(directive)) policy.set(directive, new Set(sources.filter(Boolean).map(normalizeSource)));
  }
  return policy;
}

// The approved-file form: { directive: [sorted sources] }.
export function cspBaseline(policy) {
  if (!policy) return null;
  return Object.fromEntries([...policy.keys()].sort().map((d) => [d, [...policy.get(d)].sort()]));
}

function toPolicy(x) {
  if (x === null || x === undefined) return null;
  if (x instanceof Map) return x;
  if (typeof x === 'string') return parseCsp(x);
  return new Map(Object.entries(x).map(([d, sources]) => [d.toLowerCase(), new Set(sources.map(normalizeSource))]));
}

function effective(policy, directive) {
  const sources = new Set(policy.get(directive));
  if (!SCRIPT_DIRECTIVES.has(directive)) return sources;
  if (sources.has("'strict-dynamic'")) {
    for (const s of [...sources]) if (!s.startsWith("'") || s === "'self'" || s === "'unsafe-inline'") sources.delete(s);
  } else if (sources.has("'nonce'") || sources.has("'hash'")) {
    sources.delete("'unsafe-inline'");
  }
  return sources;
}

export function compareCsp(baseInput, curInput) {
  const base = toPolicy(baseInput);
  const cur = toPolicy(curInput);
  const out = { weaker: [], newSources: [], stronger: [] };
  if (!base && !cur) return out;
  if (!base) { out.stronger.push('Content-Security-Policy added'); return out; }
  if (!cur) { out.weaker.push('Content-Security-Policy removed'); return out; }
  for (const directive of base.keys()) {
    if (!cur.has(directive)) out.weaker.push(`${directive} dropped`);
  }
  for (const directive of cur.keys()) {
    if (!base.has(directive)) { out.stronger.push(`${directive} added`); continue; }
    const before = effective(base, directive);
    const after = effective(cur, directive);
    const added = [...after].filter((s) => !before.has(s));
    for (const s of added) {
      if (WEAKNESS_DIRECTIVES.has(directive) && (s === '*' || SCHEME_SOURCE.test(s) || WEAK_KEYWORDS.has(s))) out.weaker.push(`${directive} now allows ${s}`);
      else if (NEW_SOURCE_DIRECTIVES.has(directive) && !s.startsWith("'")) out.newSources.push(`${directive} ${s}`);
    }
    if (!added.length && [...before].some((s) => !after.has(s))) out.stronger.push(`${directive} narrowed`);
  }
  return out;
}
