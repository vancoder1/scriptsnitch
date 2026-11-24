// scriptsnitch/approved.json: what is allowed, and pending proposals (design §9). Functions here
// never mutate their input; they return a new approved file.
import { readFileSync } from 'node:fs';
import { parseJsonText, JsonSyntaxError, stableStringify } from '../util/json.js';
import { checkValue, SchemaError, join } from './schema.js';
import { validatePattern, parseDestinationPattern } from './patterns.js';
import { sharedHostKind, wildcardCoversTenants } from '../analyze/hosts.js';

export class ApprovedError extends Error {
  constructor(message, { label, pointer = null }) {
    super(`${label}${pointer !== null ? ` ${pointer || '/'}` : ''}: ${message}`);
    this.name = 'ApprovedError';
    this.label = label;
    this.pointer = pointer;
  }
}

export class UnknownPendingError extends Error {
  constructor(key) {
    super(`no pending proposal for finding ${key}`);
    this.name = 'UnknownPendingError';
  }
}

export const SECTIONS = ['scripts', 'destinations', 'frames', 'fields', 'allow'];
const SENSITIVE_KINDS = ['password', 'card', 'iban'];
const FIELD_KINDS = [...SENSITIVE_KINDS, 'email', 'name'];
const HEX64 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const hex64 = { type: 'string', pattern: HEX64, patternMessage: 'expected a 64-character lowercase SHA-256' };
const text = { type: 'string', pattern: /\S/, patternMessage: 'cannot be empty' };
const date = { type: 'string', pattern: DATE, patternMessage: 'expected a date as YYYY-MM-DD' };
const pattern = (type) => ({ type: 'string', check: (v) => validatePattern(v, type) });
const pages = { spec: { type: 'array', items: pattern('page'), minItems: 1 }, default: ['**'] };
const common = { reason: { spec: text, required: true }, approved: { spec: date, required: true } };

const behavior = {
  type: 'object',
  fields: {
    hosts: { spec: { type: 'array', items: { type: 'string' } }, default: [] },
    listens: { spec: { type: 'array', items: pattern('listener') }, default: [] },
    input: { spec: { type: 'boolean' }, default: false },
    eval: { spec: { type: 'boolean' }, default: false },
    obfuscation: { spec: { type: 'string', enum: ['plain', 'minified', 'packed'] }, default: 'minified' },
  },
};

const script = {
  type: 'object',
  fields: {
    id: { spec: { type: 'string', pattern: /^[a-z0-9][a-z0-9._-]*$/, patternMessage: 'an id uses lowercase letters, digits, dots, dashes and underscores' }, required: true },
    match: { spec: { type: 'string', check: (v) => (v === 'inline' ? null : validatePattern(v, 'url')) }, required: true },
    trust: { spec: { type: 'string', enum: ['exact', 'origin', 'deploy'] }, required: true },
    sha256: { spec: { type: 'array', items: hex64, minItems: 1, unique: true } },
    template: { spec: { type: 'array', items: hex64, minItems: 1, unique: true } },
    pages,
    behavior: { spec: behavior, default: {} },
    ...common,
  },
};

const destination = {
  type: 'object',
  fields: {
    match: { spec: pattern('destination'), required: true },
    receives: { spec: { type: 'array', items: { type: 'string', enum: FIELD_KINDS }, unique: true } },
    pages,
    ...common,
  },
};

const frame = {
  type: 'object',
  fields: {
    match: { spec: pattern('url'), required: true },
    fields: { spec: { type: 'array', items: { type: 'string', enum: SENSITIVE_KINDS }, unique: true }, default: [] },
    pages,
    ...common,
  },
};

const field = {
  type: 'object',
  fields: {
    frame: { spec: text, required: true },
    form: { spec: text, required: true },
    field: { spec: text, required: true },
    kind: { spec: { type: 'string', enum: SENSITIVE_KINDS }, required: true },
    count: { spec: { type: 'integer', min: 1, max: 20 }, default: 1 },
    pages,
    ...common,
  },
};

const allow = { type: 'object', fields: { what: { spec: { type: 'string', enum: ['peer-connection'] }, required: true }, pages, ...common } };

const pending = {
  type: 'object',
  fields: {
    finding: { spec: { type: 'string', pattern: /^[a-z-]+\|.+\|.+$/, patternMessage: 'a finding key is kind|subject|page' }, required: true },
    severity: { spec: { type: 'string', enum: ['high', 'medium'] }, required: true },
    into: { spec: { type: 'string', enum: [...SECTIONS, 'headers'] }, required: true },
    entry: { spec: { type: 'object', values: { type: 'any' } } },
    id: { spec: text },
    add: { spec: { type: 'object', values: { type: 'any' } } },
  },
  check: (p) => ((p.entry ? 1 : 0) + (p.add ? 1 : 0) === 1 && (!p.add || p.id) ? null : 'a pending item has either an entry, or an id with fields to add'),
};

