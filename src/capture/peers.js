// Live RTCPeerConnection objects (design §7 "Peer connections"), counted with Runtime.queryObjects,
// which needs no Runtime.enable and adds nothing to the page. Best effort: the prototype is read
// from the page's window, so a page that replaces the constructor hides its connections.
const GROUP = 'scriptsnitch-peers';

export async function countPeers(ctx, sessionId) {
  try {
    const { result: proto } = await ctx.send('Runtime.evaluate', { expression: 'typeof RTCPeerConnection === "function" ? RTCPeerConnection.prototype : null', objectGroup: GROUP }, sessionId);
    if (!proto?.objectId) return 0;
    const { objects } = await ctx.send('Runtime.queryObjects', { prototypeObjectId: proto.objectId, objectGroup: GROUP }, sessionId);
    const { result } = await ctx.send('Runtime.callFunctionOn', { objectId: objects.objectId, functionDeclaration: 'function () { return this.length; }', returnByValue: true }, sessionId);
    return Number(result.value) || 0;
  } catch {
    return 0;
  } finally {
    await ctx.send('Runtime.releaseObjectGroup', { objectGroup: GROUP }, sessionId).catch(() => {});
  }
}
