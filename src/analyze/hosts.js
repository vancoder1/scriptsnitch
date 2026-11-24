// Hosts (design §8): shared hosting, account keys, vendor families, own origins and the
// registrable-domain candidates used for RDAP.
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

const readData = (name) => readFileSync(new URL(`../../data/${name}`, import.meta.url), 'utf8');
const SHARED = JSON.parse(readData('shared-hosts.json'));
const ACCOUNT_KEYS = JSON.parse(readData('account-keys.json'));
const VENDORS = JSON.parse(readData('vendor-families.json'));
const TLDS = new Set(readData('tlds.txt').split('\n').filter(Boolean));

// Host globs: a leading "*." stands for one or more labels, an inner "*" for exactly one.
function globRegex(glob) {
  const body = glob
    .split('.')
    .map((label, i) => (label === '*' ? (i === 0 ? '(?:[a-z0-9-]+\\.)*[a-z0-9-]+' : '[a-z0-9-]+') : label.replace(/-/g, '\\-')))
    .join('\\.');
  return new RegExp(`^${body}$`);
}

const PATH_SHARED = SHARED.path.map(globRegex);
const HOST_SHARED = SHARED.host.map(globRegex);
const KEY_RULES = ACCOUNT_KEYS.map((rule) => ({ ...rule, hostRe: globRegex(rule.host), re: rule.regex ? new RegExp(rule.regex) : null }));

export function sharedHostKind(host) {
  const h = String(host).toLowerCase();
  if (PATH_SHARED.some((r) => r.test(h))) return 'path';
  if (HOST_SHARED.some((r) => r.test(h))) return 'host';
  return null;
}

// True when a host pattern such as "*.netlify.app" or "*.jsdelivr.net" would cover hosts of other
// tenants: a wildcard over a host-shared domain, or one that covers a path-shared host.
export function wildcardCoversTenants(hostPattern) {
  if (!hostPattern.startsWith('*.')) return false;
  const parent = hostPattern.slice(2).toLowerCase();
  if (sharedHostKind(`tenant.${parent}`) === 'host') return true;
  return SHARED.path.some((p) => !p.includes('*') && (p === parent || p.endsWith(`.${parent}`)));
}

function rulesFor(u) {
  const host = u.hostname.toLowerCase();
  return KEY_RULES.filter((r) => r.hostRe.test(host) && (!r.path || r.path === u.pathname));
}

// The account a URL belongs to on a service that serves every customer from one host.
export function accountKey(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  for (const rule of rulesFor(u)) {
    if (rule.param) {
      const key = u.searchParams.get(rule.param);
      if (key) return { service: rule.service, key, where: 'query', param: rule.param };
    } else {
      const m = rule.re.exec(u.pathname);
      if (m) return { service: rule.service, key: m[1], where: 'path', param: null };
    }
  }
  return null;
}

// Query parameters that carry an account key for this URL's service.
export function accountKeyParams(url) {
  let u;
  try { u = new URL(url); } catch { return []; }
  return [...new Set(rulesFor(u).filter((r) => r.param).map((r) => r.param))];
}

// The company behind a host, from third-party-web: an exact entry, else the nearest "*." entry.
export function vendorOf(host) {
  const h = String(host).toLowerCase();
  if (VENDORS[h]) return VENDORS[h];
  const labels = h.split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    const parent = labels.slice(i).join('.');
    const vendor = VENDORS[`*.${parent}`] ?? (i > 0 ? VENDORS[parent] : undefined);
    if (vendor) return vendor;
  }
  return null;
}

// Candidates for the registrable domain, shortest first: cdn.evil.co.uk -> co.uk, evil.co.uk, …
export function registrableCandidates(host) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (isIP(h) || isIP(h.replace(/^\[|\]$/g, ''))) return [];
  const labels = h.split('.');
  if (labels.length < 2) return [h];
  const out = [];
  for (let i = labels.length - 2; i >= 0; i--) out.push(labels.slice(i).join('.'));
  return out;
}

export function isKnownTld(label) {
  return TLDS.has(String(label).toLowerCase());
}

export function originOf(url) {
  return new URL(url).origin;
}

export function ownOrigins(site, siteSection) {
  return new Set([site, ...(siteSection?.own ?? [])]);
}
