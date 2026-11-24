// `scan <url>` and `init <url…>` (design §14): a one-off inventory of one page with no setup, and a
// starter config plus a first approved file. init finds the sign-in, cart and checkout links on the
// given pages, one level deep and never further; scriptsnitch is not a crawler.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collect } from './collect.js';
import { parseConfig } from '../config/config.js';
import { emptyApproved, serializeApproved } from '../config/approved.js';
import { judge } from '../analyze/judge.js';
import { proposalsFor, applyProposals, suggestTrust } from '../analyze/proposals.js';
import { scriptIdentity } from '../analyze/keys.js';
import { TRACKED_HEADERS } from '../analyze/headers.js';
import { emptyStatusState } from '../state.js';
import { openBrowser } from '../capture/browser.js';
import { visitPage } from '../capture/visit.js';
import { short } from '../util/hash.js';

const SENSITIVE = new Set(['password', 'card', 'iban']);
const INTERESTING = /(log ?in|sign ?in|account|cart|basket|checkout|pay)/i;

export class InitError extends Error {
  constructor(message) { super(message); this.name = 'InitError'; }
}

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };
const withTempDir = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'scriptsnitch-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const judgedVisits = (page) => Object.values(page.profiles).filter((r) => r?.conclusive).flatMap((r) => r.visits).filter((v) => v.conclusive && v.role !== 'drill');
const hasSensitiveFields = (visits) => visits.some((v) => v.fields.some((f) => SENSITIVE.has(f.kind)) || v.frames.some((fr) => fr.fieldKinds.some((k) => SENSITIVE.has(k))));

export function inventoryOf(snapshot) {
  const page = snapshot.pages[0];
  const visits = judgedVisits(page);
  const result = Object.values(page.profiles).find(Boolean);
  if (!visits.length) return { url: page.url, conclusive: false, reason: result?.reason ?? 'no visit completed', scripts: [], destinations: [], frames: [], fields: [], listeners: [], headers: {}, linkHosts: [] };
  const own = new Set([page.site]);
  const sensitive = hasSensitiveFields(visits);
  const unique = (items, keyOf) => [...new Map(items.map((x) => [keyOf(x), x])).values()];
  const scripts = unique(visits.flatMap((v) => v.scripts), (s) => scriptIdentity(s.kind === 'code' ? { ...s.ref, url: null } : s.ref)).map((s) => {
    if (s.kind === 'external') return { kind: 'external', url: s.ref.url, suggestedTrust: suggestTrust(s.ref.url, own.has(originOf(s.ref.url))), sha256: s.ref.contentHash, creator: s.creator?.url ?? null, size: s.size, obfuscation: s.band, hosts: s.hosts };
    if (s.kind === 'inline') return { kind: 'inline', template: s.ref.template, suggestedTrust: sensitive ? 'exact' : 'deploy', size: s.size, obfuscation: s.band, hosts: s.hosts };
    return { kind: 'code', createdBy: s.creator?.url ?? (s.creator?.template ? `inline ${short(s.creator.template)}` : null), size: s.size, hosts: s.hosts };
  });
  const first = visits[0];
  const headers = Object.fromEntries(Object.entries(first.document.headers).map(([k, v]) => [k.toLowerCase(), v]).filter(([k]) => TRACKED_HEADERS.includes(k)));
  const probes = visits.filter((v) => v.probe);
  return {
    url: page.url,
    finalUrl: first.document.finalUrl,
    conclusive: true,
    scripts,
    destinations: unique(visits.flatMap((v) => v.destinations), (d) => `${d.method} ${d.url}`).map((d) => ({ method: d.method, url: d.url, type: d.type, by: scriptIdentity(d.initiator), phase: d.phase })),
    frames: unique(visits.flatMap((v) => v.frames), (f) => f.origin),
    fields: unique(visits.flatMap((v) => v.fields), (f) => `${f.frame}|${f.form}|${f.field}|${f.kind}`),
    listeners: unique(visits.flatMap((v) => v.listeners), (l) => `${l.kind}:${l.role}:${l.event} ${scriptIdentity(l.script)}`).map((l) => ({ listener: `${l.kind}:${l.role}:${l.event}`, by: scriptIdentity(l.script) })),
    headers,
    linkHosts: [...new Set(visits.flatMap((v) => v.linkHosts))].sort(),
    ...(probes.length ? { probe: { submitted: probes.some((v) => v.probe.submitted), hits: probes.flatMap((v) => v.probe.hits).map((h) => ({ kind: h.kind, url: h.url, encoding: h.encoding, by: scriptIdentity(h.initiator) })), storage: probes.flatMap((v) => v.probe.storage) } } : {}),
  };
}

