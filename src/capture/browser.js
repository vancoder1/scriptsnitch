// One Chrome for a run, one fresh browser context per visit. Browser-level auto-attach keeps only the
// visit's own targets (design §20, result 4): Chrome's UI, new-tab page and built-in extensions are
// released and detached. Every kept session is prepared before any of its code runs.
import { launchChrome } from '../chrome/launch.js';

const KEPT_TYPES = new Set(['page', 'iframe', 'worker', 'shared_worker', 'service_worker']);
const KEPT_URL = /^(https?|blob|data|about):/i;
const MB = 1024 * 1024;

export async function openBrowser({ executable, allowNoSandbox = false, extraArgs = [] }) {
  const chrome = await launchChrome({ executable, allowNoSandbox, extraArgs });
  const { conn } = chrome;
  const contexts = new Map();

  conn.on('Target.attachedToTarget', (params, parentSessionId) => {
    const { sessionId, targetInfo } = params;
    // Children attached through a page session may not name their browser context; their parent does.
    const ctx = contexts.get(targetInfo.browserContextId) ?? [...contexts.values()].find((c) => c.sessions.has(parentSessionId));
    const keep = ctx && KEPT_TYPES.has(targetInfo.type) && KEPT_URL.test(targetInfo.url || 'about:blank');
    if (!keep) {
      conn.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
      conn.send('Target.detachFromTarget', { sessionId }, parentSessionId).catch(() => {});
      return;
    }
    ctx.attach(sessionId, targetInfo, parentSessionId ?? null);
  });
  await conn.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });

  return {
    version: chrome.version,
    conn,
    process: chrome.process,
    async newContext() {
      const { browserContextId } = await conn.send('Target.createBrowserContext', { disposeOnDetach: true });
      const ctx = createContext(conn, browserContextId, () => contexts.delete(browserContextId));
      contexts.set(browserContextId, ctx);
      return ctx;
    },
    close: chrome.close,
  };
}

function createContext(conn, browserContextId, forget) {
  const sessions = new Map();
  const handlers = [];
  const waiters = new Map();
  const unsubscribe = [];

  unsubscribe.push(conn.on('Page.frameNavigated', ({ frame }, sessionId) => {
    const s = sessions.get(sessionId);
    // A page's root frame has no parent; an out-of-process iframe's root frame has the target's id.
    if (s && (!frame.parentId || frame.id === s.targetId)) s.url = frame.url;
  }));

  const ctx = {
    id: browserContextId,
    conn,
    sessions,
    pageSession: null,
    // Called for every kept session before its code is allowed to run.
    onSession(fn) {
      handlers.push(fn);
    },
    // Subscribe to an event from this context's sessions only; removed on dispose.
    on(method, fn) {
      const off = conn.on(method, (params, sessionId) => {
        if (sessions.has(sessionId)) fn(params, sessionId);
      });
      unsubscribe.push(off);
      return off;
    },
    send(method, params, sessionId) {
      return conn.send(method, params, sessionId);
    },
    async attach(sessionId, targetInfo, parent) {
      let done;
      const session = { id: sessionId, type: targetInfo.type, url: targetInfo.url, targetId: targetInfo.targetId, parent, ready: new Promise((r) => { done = r; }) };
      sessions.set(sessionId, session);
      waiters.get(targetInfo.targetId)?.(session);
      const send = (method, params = {}) => conn.send(method, params, sessionId).catch(() => {});
      try {
        await send('Network.enable', { maxResourceBufferSize: 64 * MB, maxTotalBufferSize: 256 * MB });
        await send('Debugger.enable');
        await send('Debugger.setSkipAllPauses', { skip: true });
        if (session.type === 'page' || session.type === 'iframe') {
          await send('Page.enable');
          await send('DOM.enable');
        }
        await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
        for (const fn of handlers) await fn(session);
      } finally {
        await send('Runtime.runIfWaitingForDebugger');
        done();
      }
    },
    async newPage() {
      const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank', browserContextId });
      const session = [...sessions.values()].find((s) => s.targetId === targetId) ?? (await new Promise((resolve) => waiters.set(targetId, resolve)));
      waiters.delete(targetId);
      await session.ready;
      ctx.pageSession = session;
      return session;
    },
    async dispose() {
      for (const off of unsubscribe) off();
      forget();
      await conn.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    },
  };
  return ctx;
}
