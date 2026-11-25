// When a visit did not see the page (design §10 "Inconclusive"): an error status, a redirect off
// the site, a bot challenge, or none of the page's approved own scripts. Inconclusive visits produce
// no findings and resolve nothing.
import { readFileSync } from 'node:fs';

const CHALLENGES = JSON.parse(readFileSync(new URL('../../data/challenges.json', import.meta.url), 'utf8'));

function originOf(url) {
  try { const u = new URL(url); return u.origin === 'null' ? null : u.origin; } catch { return null; }
}
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

function challengeVendor(visit) {
  const doc = visit.document;
  const scriptHosts = new Set((visit.scripts ?? []).map((s) => hostOf(s.ref?.url ?? '')));
  for (const c of CHALLENGES) {
    if (c.status !== undefined && doc.status !== c.status) continue;
    if (c.header && doc.headers[c.header] !== undefined && (c.value === undefined || doc.headers[c.header] === c.value)) return c.vendor;
    if (c.title && (doc.title ?? '').trim() === c.title) return c.vendor;
    if (c.scriptHost && scriptHosts.has(c.scriptHost)) return c.vendor;
    if (c.finalHost && (hostOf(doc.finalUrl) === c.finalHost || hostOf(doc.finalUrl).endsWith(`.${c.finalHost}`))) return c.vendor;
  }
  return null;
}

export function inconclusiveReason(visit, page, { own, hasApprovedOwn = false, isApprovedOwn = () => false }) {
  if (visit.reason) return visit.reason;
  // A title, a script host or a final host is something the page itself can plant, to switch judging
  // off. A real challenge page shows neither the expected content nor any of the site's own scripts.
  const sawPage = Boolean(page.expect) || visit.scripts.some(isApprovedOwn);
  const vendor = sawPage ? null : challengeVendor(visit);
  if (vendor) return `bot challenge (${vendor})`;
  if (visit.document.status >= 400) return `the page answered ${visit.document.status}`;
  const origin = originOf(visit.document.finalUrl);
  if (!origin || !own.has(origin)) return `ended up on ${origin ?? visit.document.finalUrl}, outside the site`;
  if (hasApprovedOwn && !page.expect && !visit.scripts.some(isApprovedOwn)) return "expected content missing: none of the page's approved own scripts loaded";
  return null;
}
