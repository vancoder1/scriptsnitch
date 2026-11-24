// Plain matching of observations against the approved file, shared by the collect job (to decide
// confirmation visits, evidence and cross-checks) and the report job's judging.
import { matchUrl, parseDestinationPattern, coversPage } from '../config/patterns.js';
import { accountKeyParams } from './hosts.js';

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

// The approved script entries that cover a script observation, whatever their trust.
export function coveringScripts(ref, site, path, sensitive) {
  return site.scripts.filter((e) => {
    if (!coversPage(e.pages, path, sensitive)) return false;
    if (ref.template) return e.match === 'inline' && (e.trust !== 'exact' || e.template?.includes(ref.template));
    if (!ref.url || e.match === 'inline') return false;
    return matchUrl(e.match, ref.url, { accountKeyParams: accountKeyParams(ref.url) });
  });
}

// True when an exact entry approves exactly this content, so no evidence or cross-check is needed.
export function exactlyApproved(ref, site) {
  if (ref.template) return site.scripts.some((e) => e.match === 'inline' && e.trust === 'exact' && e.template?.includes(ref.template));
  if (!ref.url || !ref.contentHash) return false;
  return site.scripts.some((e) => e.trust === 'exact' && e.match === ref.url && e.sha256?.includes(ref.contentHash));
}

export function coveringDestinations(url, method, site, path, sensitive) {
  return site.destinations.filter((d) => {
    if (!coversPage(d.pages, path, sensitive)) return false;
    const p = parseDestinationPattern(d.match);
    if (p.method && p.method !== method) return false;
    return matchUrl(p.url, url, { accountKeyParams: accountKeyParams(url) });
  });
}

// Own scripts approved for the page: what "at least one approved own script loaded" looks for.
export function approvedOwnEntries(site, own, path, sensitive) {
  return site.scripts.filter((e) => e.match !== 'inline' && own.has(originOf(e.match.replace(/\{token\}|\{version\}|\*\*?/g, 'x'))) && coversPage(e.pages, path, sensitive));
}

export { originOf };
