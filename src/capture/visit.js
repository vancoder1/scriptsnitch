// One visit: a page in one profile, in a fresh browser context (design §7 "A visit"). Returns the
// snapshot's Visit shape; the scripts' sources, the viewport and (for probes) the held requests ride
// along on non-enumerable properties.
import { createScriptLog, buildScripts } from './scripts.js';
import { createNetLog } from './network.js';
import { profileFor, applyProfile } from './profiles.js';
import { settle, scrollToBottom } from './settle.js';
import { runSteps, navigate, querySelector } from './steps.js';
import { readDom } from './dom.js';
import { holdNetwork, fillAndSubmit, waitAndSample, startCoverage, takeCoverage, readStorage } from './probe.js';
import { countPeers } from './peers.js';
import { acceptConsent } from './consent.js';
import { installDrill } from './drill.js';
import { findValues } from '../analyze/probe-match.js';
import { startProxy } from './proxy.js';

const NO_CONSENT = { found: null, accepted: false };

export const newCache = () => ({ sources: new Map(), bodies: new Map(), analysis: new Map() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function originOf(url) {
  try { const u = new URL(url); return u.origin === 'null' ? null : u.origin; } catch { return null; }
}

// frameId -> { url, sessionId }, plus the main frame id, from every page and iframe session.
async function frameMap(ctx) {
  const frames = new Map();
  let mainFrameId = null;
  for (const session of ctx.sessions.values()) {
    if (session.type !== 'page' && session.type !== 'iframe') continue;
    const tree = await ctx.send('Page.getFrameTree', {}, session.id).then((r) => r.frameTree, () => null);
    const walk = (node) => {
      if (!node) return;
      frames.set(node.frame.id, { url: node.frame.url, sessionId: session.id });
      for (const child of node.childFrames ?? []) walk(child);
    };
    walk(tree);
    if (session === ctx.pageSession && tree) mainFrameId = tree.frame.id;
  }
  return { frames, mainFrameId };
}

async function expectPresent(ctx, sessionId, expect) {
  if (expect.selector) return Boolean(await querySelector(ctx, sessionId, expect.selector));
  const search = await ctx.send('DOM.performSearch', { query: expect.text }, sessionId).catch(() => null);
  if (!search) return false;
  await ctx.send('DOM.discardSearchResults', { searchId: search.searchId }, sessionId).catch(() => {});
  return search.resultCount > 0;
}

// Steps first (their pages are not judged), then a full load of the page itself, settling, one
// scroll to the bottom, and settling again.
async function load(ctx, session, page, profile, logs, env, { beforeNavigate } = {}) {
  if (page.steps?.length) {
    try {
      await runSteps(ctx, session.id, page.steps, { env });
    } catch (err) {
      return { reason: err.message, consent: NO_CONSENT };
    }
  }
  logs.scripts.reset();
  logs.net.reset();
  if (beforeNavigate) await beforeNavigate();
  const nav = await navigate(ctx, session.id, page.url, page.settle?.capMs ?? 15000);
  if (!nav.ok) return { reason: nav.reason, consent: NO_CONSENT };
  const first = await settle(logs.net, logs.scripts, page.settle);
  const consent = await acceptConsent(ctx, session.id, page.consent ?? 'accept', { touch: profile.hasTouch, env });
  if (consent.accepted) await settle(logs.net, logs.scripts, page.settle);
  await scrollToBottom(ctx, session.id, profile.viewport);
  await settle(logs.net, logs.scripts, { ...page.settle, capMs: 5000 });
  if (page.expect && !(await expectPresent(ctx, session.id, page.expect))) return { reason: 'expected content missing', consent };
  return { reason: first.timedOut && logs.scripts.parsed.length === 0 ? 'timed out' : null, consent };
}

// Turns what the context recorded into the visit's scripts, destinations and documents.
async function observe(ctx, session, page, logs, { own, framesMode, extraSelectors, cache }) {
  const { frames, mainFrameId } = await frameMap(ctx);
  const docUrls = new Map();
  for (const { url, sessionId } of frames.values()) {
    if (!docUrls.has(sessionId)) docUrls.set(sessionId, new Set());
    docUrls.get(sessionId).add(url);
  }
  const frameLabel = (frameId, sessionId) => {
    const s = ctx.sessions.get(sessionId);
    if (s?.type === 'iframe') return originOf(s.url) ?? 'top';
    if (s && s.type !== 'page') {
      const parent = ctx.sessions.get(s.parent);
      return parent?.type === 'iframe' ? originOf(parent.url) ?? 'top' : 'top';
    }
    if (!frameId || frameId === mainFrameId) return 'top';
    return originOf(frames.get(frameId)?.url) ?? 'top';
  };
  const tracked = (frame) => frame === 'top' || own.has(frame) || framesMode === 'all';
  const built = await buildScripts(ctx, logs.scripts, logs.net, { frameOf: (p) => frameLabel(p.frameId, p.sessionId), docUrls, isTracked: (_p, frame) => tracked(frame), cache });
  const initiatorFrame = (initiator) => {
    for (let s = initiator?.stack; s; s = s.parent) {
      const f = s.callFrames?.find((c) => c.scriptId && c.scriptId !== '0');
      if (f) return f;
    }
    return null;
  };
  const initiatorRef = (initiator, sessionId) => {
    const f = initiatorFrame(initiator);
    return f ? built.rootRefOf(sessionId, f.scriptId) : null;
  };
  // True when the request came from code without a URL (eval, new Function, a blob script), which
  // initiatorRef attributes to the script that created it.
  const viaCode = (initiator, sessionId) => {
    const f = initiatorFrame(initiator);
    return f ? built.isCode(sessionId, f.scriptId) : false;
  };
  const destinations = [];
  for (const r of logs.net.destinationRequests()) {
    const frame = frameLabel(r.frameId, r.sessionId);
    if (tracked(frame)) destinations.push({ url: r.url, method: r.method, type: r.type, frame, initiator: initiatorRef(r.initiator, r.sessionId), viaCode: viaCode(r.initiator, r.sessionId), phase: r.phase });
  }
  for (const ws of logs.net.sockets.values()) {
    destinations.push({ url: ws.url, method: 'GET', type: 'WebSocket', frame: frameLabel(null, ws.sessionId), initiator: initiatorRef(ws.initiator, ws.sessionId), viaCode: viaCode(ws.initiator, ws.sessionId), phase: ws.phase });
  }
  for (const wt of logs.net.transports) {
    destinations.push({ url: wt.url, method: 'CONNECT', type: 'WebTransport', frame: frameLabel(null, wt.sessionId), initiator: initiatorRef(wt.initiator, wt.sessionId), viaCode: viaCode(wt.initiator, wt.sessionId), phase: wt.phase });
  }
  let doc = null;
  for (const r of logs.net.requests.values()) {
    if (r.type === 'Document' && r.sessionId === session.id && r.phase === 'load' && (r.frameId === mainFrameId || !r.frameId)) doc = r;
  }
  const dom = await readDom(ctx, { own, framesMode, extraSelectors, refOf: built.rootRefOf });
  return { built, destinations, doc, dom, finalUrl: frames.get(mainFrameId)?.url ?? page.url, frameLabel, initiatorRef, viaCode };
}

const mergeFields = (a, b) => {
  const out = new Map();
  for (const f of [...a, ...b]) {
    const key = `${f.frame}|${f.form}|${f.field}|${f.kind}`;
    out.set(key, { ...f, count: Math.max(f.count, out.get(key)?.count ?? 0) });
  }
  return [...out.values()];
};

// The probe part of a probe visit: hold the network, fill and submit, wait, then observe before
// leaving the page, read storage, and leave so unload beacons are held too.
async function probeVisit(ctx, session, page, profile, logs, scope, values, drillHandle) {
  const { own, framesMode, extraSelectors } = scope;
  const before = await readDom(ctx, { own, framesMode, extraSelectors, refOf: () => null });
  drillHandle?.stop();
  scope.proxy?.hold();
  const held = await holdNetwork(ctx);
  logs.net.setPhase('probe');
  const framesAtStart = logs.net.frames.length;
  await startCoverage(ctx, session.id);
  const result = await fillAndSubmit(ctx, before.fieldNodes, values, { touch: profile.hasTouch });
  const peers = await waitAndSample(ctx, session.id, page.sensitive ? 8000 : 3000);
  if (held.failure) throw new Error(held.failure);
  const ran = await takeCoverage(ctx, session.id);
  const obs = await observe(ctx, session, page, logs, scope);
  const inputCode = [];
  const seen = new Set();
  for (const scriptId of ran) {
    const ref = obs.built.rootRefOf(session.id, scriptId);
    const key = JSON.stringify(ref);
    if (ref && !seen.has(key)) { seen.add(key); inputCode.push(ref); }
  }
  const origin = originOf(obs.finalUrl);
  const storage = origin ? await readStorage(ctx, session.id, origin, values) : [];
  await ctx.send('Page.navigate', { url: 'about:blank' }, session.id).catch(() => {});
  await sleep(1500);
  if (origin) {
    for (const s of await readStorage(ctx, session.id, origin, values)) {
      if (!storage.some((x) => x.kind === s.kind && x.where === s.where)) storage.push(s);
    }
  }
  const requestById = new Map([...logs.net.requests.values()].map((r) => [r.requestId, r]));
  const hits = [];
  for (const h of held) {
    const rawInitiator = h.networkId ? requestById.get(h.networkId)?.initiator : null;
    const initiator = rawInitiator ? obs.initiatorRef(rawInitiator, h.sessionId) : null;
    const frame = obs.frameLabel(null, h.sessionId);
    for (const hit of findValues(`${h.url}\n${h.body}\n${Object.values(h.headers).join('\n')}`, values)) hits.push({ ...hit, url: h.url, frame, initiator });
    if (!obs.destinations.some((d) => d.url === h.url && d.phase === 'probe')) obs.destinations.push({ url: h.url, method: h.method, type: h.type, frame, initiator, viaCode: rawInitiator ? obs.viaCode(rawInitiator, h.sessionId) : false, phase: 'probe' });
  }
  for (const f of logs.net.frames.slice(framesAtStart)) {
    const socket = logs.net.sockets.get(f.requestId);
    for (const hit of findValues(f.payload, values)) hits.push({ ...hit, url: socket?.url ?? 'websocket', frame: obs.frameLabel(null, socket?.sessionId), initiator: obs.initiatorRef(socket?.initiator, socket?.sessionId) });
  }
  const submitted = result.submitted && (held.length > 0 || logs.net.frames.length > framesAtStart);
  return { obs, held, inputCode, peers, fieldsBefore: before.fields, probe: { values, submitted, hits, growth: [], storage } };
}

export async function visitPage(browser, page, profileName, options = {}) {
  const { role = 'A', mode = 'plain', values = null, own = new Set([page.site]), frames: framesMode = 'own', cache = newCache(), env = process.env, random = Math.random, extraSelectors = {}, drill = false } = options;
  const profile = profileFor(profileName, { chromeVersion: browser.version, random });
  // A probe visit runs through its own proxy, cut before the context goes (see proxy.js).
  const proxy = mode === 'probe' ? await startProxy({ rules: browser.hostRules ?? [] }) : null;
  const ctx = await browser.newContext({ proxyServer: proxy?.url ?? null });
  ctx.onSession(async (s) => {
    if (s.type === 'page') await applyProfile(ctx, s.id, profile);
    else if (s.type === 'iframe') await applyProfile(ctx, s.id, profile, { frame: true });
  });
  const logs = { scripts: createScriptLog(ctx), net: createNetLog(ctx) };
  try {
    const session = await ctx.newPage();
    let drillHandle = null;
    const loaded = await load(ctx, session, page, profile, logs, env, { beforeNavigate: drill ? async () => { drillHandle = await installDrill(ctx, session.id); } : null });
    const { reason } = loaded;
    const scope = { own, framesMode, extraSelectors, cache, proxy };
    let run = { obs: null, held: [], inputCode: [], peers: 0, fieldsBefore: [], probe: null };
    if (!reason && mode === 'probe') run = await probeVisit(ctx, session, page, profile, logs, scope, values, drillHandle);
    else if (!reason) run = { ...run, obs: await observe(ctx, session, page, logs, scope), peers: await countPeers(ctx, session.id) };
    const { obs } = run;

    const visit = {
      role,
      conclusive: !reason,
      reason,
      document: { status: obs?.doc?.status ?? 0, finalUrl: obs?.finalUrl ?? page.url, headers: obs?.doc?.responseHeaders ?? {}, metaCsp: obs?.dom.metaCsp ?? [], title: obs?.dom.title ?? '' },
      consent: loaded.consent,
      scripts: obs ? obs.built.scripts : [],
      destinations: obs ? obs.destinations : [],
      frames: obs?.dom.frames ?? [],
      fields: obs ? mergeFields(run.fieldsBefore, obs.dom.fields) : [],
      listeners: obs?.dom.listeners ?? [],
      inputCode: run.inputCode,
      peers: run.peers,
      linkHosts: obs?.dom.linkHosts ?? [],
      probe: run.probe,
    };
    Object.defineProperty(visit, 'sources', { value: obs?.built.sources ?? new Map(), enumerable: false });
    Object.defineProperty(visit, 'viewport', { value: profile.viewport, enumerable: false });
    Object.defineProperty(visit, 'held', { value: run.held, enumerable: false });
    Object.defineProperty(visit, 'links', { value: obs?.dom.anchors ?? [], enumerable: false });
    return visit;
  } finally {
    proxy?.cut();
    await ctx.dispose();
    await proxy?.close();
  }
}
