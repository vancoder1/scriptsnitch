// Builders for judging tests: snapshots, visits and script observations with hand-chosen values.
import { sha256Hex } from '../../src/util/hash.js';
import { parseApproved } from '../../src/config/approved.js';
import { emptyStatusState } from '../../src/state.js';

export const SITE = 'https://shop.example';
export const H = (s) => sha256Hex(String(s));
const ref = (url, contentHash, template = null) => ({ url, contentHash, template });

export function ext(url, { hash = H(url), creator = null, frame = 'top', hosts = [], band = 'minified', createsCode = false, referencedBy = [] } = {}) {
  return { ref: ref(url, hash), kind: 'external', frame, creator: creator && ref(creator, H(creator)), hosts, band, createsCode, size: 100, sri: null, referencedBy };
}
export function inline(template, { hosts = [], band = 'plain', createsCode = false } = {}) {
  return { ref: ref(null, null, template), kind: 'inline', frame: 'top', creator: null, hosts, band, createsCode, size: 50, sri: null, referencedBy: [] };
}
export function code(creatorUrl, { hosts = [] } = {}) {
  return { ref: ref(null, H(`code:${creatorUrl}`)), kind: 'code', frame: 'top', creator: creatorUrl && ref(creatorUrl, H(creatorUrl)), hosts, band: 'minified', createsCode: false, size: 10, sri: null, referenced: false };
}
export const scriptRef = (url) => ref(url, H(url));

export function visit({ role = 'A', scripts = [], destinations = [], fields = [], listeners = [], frames = [], peers = 0, headers = {}, finalUrl = `${SITE}/`, probe = null, inputCode = [], linkHosts = [], conclusive = true } = {}) {
  return {
    role, conclusive, reason: conclusive ? null : 'timed out',
    document: { status: 200, finalUrl, headers, metaCsp: [], title: 'Shop' },
    consent: { found: null, accepted: false },
    scripts, destinations, frames, fields, listeners, inputCode, peers, linkHosts, probe,
  };
}

// pages: [{ path, sensitive, visits: [...] }] -> both visits A and B by default (same content).
export function snapshot(pages, { crossCheck = [], drill = false, sites = { [SITE]: { deployMarker: null } } } = {}) {
  return {
    format: 1, tool: '1.0.0',
    run: { startedAt: '2026-11-24T06:00:00.000Z', finishedAt: '2026-11-24T06:01:00.000Z', chrome: 'Chrome/157.0.8103.78', drill },
    sites,
    pages: pages.map((p) => ({
      name: p.name ?? p.path, site: p.site ?? SITE, path: p.path, url: `${p.site ?? SITE}${p.path}`, sensitive: Boolean(p.sensitive),
      profiles: Object.fromEntries((p.profiles ?? ['desktop']).map((name) => {
        const visits = p.visits ?? [visit({ role: 'A', ...(p.observed ?? {}) }), visit({ role: 'B', ...(p.observed ?? {}) })];
        return [name, { conclusive: p.conclusive ?? true, reason: p.conclusive === false ? 'bot challenge (Cloudflare)' : null, viewport: { width: 1366, height: 768 }, visits }];
      })),
    })),
    crossCheck,
    evidence: {},
  };
}

export const entry = (fields) => ({ pages: ['**'], behavior: { hosts: [], listens: [], input: false, eval: false, obfuscation: 'minified' }, reason: 'r', approved: '2026-11-23', ...fields });

export function approved(site = {}) {
  return parseApproved(JSON.stringify({ version: 1, sites: { [SITE]: { own: [], scripts: [], destinations: [], frames: [], fields: [], allow: [], headers: {}, pending: [], ...site } } }), 'approved.json');
}

export const config = (pages) => ({ pages: pages.map((p) => ({ site: SITE, ...p })), profiles: ['desktop'] });
export const state = () => emptyStatusState();
