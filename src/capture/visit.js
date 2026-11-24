// One visit: a page in one profile, in a fresh browser context (design §7 "A visit"). Returns the
// snapshot's Visit shape; the scripts' sources and the viewport ride along on non-enumerable
// properties for the evidence files and the profile result.
import { createScriptLog, buildScripts } from './scripts.js';
import { createNetLog } from './network.js';
import { profileFor, applyProfile } from './profiles.js';
import { settle, scrollToBottom } from './settle.js';
import { runSteps, navigate } from './steps.js';

export const newCache = () => ({ sources: new Map(), bodies: new Map(), analysis: new Map() });

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

// Opens the page: steps first (their pages are not judged), then a full load of the page itself,
// settling, one scroll to the bottom, and settling again.
async function load(ctx, session, page, profile, logs, env) {
  if (page.steps?.length) {
    try {
      await runSteps(ctx, session.id, page.steps, { env });
    } catch (err) {
      return err.message;
    }
  }
  logs.scripts.reset();
  logs.net.reset();
  const nav = await navigate(ctx, session.id, page.url, page.settle?.capMs ?? 15000);
  if (!nav.ok) return nav.reason;
  const first = await settle(logs.net, logs.scripts, page.settle);
  await scrollToBottom(ctx, session.id, profile.viewport);
  await settle(logs.net, logs.scripts, { ...page.settle, capMs: 5000 });
  return first.timedOut && logs.scripts.parsed.length === 0 ? 'timed out' : null;
}

export async function visitPage(browser, page, profileName, { role = 'A', own = new Set([page.site]), frames: framesMode = 'own', cache = newCache(), env = process.env, random = Math.random } = {}) {
  const profile = profileFor(profileName, { chromeVersion: browser.version, random });
  const ctx = await browser.newContext();
  ctx.onSession(async (s) => {
    if (s.type === 'page') await applyProfile(ctx, s.id, profile);
    else if (s.type === 'iframe') await applyProfile(ctx, s.id, profile, { frame: true });
  });
  const logs = { scripts: createScriptLog(ctx), net: createNetLog(ctx) };
  try {
    const session = await ctx.newPage();
    const reason = await load(ctx, session, page, profile, logs, env);

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

    const built = await buildScripts(ctx, logs.scripts, logs.net, {
      frameOf: (p) => frameLabel(p.frameId, p.sessionId),
      docUrls,
      isTracked: (_p, frame) => tracked(frame),
      cache,
    });
    const initiatorRef = (initiator, sessionId) => {
      for (let s = initiator?.stack; s; s = s.parent) {
        const f = s.callFrames?.find((c) => c.scriptId && c.scriptId !== '0');
        if (f) return built.rootRefOf(sessionId, f.scriptId);
      }
      return null;
    };

    const destinations = [];
    for (const r of logs.net.destinationRequests()) {
      const frame = frameLabel(r.frameId, r.sessionId);
      if (!tracked(frame)) continue;
      destinations.push({ url: r.url, method: r.method, type: r.type, frame, initiator: initiatorRef(r.initiator, r.sessionId), phase: 'load' });
    }
    for (const ws of logs.net.sockets.values()) {
      destinations.push({ url: ws.url, method: 'GET', type: 'WebSocket', frame: frameLabel(null, ws.sessionId), initiator: initiatorRef(ws.initiator, ws.sessionId), phase: 'load' });
    }
    for (const wt of logs.net.transports) {
      destinations.push({ url: wt.url, method: 'CONNECT', type: 'WebTransport', frame: frameLabel(null, wt.sessionId), initiator: initiatorRef(wt.initiator, wt.sessionId), phase: 'load' });
    }

    let doc = null;
    for (const r of logs.net.requests.values()) {
      if (r.type === 'Document' && r.sessionId === session.id && (r.frameId === mainFrameId || !r.frameId)) doc = r;
    }
    const finalUrl = frames.get(mainFrameId)?.url ?? page.url;

    const visit = {
      role,
      conclusive: !reason,
      reason,
      document: { status: doc?.status ?? 0, finalUrl, headers: doc?.responseHeaders ?? {}, metaCsp: [] },
      consent: { found: null, accepted: false },
      scripts: reason ? [] : built.scripts,
      destinations: reason ? [] : destinations,
      frames: [],
      fields: [],
      listeners: [],
      inputCode: [],
      peers: 0,
      linkHosts: [],
      probe: null,
    };
    Object.defineProperty(visit, 'sources', { value: built.sources, enumerable: false });
    Object.defineProperty(visit, 'viewport', { value: profile.viewport, enumerable: false });
    return visit;
  } finally {
    await ctx.dispose();
  }
}
