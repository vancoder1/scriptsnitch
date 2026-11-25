// The collect job (design §6): visits every page in every profile, twice, plus confirmation, probe
// and drill visits; masks per-visit noise; keeps evidence; cross-checks versioned files; writes
// scriptsnitch-out/snapshot.json. It observes and never judges.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openBrowser } from '../capture/browser.js';
import { visitPage, newCache } from '../capture/visit.js';
import { inconclusiveReason } from '../capture/inconclusive.js';
import { createEvidenceStore } from '../capture/evidence.js';
import { secretValues, redactDeep } from '../util/redact.js';
import { crossCheck } from '../capture/crosscheck.js';
import { navigate, querySelector } from '../capture/steps.js';
import { ChromeExitedError } from '../chrome/cdp.js';
import { siteSection } from '../config/approved.js';
import { ownOrigins } from '../analyze/hosts.js';
import { classifyUrl, findVolatileParams, maskParams } from '../analyze/urls.js';
import { coveringScripts, coveringDestinations, exactlyApproved, approvedOwnEntries, originOf } from '../analyze/approval.js';
import { matchUrl } from '../config/patterns.js';
import { probeValues, growthFields } from '../analyze/probe-match.js';
import { sha256Hex } from '../util/hash.js';
import { validateSnapshot, SNAPSHOT_FORMAT } from '../snapshot.js';
import { VERSION } from '../version.js';

async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

const deadVisit = (role, reason) => ({
  role, conclusive: false, reason,
  document: { status: 0, finalUrl: '', headers: {}, metaCsp: [], title: '' },
  consent: { found: null, accepted: false }, scripts: [], destinations: [], frames: [], fields: [], listeners: [],
  inputCode: [], peers: 0, linkHosts: [], probe: null,
});

function remapRef(ref, volatile) {
  return ref && ref.url ? { ...ref, url: maskParams(ref.url, volatile) } : ref;
}

function maskVisit(visit, volatile) {
  for (const s of visit.scripts) {
    s.ref = remapRef(s.ref, volatile);
    s.creator = remapRef(s.creator, volatile);
  }
  for (const d of visit.destinations) {
    d.url = maskParams(d.url, volatile);
    d.initiator = remapRef(d.initiator, volatile);
  }
  for (const l of visit.listeners) l.script = remapRef(l.script, volatile);
  visit.inputCode = visit.inputCode.map((r) => remapRef(r, volatile));
}

// The second probe types values this much longer, so a payload that grows with the input stands out.
const LENGTH_BOOST = 37;

const scriptKey = (s) => s.ref.url ?? s.ref.template ?? `code:${s.creator?.url ?? s.creator?.template ?? 'unknown'}`;

