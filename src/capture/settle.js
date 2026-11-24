// Waiting until a page has finished loading what it loads by itself (design §7 "Settling"):
// no requests in flight and no new script for a while, capped. Streams and long polls are ignored.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function settle(netLog, scriptLog, { quietMs = 1000, scriptQuietMs = 1500, capMs = 15000, longPollMs = 5000 } = {}) {
  const start = Date.now();
  for (;;) {
    const now = Date.now();
    const netQuiet = netLog.inFlight(longPollMs) === 0 && now - netLog.lastActivity() >= quietMs;
    const scriptQuiet = now - scriptLog.lastParsedAt() >= scriptQuietMs;
    if (netQuiet && scriptQuiet) return { timedOut: false };
    if (now - start >= capMs) return { timedOut: true };
    await sleep(100);
  }
}

// Scrolls to the bottom with real wheel events so lazy-loaded scripts start.
export async function scrollToBottom(ctx, sessionId, viewport) {
  const x = Math.round(viewport.width / 2);
  const y = Math.round(viewport.height / 2);
  for (let i = 0; i < 5; i++) {
    await ctx.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: 4000 }, sessionId).catch(() => {});
  }
}
