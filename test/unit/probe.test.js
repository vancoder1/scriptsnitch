import { test } from 'node:test';
import assert from 'node:assert/strict';
import { holdNetwork } from '../../src/capture/probe.js';

// A browser context whose sessions answer CDP commands, failing the ones a test names.
function fakeCtx(failing = []) {
  const handlers = new Map();
  return {
    sessions: new Map([['s1', { id: 's1', type: 'page' }]]),
    on: (event, fn) => handlers.set(event, fn),
    onSession: () => {},
    send: async (method) => { if (failing.includes(method)) throw new Error(`${method} failed`); return {}; },
  };
}

test('a hold that cannot be set up stops the probe before anything is typed', async () => {
  await assert.rejects(holdNetwork(fakeCtx(['Fetch.enable'])), /could not hold the network/);
  await assert.rejects(holdNetwork(fakeCtx(['Network.emulateNetworkConditions'])), /could not hold the network/);
  assert.ok(Array.isArray(await holdNetwork(fakeCtx())));
});