const site = {
  type: 'object',
  fields: {
    own: { spec: { type: 'array', items: { type: 'string' }, unique: true }, default: [] },
    scripts: { spec: { type: 'array', items: script }, default: [] },
    destinations: { spec: { type: 'array', items: destination }, default: [] },
    frames: { spec: { type: 'array', items: frame }, default: [] },
    fields: { spec: { type: 'array', items: field }, default: [] },
    allow: { spec: { type: 'array', items: allow }, default: [] },
    headers: { spec: { type: 'object', values: { type: 'object', values: { type: 'any' } } }, default: {} },
    pending: { spec: { type: 'array', items: pending }, default: [] },
  },
};

const approvedSpec = {
  type: 'object',
  fields: {
    version: { spec: { type: 'integer', min: 1, max: 1 }, required: true },
    sites: { spec: { type: 'object', values: site }, default: {} },
  },
};

const hostOf = (urlPattern) => /^[a-z][a-z0-9+.-]*:\/\/([^/?#:]+)/i.exec(urlPattern)?.[1]?.toLowerCase() ?? '';
const isTodo = (reason) => typeof reason === 'string' && /^TODO\b/.test(reason.trim());
const fieldKey = (f) => `${f.frame}|${f.form}|${f.field}|${f.kind}`;

// Semantic checks beyond the shape. Each issue: { level: 'error'|'warning', pointer, message }.
function semanticIssues(approved) {
  const issues = [];
  const err = (pointer, message) => issues.push({ level: 'error', pointer, message });
  for (const [origin, s] of Object.entries(approved.sites ?? {})) {
    const base = join('/sites', origin);
    let u;
    try { u = new URL(origin); } catch { u = null; }
    if (!u || u.origin !== origin) err(base, `"${origin}" is not an origin`);
    (s.own ?? []).forEach((o, i) => {
      let ou;
      try { ou = new URL(o); } catch { ou = null; }
      if (!ou || ou.origin !== o || o.includes('*')) err(join(`${base}/own`, i), `"${o}" must be one exact origin, such as https://static.example.com`);
      else if (sharedHostKind(ou.hostname) === 'path') err(join(`${base}/own`, i), `"${o}" is a shared host that serves anyone's files; it cannot be your own`);
    });
    const ids = new Set();
    (s.scripts ?? []).forEach((sc, i) => {
      const p = join(`${base}/scripts`, i);
      if (ids.has(sc.id)) err(`${p}/id`, `duplicate id "${sc.id}"`);
      ids.add(sc.id);
      const inline = sc.match === 'inline';
      if (sc.trust === 'exact') {
        if (inline && !sc.template) err(p, 'an exact inline entry needs its template hashes');
        if (!inline && /[*{]/.test(sc.match)) err(`${p}/match`, 'an exact entry needs a literal URL, without wildcards or placeholders');
        if (!inline && !sc.sha256) err(p, 'an exact entry needs the sha256 of the approved content');
      }
      if (!inline) {
        const host = hostOf(sc.match);
        if ((sc.trust === 'origin' || sc.trust === 'deploy') && sharedHostKind(host) === 'path') {
          err(`${p}/trust`, `${host} is a shared host that serves anyone's files; only exact trust is allowed there`);
        }
        if (wildcardCoversTenants(host)) err(`${p}/match`, `${host} would cover other people's sites on a shared domain; name the exact host`);
      }
    });
    (s.destinations ?? []).forEach((d, i) => {
      const host = hostOf(parseDestinationPattern(d.match).url);
      if (wildcardCoversTenants(host)) err(join(`${base}/destinations`, i) + '/match', `${host} would cover other people's sites on a shared domain; name the exact host`);
    });
    (s.frames ?? []).forEach((f, i) => {
      if (wildcardCoversTenants(hostOf(f.match))) err(join(`${base}/frames`, i) + '/match', `${hostOf(f.match)} would cover other people's sites on a shared domain`);
    });
  }
  return issues;
}

function normalizeSite(s) {
  return checkValue(s ?? {}, site, '');
}

export function emptyApproved() {
  return { version: 1, sites: {} };
}

export function validateApproved(approved) {
  try {
    checkValue(approved, approvedSpec, '');
  } catch (e) {
    if (e instanceof SchemaError) return [{ level: 'error', pointer: e.pointer, message: e.detail }];
    throw e;
  }
  return semanticIssues(approved);
}

export function parseApproved(textValue, label) {
  let raw;
  try {
    raw = parseJsonText(textValue, label);
  } catch (e) {
    if (e instanceof JsonSyntaxError) throw new ApprovedError(e.message.replace(`${label}: `, ''), { label });
    throw e;
  }
  let approved;
  try {
    approved = checkValue(raw, approvedSpec, '');
  } catch (e) {
    if (e instanceof SchemaError) throw new ApprovedError(e.detail, { label, pointer: e.pointer });
    throw e;
  }
  const errors = semanticIssues(approved).filter((i) => i.level === 'error');
  if (errors.length) throw new ApprovedError(errors[0].message, { label, pointer: errors[0].pointer });
  return approved;
}

export function loadApproved(path) {
  let textValue;
  try { textValue = readFileSync(path, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  return parseApproved(textValue, path);
}

const SORT_KEYS = {
  scripts: (e) => e.id,
  destinations: (e) => e.match,
  frames: (e) => e.match,
  fields: fieldKey,
  allow: (e) => `${e.what}|${(e.pages ?? []).join(',')}`,
  pending: (e) => e.finding,
};

export function serializeApproved(approved) {
  const copy = structuredClone(approved);
  for (const s of Object.values(copy.sites)) {
    s.own?.sort();
    for (const [section, key] of Object.entries(SORT_KEYS)) {
      s[section]?.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    }
  }
  return stableStringify(copy);
}

export function siteSection(approved, origin) {
  return normalizeSite(approved.sites[origin]);
}

function withSite(approved, origin, fn) {
  const copy = structuredClone(approved);
  copy.sites[origin] = normalizeSite(copy.sites[origin]);
  fn(copy.sites[origin]);
  return copy;
}

// How an entry is named in proposals, pending items and the cross-run "seen" dates.
export function entryKey(section, e) {
  if (section === 'scripts') return e.id;
  if (section === 'fields') return fieldKey(e);
  if (section === 'allow') return `${e.what} ${(e.pages ?? ['**']).join(',')}`;
  return e.match;
}
const findEntry = (s, section, id) => (s[section] ?? []).find((e) => entryKey(section, e) === id);
// The key under which the status state records the date an entry was last seen.
export const seenKeyOf = (section, e) => (section === 'scripts' ? e.id : `${section} ${entryKey(section, e)}`);

export function addEntry(approved, origin, section, entry) {
  return withSite(approved, origin, (s) => { s[section].push(structuredClone(entry)); });
}

function mergeInto(target, add) {
  for (const [key, value] of Object.entries(add)) {
    if (key === 'behavior') { target.behavior ??= {}; mergeInto(target.behavior, value); continue; }
    if (Array.isArray(value)) target[key] = [...new Set([...(target[key] ?? []), ...value])];
    else target[key] = value;
  }
}

export function addToEntry(approved, origin, section, id, add) {
  return withSite(approved, origin, (s) => {
    const entry = findEntry(s, section, id);
    if (!entry) throw new Error(`no ${section} entry ${id} for ${origin}`);
    mergeInto(entry, section === 'scripts' && !('behavior' in add) && ['hosts', 'listens', 'input', 'eval', 'obfuscation'].some((k) => k in add) ? { behavior: add } : add);
  });
}

// Sets header baseline values for a page pattern (values of null stop a header from being judged).
export function setHeaders(approved, origin, pattern, values) {
  return withSite(approved, origin, (s) => { s.headers[pattern] = { ...(s.headers[pattern] ?? {}), ...values }; });
}

export function replaceHeaders(approved, origin, headers) {
  return withSite(approved, origin, (s) => { s.headers = structuredClone(headers); });
}

export function removeEntry(approved, origin, section, id) {
  return withSite(approved, origin, (s) => {
    s[section] = s[section].filter((e) => findEntry({ [section]: [e] }, section, id) === undefined);
  });
}

export function addPending(approved, origin, item) {
  return withSite(approved, origin, (s) => {
    s.pending = s.pending.filter((p) => p.finding !== item.finding);
    s.pending.push(structuredClone(item));
  });
}

export function approvePending(approved, origin, findingKey, reason) {
  const s = siteSection(approved, origin);
  const item = s.pending.find((p) => p.finding === findingKey);
  if (!item) throw new UnknownPendingError(findingKey);
  let next = withSite(approved, origin, (site) => { site.pending = site.pending.filter((p) => p.finding !== findingKey); });
  if (item.into === 'headers') {
    return withSite(next, origin, (site) => {
      const [pagePattern, values] = Object.entries(item.add ?? item.entry)[0];
      site.headers[pagePattern] = { ...(site.headers[pagePattern] ?? {}), ...values };
    });
  }
  if (item.entry) next = addEntry(next, origin, item.into, { ...item.entry, reason });
  else {
    next = addToEntry(next, origin, item.into, item.id, item.add);
    if (isTodo(findEntry(next.sites[origin], item.into, item.id)?.reason)) {
      next = withSite(next, origin, (site) => { findEntry(site, item.into, item.id).reason = reason; });
    }
  }
  return next;
}

export function todoReasons(approved) {
  const out = [];
  for (const [origin, raw] of Object.entries(approved.sites)) {
    const s = normalizeSite(raw);
    for (const section of SECTIONS) {
      for (const e of s[section]) {
        if (isTodo(e.reason)) out.push({ site: origin, section, id: entryKey(section, e) });
      }
    }
  }
  return out;
}
