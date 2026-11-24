// Hosts: shared hosting, own origins (design §8). Task 8 adds account keys, vendor families and
// registrable-domain candidates.
import { readFileSync } from 'node:fs';

const SHARED = JSON.parse(readFileSync(new URL('../../data/shared-hosts.json', import.meta.url), 'utf8'));

// Host globs: a leading "*." stands for one or more labels, an inner "*" for exactly one.
function globRegex(glob) {
  const body = glob
    .split('.')
    .map((label, i) => (label === '*' ? (i === 0 ? '(?:[a-z0-9-]+\\.)*[a-z0-9-]+' : '[a-z0-9-]+') : label.replace(/[-]/g, '\\-')))
    .join('\\.');
  return new RegExp(`^${body}$`);
}

const PATH_SHARED = SHARED.path.map(globRegex);
const HOST_SHARED = SHARED.host.map(globRegex);

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
  return SHARED.path.some((p) => !p.includes('*') && p.endsWith(`.${parent}`)) || sharedHostKind(`x.${parent}`) === 'path';
}

export function originOf(url) {
  return new URL(url).origin;
}

export function ownOrigins(site, siteSection) {
  return new Set([site, ...(siteSection?.own ?? [])]);
}

// Account-key parameters for a URL's service. Task 8 fills this from data/account-keys.json.
export function accountKeyParams() {
  return [];
}