export async function collect({ config, approved, outDir, executable, allowNoSandbox = false, drill = false, env = process.env, now = Date.now, extraArgs = [], random = Math.random, fetchImpl = fetch, onBrowser = () => {} }) {
  mkdirSync(outDir, { recursive: true });
  const startedAt = new Date(now()).toISOString();
  let browser = await openBrowser({ executable, allowNoSandbox, extraArgs });
  onBrowser(browser);
  let relaunch = null;
  let relaunches = 0;
  const cache = newCache();
  const secrets = secretValues(config, env);
  const evidence = createEvidenceStore(outDir, { secrets });
  const crossItems = new Map();

  // A visit that survives one Chrome crash per run: the first crash relaunches Chrome and retries.
  async function safeVisit(page, profile, options) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = browser;
      try {
        return await visitPage(current, page, profile, options);
      } catch (err) {
        const crashed = err instanceof ChromeExitedError || current.conn.closed;
        if (!crashed) return deadVisit(options.role, `the visit failed: ${err.message}`);
        if (current === browser) {
          if (relaunches >= 1) return deadVisit(options.role, 'Chrome stopped and was not restarted a second time');
          relaunch ??= (async () => {
            relaunches++;
            browser = await openBrowser({ executable, allowNoSandbox, extraArgs });
            onBrowser(browser);
          })();
        }
        await relaunch.catch(() => {});
        if (browser === current) return deadVisit(options.role, 'Chrome stopped and could not be restarted');
      }
    }
    return deadVisit(options.role, 'Chrome stopped again after a restart');
  }

  async function profileRun(page, profile) {
    const section = siteSection(approved, page.site);
    const own = ownOrigins(page.site, section);
    const ownEntries = approvedOwnEntries(section, own, page.path, page.sensitive);
    const judgeVisit = (v) => {
      const reason = inconclusiveReason(v, page, {
        own,
        hasApprovedOwn: ownEntries.length > 0,
        isApprovedOwn: (s) => Boolean(s.ref.url) && ownEntries.some((e) => matchUrl(e.match, s.ref.url)),
      });
      if (reason) { v.conclusive = false; v.reason = reason; }
      return v;
    };
    const options = (role) => ({ role, own, frames: config.frames, cache, env, random, extraSelectors: config.fields });
    const visits = [judgeVisit(await safeVisit(page, profile, options('A'))), judgeVisit(await safeVisit(page, profile, options('B')))];
    if (visits.filter((v) => v.conclusive).length < 2) visits.push(judgeVisit(await safeVisit(page, profile, options('replacement'))));
    const pair = visits.filter((v) => v.conclusive).slice(0, 2);
    if (pair.length < 2) {
      const reason = visits.find((v) => !v.conclusive)?.reason ?? 'inconclusive';
      return { conclusive: false, reason, viewport: visits[0].viewport ?? { width: 1, height: 1 }, visits };
    }

    const urlsOf = (v) => [...v.scripts.map((s) => s.ref.url).filter(Boolean), ...v.destinations.map((d) => d.url)];
    const volatile = findVolatileParams(urlsOf(pair[0]), urlsOf(pair[1]));
    for (const v of visits) maskVisit(v, volatile);

    // One more visit when something not covered by the approved file was seen in only one visit.
    const unapprovedKeys = (v) => new Set([
      ...v.scripts.filter((s) => coveringScripts(s.ref, section, page.path, page.sensitive).length === 0).map(scriptKey),
      ...v.destinations.filter((d) => coveringDestinations(d.url, d.method, section, page.path, page.sensitive).length === 0).map((d) => `dest:${originOf(d.url)}`),
    ]);
    const [ka, kb] = pair.map(unapprovedKeys);
    if ([...ka].some((k) => !kb.has(k)) || [...kb].some((k) => !ka.has(k))) {
      const confirm = judgeVisit(await safeVisit(page, profile, options('confirm')));
      maskVisit(confirm, volatile);
      visits.push(confirm);
    }

    // Probe visits: once per profile on pages with a sensitive field, plus a second desktop probe with
    // much longer values on sensitive pages, for the growth test.
    if (page.probe === true || (page.probe === 'auto' && pair.some((v) => v.fields.length > 0))) {
      const probeRun = async (role, values) => {
        const v = judgeVisit(await safeVisit(page, profile, { ...options(role), mode: 'probe', values }));
        maskVisit(v, volatile);
        return v;
      };
      const first = await probeRun('probe', probeValues(random, { now: now() }));
      visits.push(first);
      if (page.sensitive && profile === 'desktop') {
        const second = await probeRun('probe2', probeValues(random, { lengthBoost: LENGTH_BOOST, now: now() }));
        if (first.probe && second.probe) second.probe.growth = growthFields(first.held ?? [], second.held ?? [], LENGTH_BOOST);
        visits.push(second);
      }
    }


    // A fire drill: one desktop visit per sensitive page with a harmless test skimmer added in the browser.
    if (drill && page.sensitive && profile === 'desktop') {
      const d = judgeVisit(await safeVisit(page, profile, { ...options('drill'), mode: 'probe', drill: true, values: probeValues(random, { now: now() }) }));
      maskVisit(d, volatile);
      visits.push(d);
    }

    for (const v of visits.filter((x) => x.conclusive && x.role !== 'drill')) {
      // The own scripts whose source names a hashed own file's build token; the judge decides which of
      // them may vouch for it (the build's chunk map does; a second dropped file does not).
      const ownSources = [...(v.sources?.values() ?? [])].filter((x) => x.url && own.has(originOf(x.url)));
      for (const s of v.scripts) {
        if (s.kind === 'external' && s.ref.url && own.has(originOf(s.ref.url))) {
          const token = classifyUrl(s.ref.url).token;
          if (token) s.referencedBy = [...new Set(ownSources.filter((x) => x.url !== s.ref.url && x.source.includes(token)).map((x) => x.url))];
        }
      }
      for (const s of v.scripts) {
        if (exactlyApproved(s.ref, section)) continue;
        const key = s.ref.contentHash ?? s.ref.template;
        const src = v.sources?.get(key);
        if (src) evidence.add(key, src.source, s.ref.url);
        const kind = s.ref.url && s.kind === 'external' ? classifyUrl(s.ref.url).kind : null;
        if ((kind === 'hashed' || kind === 'versioned') && !crossItems.has(s.ref.url)) crossItems.set(s.ref.url, { url: s.ref.url, chromeHash: s.ref.contentHash, referer: v.document.finalUrl });
      }
    }
    return { conclusive: true, reason: null, viewport: pair[0].viewport ?? { width: 1, height: 1 }, visits };
  }

  async function readDeployMarker(origin, marker) {
    try {
      if (marker.url) {
        const res = await fetchImpl(marker.url, { signal: AbortSignal.timeout(15000) });
        return res.ok ? sha256Hex(Buffer.from(await res.arrayBuffer())) : null;
      }
      const ctx = await browser.newContext();
      try {
        const s = await ctx.newPage();
        if (!(await navigate(ctx, s.id, new URL(marker.page, origin).toString())).ok) return null;
        const nodeId = await querySelector(ctx, s.id, marker.selector);
        if (!nodeId) return null;
        const { attributes = [] } = await ctx.send('DOM.getAttributes', { nodeId }, s.id);
        const i = attributes.indexOf(marker.attribute);
        return i >= 0 && i % 2 === 0 ? attributes[i + 1] : null;
      } finally {
        await ctx.dispose();
      }
    } catch {
      return null;
    }
  }

  try {
    const work = config.pages.flatMap((page) => config.profiles.map((profile) => ({ page, profile })));
    const results = await pool(work, config.concurrency, ({ page, profile }) => profileRun(page, profile));
    const pages = config.pages.map((page) => ({
      name: page.name, site: page.site, path: page.path, url: page.url, sensitive: page.sensitive,
      profiles: Object.fromEntries(work.map((w, i) => [w, results[i]]).filter(([w]) => w.page === page).map(([w, r]) => [w.profile, r])),
    }));
    const sites = {};
    for (const origin of new Set(config.pages.map((p) => p.site))) {
      const marker = config.sites[origin]?.deployMarker;
      sites[origin] = { deployMarker: marker ? await readDeployMarker(origin, marker) : null };
    }
    const checks = await crossCheck([...crossItems.values()], { fetchImpl });
    const snapshot = {
      format: SNAPSHOT_FORMAT,
      tool: VERSION,
      run: { startedAt, finishedAt: new Date(now()).toISOString(), chrome: browser.version, drill },
      sites,
      pages,
      crossCheck: checks.filter((c) => /^[0-9a-f]{64}$/.test(c.chromeHash ?? '')),
      evidence: Object.fromEntries(evidence.entries),
    };
    const valid = validateSnapshot(redactDeep(JSON.parse(JSON.stringify(snapshot)), secrets));
    writeFileSync(join(outDir, 'snapshot.json'), JSON.stringify(valid));
    return valid;
  } finally {
    await browser.close().catch(() => {});
  }
}
