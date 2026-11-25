// Script URL identity (design §8 "URL kinds" and "Slots").
import { accountKeyParams } from './hosts.js';

const QUERY_VERSION_PARAMS = ['ver', 'v', 'version', '_v', 'rev'];

// A content-derived token: 8-40 characters. Hex needs both digits and letters; other tokens need
// two character classes and no run of more than five lowercase letters (words have long runs).
export function isBuildToken(s) {
  if (typeof s !== 'string' || s.length < 8 || s.length > 40 || !/^[A-Za-z0-9_-]+$/.test(s)) return false;
  if (/^[0-9a-f]+$/.test(s)) return /[0-9]/.test(s) && /[a-f]/.test(s);
  if (/^[0-9]+$/.test(s)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[_-]/].filter((r) => r.test(s)).length;
  if (classes < 2) return false;
  const longestLower = Math.max(0, ...(s.match(/[a-z]+/g) ?? []).map((run) => run.length));
  return longestLower <= 5;
}

// The build token inside a file name, preferring the part after a dash (name-TOKEN) over a whole
// dot-separated part, so Vite's index-B_x-9aQz.js yields B_x-9aQz, not index-B_x-9aQz.
function tokenInFilename(filename) {
  const stem = filename.replace(/\.[mc]?js$/i, '');
  for (const part of stem.split('.')) {
    for (let i = part.indexOf('-'); i !== -1; i = part.indexOf('-', i + 1)) {
      const tail = part.slice(i + 1);
      if (isBuildToken(tail)) return tail;
    }
    if (isBuildToken(part)) return part;
  }
  return null;
}

// A build id as a whole directory, in the layouts that use one: Next.js /_next/static/<buildId>/.
// (Directories are not tested with isBuildToken in general: third-party paths are full of ids.)
const NEXT_BUILD = /\/_next\/static\/([A-Za-z0-9_-]{8,64})\//;
const NEXT_FOLDERS = new Set(['chunks', 'css', 'media', 'development', 'webpack']);
function tokenInDirectory(pathname) {
  const m = NEXT_BUILD.exec(pathname);
  return m && !NEXT_FOLDERS.has(m[1]) ? m[1] : null;
}

const VERSION_PATTERNS = [
  /@(\d+\.\d+(?:\.\d+)*(?:-[0-9A-Za-z.]+)?)(?=\/|$)/, // npm CDNs: lib@3.7.1/
  /\/version(\d{6,})(?=\/)/, // a deploy timestamp directory: Magento's /static/version1700000000/
  /\/v?(\d+\.\d+(?:\.\d+)*)(?=\/)/, // a version directory: /1.2.3/ or /v1.2.3/
  /-(\d+\.\d+(?:\.\d+)*)(?:\.min)?\.[mc]?js$/, // file name: modernizr-2.6.2.min.js
  /\.(\d+\.\d+\.\d+)(?:\.min)?\.[mc]?js$/, // file name: lib.1.2.3.js
];

function pathVersion(pathname) {
  for (const re of VERSION_PATTERNS) {
    const m = re.exec(pathname);
    if (m) return { version: m[1], index: m.index + m[0].indexOf(m[1]) };
  }
  return null;
}

function queryVersion(searchParams) {
  for (const name of QUERY_VERSION_PARAMS) {
    const value = searchParams.get(name);
    if (value) return { name, value };
  }
  return null;
}

// kind: 'code' (blob:, data:, wasm:), 'hashed', 'versioned' or 'floating'.
export function classifyUrl(url) {
  if (/^(blob|data|wasm):/i.test(url)) return { kind: 'code' };
  // URLs come from the page; one that does not parse has no token or version to find.
  const u = URL.parse(url);
  if (!u) return { kind: 'floating' };
  const filename = u.pathname.split('/').pop() || '';
  const qv = queryVersion(u.searchParams);
  const extra = qv ? { queryVersion: qv.value } : {};
  const token = tokenInFilename(filename) ?? tokenInDirectory(u.pathname);
  if (token) return { kind: 'hashed', token, ...extra };
  const pv = pathVersion(u.pathname);
  if (pv) return { kind: 'versioned', version: pv.version, ...extra };
  return { kind: 'floating', ...extra };
}

function query(searchParams, versionParam) {
  const pairs = [...searchParams].map(([k, v]) => [k, k === versionParam ? '{version}' : v]);
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return pairs.length ? `?${pairs.map(([k, v]) => (v === '{version}' ? `${encodeURIComponent(k)}={version}` : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)).join('&')}` : '';
}

// What identifies an own file's content: its origin and path, plus the version when it sits in the
// query (app.js?v=123). Other parameters are left out, as approval patterns leave them out: the same
// file loaded with an extra `?x=1` is the same file.
export function fileIdentity(url, classification = classifyUrl(url)) {
  const u = URL.parse(url);
  if (!u) return url;
  return `${u.origin}${u.pathname}${classification.queryVersion ? `?{version}=${classification.queryVersion}` : ''}`;
}

// The URL with the build token or version replaced by a placeholder, and query parameters sorted.
export function slotOf(url, classification = classifyUrl(url)) {
  if (classification.kind === 'code') return url.split(':')[0] + ':';
  const u = URL.parse(url);
  if (!u) return url;
  let path = u.pathname;
  if (classification.kind === 'hashed') {
    const at = path.lastIndexOf(classification.token);
    path = `${path.slice(0, at)}{token}${path.slice(at + classification.token.length)}`;
  } else if (classification.kind === 'versioned') {
    const pv = pathVersion(path);
    path = `${path.slice(0, pv.index)}{version}${path.slice(pv.index + pv.version.length)}`;
  }
  const qv = queryVersion(u.searchParams);
  return `${u.origin}${path}${query(u.searchParams, qv?.name)}`;
}

const paramKey = (u, name) => `${u.origin}${u.pathname}#${name}`;

// Query parameters whose values differ between visit A and visit B for the same script path.
export function findVolatileParams(urlsA, urlsB) {
  const valuesByPath = (urls) => {
    const out = new Map();
    for (const url of urls) {
      let u;
      try { u = new URL(url); } catch { continue; }
      const path = `${u.origin}${u.pathname}`;
      if (!out.has(path)) out.set(path, { u, params: new Map() });
      const { params } = out.get(path);
      for (const [name, value] of u.searchParams) (params.get(name) ?? params.set(name, new Set()).get(name)).add(value);
    }
    return out;
  };
  const a = valuesByPath(urlsA);
  const b = valuesByPath(urlsB);
  const out = new Set();
  for (const [path, { u, params }] of a) {
    const other = b.get(path);
    if (!other) continue;
    // An account key names whose script it is; it is never a per-visit token.
    const keyed = new Set(accountKeyParams(u.href));
    for (const [name, values] of params) {
      const otherValues = other.params.get(name);
      if (keyed.has(name) || !otherValues) continue;
      // A value seen in both visits is not per-visit: two scripts can share a path (two widgets).
      if ([...values].some((v) => otherValues.has(v))) continue;
      out.add(paramKey(u, name));
    }
  }
  return out;
}

export function maskParams(url, volatile) {
  let u;
  try { u = new URL(url); } catch { return url; }
  let changed = false;
  for (const name of [...u.searchParams.keys()]) {
    if (volatile.has(paramKey(u, name))) { u.searchParams.delete(name); changed = true; }
  }
  return changed ? u.toString() : url;
}
