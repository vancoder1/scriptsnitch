// Records every request a visit's sessions make (design §7 "A visit"): what was asked, by which
// script, what came back, and what went out over WebSockets and WebTransport.

const NOT_DESTINATIONS = new Set(['Script', 'Document', 'Preflight']);

export function createNetLog(ctx) {
  const requests = new Map();
  const sockets = new Map();
  const frames = [];
  const transports = [];
  const sameDocumentUrls = new Set();
  let lastActivity = Date.now();
  let phase = 'load';
  const touch = () => { lastActivity = Date.now(); };

  ctx.on('Network.requestWillBeSent', (p, sessionId) => {
    touch();
    let existing = requests.get(p.requestId);
    // A redirect keeps the request id. The hop that answered with it already received what was sent
    // (a collector can answer 307 to an approved host), so it stays a request of its own.
    if (existing && p.redirectResponse) {
      let n = 1;
      while (requests.has(`${p.requestId}#${n}`)) n++;
      requests.set(`${p.requestId}#${n}`, { ...existing, requestId: `${p.requestId}#${n}`, status: p.redirectResponse.status, done: true });
      existing = { sessionId: existing.sessionId, startedAt: Date.now(), done: false, phase: existing.phase };
    }
    const entry = existing ?? { sessionId, startedAt: Date.now(), done: false, phase };
    Object.assign(entry, {
      requestId: p.requestId,
      url: p.request.url,
      method: p.request.method,
      type: p.type ?? 'Other',
      frameId: p.frameId ?? null,
      initiator: p.initiator ?? null,
      postData: p.request.postData ?? null,
      headers: p.request.headers ?? {},
    });
    requests.set(p.requestId, entry);
  });
  ctx.on('Network.responseReceived', (p) => {
    touch();
    const entry = requests.get(p.requestId);
    if (!entry) return;
    entry.status = p.response.status;
    entry.mimeType = p.response.mimeType;
    entry.responseHeaders = Object.fromEntries(Object.entries(p.response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  });
  ctx.on('Network.loadingFinished', (p) => {
    touch();
    const entry = requests.get(p.requestId);
    if (entry) entry.done = true;
  });
  ctx.on('Network.loadingFailed', (p) => {
    touch();
    const entry = requests.get(p.requestId);
    if (entry) { entry.done = true; entry.failed = p.errorText; }
  });
  ctx.on('Network.webSocketCreated', (p, sessionId) => {
    touch();
    sockets.set(p.requestId, { url: p.url, initiator: p.initiator ?? null, sessionId, phase });
  });
  ctx.on('Network.webSocketFrameSent', (p) => {
    frames.push({ requestId: p.requestId, payload: p.response?.payloadData ?? '' });
  });
  // history.pushState and replaceState: inline scripts parsed before carry the earlier address.
  ctx.on('Page.navigatedWithinDocument', (p) => { if (p.url) sameDocumentUrls.add(p.url); });
  ctx.on('Network.webTransportCreated', (p, sessionId) => {
    touch();
    transports.push({ url: p.url, initiator: p.initiator ?? null, sessionId, phase });
  });

  return {
    requests,
    sockets,
    frames,
    transports,
    lastActivity: () => lastActivity,
    setPhase(p) { phase = p; },
    reset() { requests.clear(); sockets.clear(); frames.length = 0; transports.length = 0; sameDocumentUrls.clear(); touch(); },
    // Requests still open, ignoring streams and anything open longer than longPollMs.
    inFlight(longPollMs) {
      const now = Date.now();
      let n = 0;
      for (const r of requests.values()) {
        if (!r.done && r.type !== 'EventSource' && r.type !== 'WebSocket' && now - r.startedAt < longPollMs) n++;
      }
      return n;
    },
    // The request that delivered a script URL in a session, for its response body.
    scriptRequest(url, sessionId) {
      let found = null;
      for (const r of requests.values()) {
        if (r.url === url && r.type === 'Script' && (sessionId === undefined || r.sessionId === sessionId) && !r.failed) found = r;
      }
      return found;
    },
    // Every address a document in the visit had: where it was fetched, and where pushState moved it.
    documentUrls() {
      const urls = new Set(sameDocumentUrls);
      for (const r of requests.values()) if (r.type === 'Document') urls.add(r.url);
      return urls;
    },
    destinationRequests() {
      return [...requests.values()].filter((r) => !NOT_DESTINATIONS.has(r.type) && !/^(data|blob):/i.test(r.url));
    },
  };
}
