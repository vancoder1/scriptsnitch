// One visit: a page in one profile, in a fresh browser context (design §7 "A visit"). Returns the
// snapshot's Visit shape; the scripts' sources ride along on a non-enumerable `sources` property for
// the evidence files.
import { createScriptLog, buildScripts } from './scripts.js';
import { createNetLog } from './network.js';

export const newCache = () => ({ sources: new Map(), bodies: new Map(), analysis: new Map() });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function originOf(url) {
  try { const u = new URL(url); return u.origin === 'null' ? null : u.origin; } catch { return null; }
}

function waitForEvent(ctx, method, sessionId, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve(false); }, ms);
    const off = ctx.on(method, (_p, sid) => {
      if (sid !== sessionId) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
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

export async function visitPage(browser, page, profileName, { role = 'A', own = new Set([page.site]), frames: framesMode = 'own', cache = newCache() } = {}) {
  const ctx = await browser.newContext();
  const scriptLog = createScriptLog(ctx);
  const netLog = createNetLog(ctx);
  try {
    const session = await ctx.newPage();
    const loaded = waitForEvent(ctx, 'Page.loadEventFired', session.id, page.settle?.capMs ?? 15000);
    const nav = await ctx.send('Page.navigate', { url: page.url }, session.id).catch((e) => ({ errorText: e.message }));
    let reason = nav.errorText ? `could not load the page: ${nav.errorText}` : null;
    if (!(await loaded) && !reason) reason = 'timed out';
    await sleep(1500);

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

    const built = await buildScripts(ctx, scriptLog, netLog, {
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
    for (const r of netLog.destinationRequests()) {
      const frame = frameLabel(r.frameId, r.sessionId);
      if (!tracked(frame)) continue;
      destinations.push({ url: r.url, method: r.method, type: r.type, frame, initiator: initiatorRef(r.initiator, r.sessionId), phase: 'load' });
    }
    for (const ws of netLog.sockets.values()) {
      destinations.push({ url: ws.url, method: 'GET', type: 'WebSocket', frame: frameLabel(null, ws.sessionId), initiator: initiatorRef(ws.initiator, ws.sessionId), phase: 'load' });
    }
    for (const wt of netLog.transports) {
      destinations.push({ url: wt.url, method: 'CONNECT', type: 'WebTransport', frame: frameLabel(null, wt.sessionId), initiator: initiatorRef(wt.initiator, wt.sessionId), phase: 'load' });
    }

    let doc = null;
    for (const r of netLog.requests.values()) {
      if (r.type === 'Document' && r.sessionId === session.id && (r.frameId === mainFrameId || !r.frameId)) doc = r;
    }
    const finalUrl = frames.get(mainFrameId)?.url ?? page.url;

    const visit = {
      role,
      conclusive: !reason,
      reason,
      document: { status: doc?.status ?? 0, finalUrl, headers: doc?.responseHeaders ?? {}, metaCsp: [] },
      consent: { found: null, accepted: false },
      scripts: built.scripts,
      destinations,
      frames: [],
      fields: [],
      listeners: [],
      inputCode: [],
      peers: 0,
      linkHosts: [],
      probe: null,
    };
    Object.defineProperty(visit, 'sources', { value: built.sources, enumerable: false });
    return visit;
  } finally {
    await ctx.dispose();
  }
}
