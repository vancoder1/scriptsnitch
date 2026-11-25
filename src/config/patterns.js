// The pattern grammar of the approved file (design §9 "Patterns"): URLs, destinations, pages and
// listeners.
import { domainToASCII } from 'node:url';
import { isBuildToken } from '../analyze/urls.js';
import { decodeUnreserved } from '../util/url.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const FIELD_KINDS = new Set(['password', 'card', 'iban', 'email', 'name']);
const ROLES = new Set(['field', 'form', 'submit', 'ancestor', 'document', 'window']);
const SCHEME_ALIAS = { ws: 'http', wss: 'https' };
const DEFAULT_PORT = { http: '80', https: '443' };
const VERSION = String.raw`\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.-]+)?`;

const sameScheme = (scheme) => SCHEME_ALIAS[scheme] ?? scheme;

// Lowercase scheme and host, punycode, default port dropped; ws/wss read as http/https.
export function normalizeUrl(url) {
  const u = new URL(url);
  const scheme = u.protocol.slice(0, -1);
  return `${scheme}://${u.host}${u.pathname}${u.search}`;
}

export function parseDestinationPattern(str) {
  const m = /^([A-Z]+)\s+(\S+)$/.exec(String(str).trim());
  if (m) return { method: m[1], url: m[2] };
  return { method: null, url: String(str).trim() };
}

function splitUrlPattern(pattern) {
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?$/i.exec(pattern);
  if (!m) return null;
  const [, scheme, hostPort, path, query] = m;
  const portMatch = /^(.*?)(?::(\d+))?$/.exec(hostPort);
  const rawHost = portMatch[1].toLowerCase();
  const wildcard = rawHost.startsWith('*.');
  const host = wildcard ? `*.${domainToASCII(rawHost.slice(2))}` : domainToASCII(rawHost);
  const s = scheme.toLowerCase();
  const port = portMatch[2] && portMatch[2] !== DEFAULT_PORT[sameScheme(s)] ? portMatch[2] : '';
  return { scheme: sameScheme(s), host, port, path, query: query ?? null };
}

function segmentRegex(segment) {
  let source = '';
  const tokenGroups = [];
  let group = 0;
  for (const part of segment.split(/(\{token\}|\{version\}|\*)/)) {
    if (part === '*') source += '[^/]*';
    else if (part === '{token}') { group++; tokenGroups.push(group); source += '([A-Za-z0-9_-]+)'; }
    else if (part === '{version}') { group++; source += `(${VERSION})`; }
    else source += part.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return { regex: new RegExp(`^${source}$`), tokenGroups };
}

function matchSegment(pattern, segment) {
  const { regex, tokenGroups } = segmentRegex(pattern);
  const m = regex.exec(segment);
  if (!m) return false;
  return tokenGroups.every((g) => isBuildToken(m[g]));
}

function matchSegments(patternSegs, segs) {
  if (patternSegs.length === 0) return segs.length === 0;
  const [head, ...rest] = patternSegs;
  if (head === '**') {
    for (let i = 0; i <= segs.length; i++) if (matchSegments(rest, segs.slice(i))) return true;
    return false;
  }
  if (segs.length === 0) return false;
  return matchSegment(head, segs[0]) && matchSegments(rest, segs.slice(1));
}

function matchPath(patternPath, path) {
  if (patternPath === '') return true;
  return matchSegments(patternPath.split('/').slice(1), path.split('/').slice(1));
}

function matchQuery(patternQuery, params, accountKeyParams) {
  const wanted = new URLSearchParams(patternQuery ?? '');
  for (const key of accountKeyParams) {
    if (params.has(key) && !wanted.has(key)) return false;
    // `id=GTM-MINE&id=GTM-EVIL`: which one the service serves is its business, so neither is approved.
    if (new Set(params.getAll(key)).size > 1) return false;
  }
  for (const [key, value] of wanted) {
    if (!params.has(key)) return false;
    if (value !== '*' && params.getAll(key).some((v) => v !== value)) return false;
  }
  return true;
}

export function matchUrl(pattern, url, { accountKeyParams = [] } = {}) {
  const p = splitUrlPattern(pattern);
  if (!p) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (sameScheme(u.protocol.slice(0, -1)) !== p.scheme) return false;
  if (u.port !== p.port) return false;
  const host = u.hostname.toLowerCase();
  if (p.host.startsWith('*.')) {
    const parent = p.host.slice(2);
    if (!host.endsWith(`.${parent}`)) return false;
  } else if (host !== p.host) return false;
  if (!matchPath(p.path, decodeUnreserved(u.pathname))) return false;
  return matchQuery(p.query, u.searchParams, accountKeyParams);
}

export function matchPage(pattern, path) {
  if (pattern === '**') return true;
  return matchSegments(pattern.split('/').slice(1), path.split('/').slice(1));
}

// `*` and other patterns never cover a sensitive page: only its exact path does.
export function coversPage(pages = ['**'], path, sensitive) {
  if (sensitive) return pages.includes(path);
  return pages.some((p) => matchPage(p, path));
}

export function matchListener(pattern, { kind, role, event }) {
  const [k, r, e] = pattern.split(':');
  return (k === '*' || k === kind) && (r === '*' || r === role) && (e === '*' || e === event);
}

function validateUrlPattern(str) {
  const p = splitUrlPattern(str);
  if (!p) return `"${str}" is not a URL pattern (scheme://host/path)`;
  if (!['http', 'https'].includes(p.scheme)) return `"${str}": scheme must be http, https, ws or wss`;
  const labels = p.host.split('.');
  if (labels.slice(1).includes('*') || (p.host.includes('*') && !p.host.startsWith('*.'))) {
    return `"${str}": a host wildcard may only replace leading labels, as in *.example.com`;
  }
  if (p.host.startsWith('*.') && labels.length < 3) return `"${str}": *.${labels[1]} is too broad; name a domain, as in *.example.com`;
  return null;
}

// Returns a message saying what is wrong, or null.
export function validatePattern(str, type) {
  if (typeof str !== 'string' || !str) return 'a pattern must be a non-empty string';
  if (type === 'url') return validateUrlPattern(str);
  if (type === 'destination') {
    const { method, url } = parseDestinationPattern(str);
    if (method && !METHODS.has(method)) return `"${str}": unknown method ${method}`;
    if (!method && /^[A-Za-z]+\s/.test(str)) return `"${str}": unknown method ${str.split(/\s/)[0]}`;
    return validateUrlPattern(url);
  }
  if (type === 'page') {
    if (str === '**') return null;
    if (!str.startsWith('/')) return `"${str}": a page must start with / (or be **)`;
    return null;
  }
  if (type === 'listener') {
    const parts = str.split(':');
    if (parts.length !== 3) return `"${str}": a listener is written kind:role:event`;
    const [kind, role, event] = parts;
    if (kind !== '*' && !FIELD_KINDS.has(kind)) return `"${str}": unknown field kind ${kind}`;
    if (role !== '*' && !ROLES.has(role)) return `"${str}": unknown role ${role}`;
    if (!event) return `"${str}": missing event`;
    return null;
  }
  throw new Error(`unknown pattern type ${type}`);
}
