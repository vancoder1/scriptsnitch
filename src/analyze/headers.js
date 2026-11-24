// Security headers of the final document, compared with the approved baseline (design §7 "Headers",
// §9 "headers", §10 "Weaker headers").
import { matchPage } from '../config/patterns.js';
import { compareCsp, parseCsp } from './csp.js';

export const TRACKED_HEADERS = [
  'content-security-policy',
  'content-security-policy-report-only',
  'strict-transport-security',
  'x-frame-options',
  'x-content-type-options',
  'referrer-policy',
  'permissions-policy',
  'cross-origin-opener-policy',
];

const specificity = (pattern) => (pattern === '**' ? 0 : pattern.includes('*') ? 1 + pattern.replace(/\*/g, '').length / 1000 : 1000 + pattern.length);

// For each header name, the value from the most specific page pattern that matches the path.
// Unlike approvals, a pattern here does cover sensitive pages.
export function baselineFor(headers, path) {
  const out = {};
  const matching = Object.entries(headers ?? {}).filter(([p]) => matchPage(p, path)).sort(([a], [b]) => specificity(a) - specificity(b));
  for (const [, values] of matching) Object.assign(out, values);
  return out;
}

const maxAge = (value) => Number(/max-age\s*=\s*"?(\d+)/i.exec(value ?? '')?.[1] ?? 0);

export function compareHeaders(baseline, observed) {
  const out = { weaker: [], newCspSources: [], stronger: [], reportOnlyChanged: false, changed: [] };
  if ('content-security-policy' in baseline) {
    const r = compareCsp(baseline['content-security-policy'], observed['content-security-policy'] ?? null);
    out.weaker.push(...r.weaker);
    out.newCspSources.push(...r.newSources);
    out.stronger.push(...r.stronger);
  }
  if ('content-security-policy-report-only' in baseline) {
    const r = compareCsp(baseline['content-security-policy-report-only'], observed['content-security-policy-report-only'] ?? null);
    out.reportOnlyChanged = r.weaker.length + r.newSources.length + r.stronger.length > 0;
  }
  const hsts = baseline['strict-transport-security'];
  if (hsts !== undefined) {
    const now = observed['strict-transport-security'];
    if (now === undefined) out.weaker.push('Strict-Transport-Security removed');
    else if (maxAge(now) < maxAge(hsts)) out.weaker.push(`Strict-Transport-Security max-age cut from ${maxAge(hsts)} to ${maxAge(now)}`);
    else if (maxAge(now) > maxAge(hsts)) out.stronger.push('Strict-Transport-Security max-age raised');
  }
  if (baseline['x-frame-options'] !== undefined && observed['x-frame-options'] === undefined) {
    if (!parseCsp(observed['content-security-policy'])?.has('frame-ancestors')) out.weaker.push('framing protection removed');
  }
  for (const name of ['x-content-type-options', 'referrer-policy', 'permissions-policy', 'cross-origin-opener-policy']) {
    if (baseline[name] !== undefined && observed[name] !== baseline[name]) out.changed.push(name);
  }
  return out;
}
