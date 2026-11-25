import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNetLog } from '../../src/capture/network.js';

// A CDP connection that only delivers the events a test emits.
function fakeCtx() {
  const handlers = new Map();
  return {
    on: (event, fn) => (handlers.get(event) ?? handlers.set(event, []).get(event)).push(fn),
    emit: (event, params, sessionId = 's') => { for (const fn of handlers.get(event) ?? []) fn(params, sessionId); },
  };
}
const sent = (requestId, url, extra = {}) => ({ requestId, type: 'Fetch', request: { url, method: 'POST', postData: 'card=4111111111111111', headers: {} }, initiator: null, ...extra });

test('every hop of a redirect is a request of its own', () => {
  const ctx = fakeCtx();
  const log = createNetLog(ctx);
  ctx.emit('Network.requestWillBeSent', sent('r1', 'https://collect.evil.example/c'));
  ctx.emit('Network.requestWillBeSent', sent('r1', 'https://api.shop.example/ok', { redirectResponse: { status: 307 } }));
  ctx.emit('Network.loadingFinished', { requestId: 'r1' });
  const urls = log.destinationRequests().map((r) => [r.url, r.status ?? null]).sort((a, b) => b[0].localeCompare(a[0]));
  assert.deepEqual(urls, [['https://collect.evil.example/c', 307], ['https://api.shop.example/ok', null]]);
  assert.equal(log.inFlight(30000), 0, 'the earlier hop is finished');
});