export function formatInventory(inv) {
  if (!inv.conclusive) return `${inv.url}: could not be read (${inv.reason})\n`;
  const lines = [`${inv.url}`];
  const section = (title, items, line) => {
    lines.push('', `${title} (${items.length})`);
    for (const item of items) lines.push(`  ${line(item)}`);
  };
  section('Scripts', inv.scripts, (s) => (s.kind === 'external' ? `${s.suggestedTrust.padEnd(7)} ${s.url}${s.creator ? `  (loaded by ${s.creator})` : ''}` : s.kind === 'inline' ? `${s.suggestedTrust.padEnd(7)} inline script ${short(s.template)}` : `code    created at runtime by ${s.createdBy ?? 'an unknown script'}`));
  section('Destinations', inv.destinations, (d) => `${d.method.padEnd(7)} ${d.url}  (${d.type}${d.by ? `, from ${d.by}` : ''})`);
  section('Frames', inv.frames, (f) => `${f.origin}${f.fieldKinds.length ? `  (fields: ${f.fieldKinds.join(', ')})` : ''}`);
  section('Sensitive fields', inv.fields, (f) => `${f.kind.padEnd(8)} ${f.field} in ${f.form} (${f.frame})${f.count > 1 ? ` x${f.count}` : ''}`);
  section('Listeners on sensitive fields', inv.listeners, (l) => `${l.listener}  by ${l.by ?? 'an unknown script'}`);
  section('Security headers', Object.entries(inv.headers), ([k, v]) => `${k}: ${v}`);
  if (inv.probe) section('Probe', inv.probe.hits, (h) => `${h.kind} value sent to ${h.url} (${h.encoding})`);
  lines.push('', 'Suggested trust: exact pins the content by hash; origin lets the vendor update it; deploy follows your own releases.');
  return `${lines.join('\n')}\n`;
}

export async function scan(url, { executable, allowNoSandbox = false, extraArgs = [], probe = false, env = process.env, fetchImpl = fetch }) {
  const config = parseConfig(JSON.stringify({ profiles: ['desktop'], pages: [{ name: url, url, probe }] }), 'scan');
  return withTempDir(async (outDir) => inventoryOf(await collect({ config, approved: emptyApproved(), outDir, executable, allowNoSandbox, env, extraArgs, fetchImpl })));
}

// Same-origin links on the given pages whose text or path looks like sign-in, account, cart or checkout.
async function discover(urls, { executable, allowNoSandbox, extraArgs, env }) {
  const config = parseConfig(JSON.stringify({ profiles: ['desktop'], pages: urls.map((url) => ({ name: url, url, probe: false })) }), 'init');
  const browser = await openBrowser({ executable, allowNoSandbox, extraArgs });
  const found = [];
  try {
    for (const page of config.pages) {
      const visit = await visitPage(browser, page, 'desktop', { role: 'A', own: new Set([page.site]), env });
      for (const link of visit.links) {
        const u = new URL(link.href);
        u.hash = '';
        if (u.origin !== originOf(page.url) || !(INTERESTING.test(link.text) || INTERESTING.test(u.pathname))) continue;
        found.push(u.href);
      }
    }
  } finally {
    await browser.close();
  }
  return found;
}

export async function init(urls, { cwd, executable, allowNoSandbox = false, extraArgs = [], env = process.env, fetchImpl = fetch, force = false, now = Date.now }) {
  const dir = join(cwd, 'scriptsnitch');
  const configPath = join(dir, 'config.json');
  const approvedPath = join(dir, 'approved.json');
  if (!force && (existsSync(configPath) || existsSync(approvedPath))) throw new InitError(`${configPath} or ${approvedPath} already exists; init never overwrites them (use --force to replace both)`);
  const given = urls.map((u) => { const x = new URL(u); x.hash = ''; return x.href; });
  const all = [...new Set([...given, ...(await discover(given, { executable, allowNoSandbox, extraArgs, env }))])];
  const config = parseConfig(JSON.stringify({ profiles: ['desktop'], pages: all.map((url) => ({ name: url, url })) }), 'init');
  const snapshot = await withTempDir((outDir) => collect({ config, approved: emptyApproved(), outDir, executable, allowNoSandbox, env, extraArgs, fetchImpl, now }));
  for (const p of snapshot.pages) p.sensitive = hasSensitiveFields(judgedVisits(p));
  const result = judge({ snapshot, approved: emptyApproved(), state: emptyStatusState(), now: now() });
  const proposals = proposalsFor([...result.findings, ...result.held], emptyApproved(), { now: now(), headers: result.headers });
  let approved = emptyApproved();
  for (const site of new Set(snapshot.pages.map((p) => p.site))) approved = applyProposals(approved, site, proposals.filter((p) => p.site === site));
  const pages = snapshot.pages.map((p) => {
    const title = judgedVisits(p)[0]?.document.title?.trim();
    return { name: title || new URL(p.url).pathname, url: p.url, ...(p.sensitive ? { sensitive: true } : {}) };
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({ approved: 'scriptsnitch/approved.json', pages }, null, 2)}\n`);
  writeFileSync(approvedPath, serializeApproved(approved));
  return { configPath, approvedPath, pages, pending: proposals.filter((p) => p.mode === 'pending').length };
}
