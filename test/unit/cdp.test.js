import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createConnection, CdpError, CdpTimeoutError, ChromeExitedError } from '../../src/chrome/cdp.js';

// A fake Chrome: what the connection writes arrives on `sent`; what we push on `fromChrome` is read.
function fakeChrome() {
  const fromChrome = new PassThrough();
  const toChrome = new PassThrough();
  const sent = [];
  let buf = '';
  toChrome.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\0')) !== -1) { sent.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); }
  });
  const reply = (obj) => fromChrome.write(JSON.stringify(obj) + '\0');
  return { fromChrome, toChrome, sent, reply };
}
const tick = () => new Promise((r) => setImmediate(r));

test('frames outgoing messages with a NUL byte and increasing ids', async () => {
  const c = fakeChrome();
  const conn = createConnection({ input: c.fromChrome, output: c.toChrome });
  conn.send('A.one', { x: 1 }).catch(() => {});
  conn.send('B.two', {}, 'S1').catch(() => {});
  await tick();
  assert.deepEqual(c.sent, [{ id: 1, method: 'A.one', params: { x: 1 } }, { id: 2, method: 'B.two', params: {}, sessionId: 'S1' }]);
  conn.close();
});

test('routes a response split across chunks', async () => {
  const c = fakeChrome();
  const conn = createConnection({ input: c.fromChrome, output: c.toChrome });
  const p = conn.send('Browser.getVersion');
  await tick();
  const frame = JSON.stringify({ id: 1, result: { product: 'Chrome/157' } }) + '\0';
  c.fromChrome.write(frame.slice(0, 10));
  c.fromChrome.write(frame.slice(10));
  assert.deepEqual(await p, { product: 'Chrome/157' });
  conn.close();
});

test('handles two messages in one chunk', async () => {
  const c = fakeChrome();
  const conn = createConnection({ input: c.fromChrome, output: c.toChrome });
  const a = conn.send('A');
  const b = conn.send('B');
  await tick();
  c.fromChrome.write(JSON.stringify({ id: 1, result: { v: 'a' } }) + '\0' + JSON.stringify({ id: 2, result: { v: 'b' } }) + '\0');
  assert.deepEqual([await a, await b], [{ v: 'a' }, { v: 'b' }]);
  conn.close();
});

test('delivers events with their sessionId', async () => {
  const c = fakeChrome();
  const conn = createConnection({ input: c.fromChrome, output: c.toChrome });
  const got = [];
  conn.on('Debugger.scriptParsed', (params, sessionId) => got.push([params.url, sessionId]));
  c.reply({ method: 'Debugger.scriptParsed', params: { url: 'https://a.test/x.js' }, sessionId: 'S9' });
  c.reply({ method: 'Network.requestWillBeSent', params: {} });
  await tick();
  assert.deepEqual(got, [['https://a.test/x.js', 'S9']]);
  conn.close();
});

test('unsubscribe stops delivery', async () => {
  const c = fakeChrome();
  const conn = createConnection({ input: c.fromChrome, output: c.toChrome });
  let n = 0;
  const off = conn.on('E.x', () => n++);
  c.reply({ method: 'E.x', params: {} });
  await tick();
  off();
  c.reply({ method: 'E.x', params: {} });
  await tick();
  assert.equal(n, 1);
  conn.close();
});

test('rejects with CdpError on an error response', async () => {
  const c = fakeChrome();
  const conn = createConnection({ input: c.fromChrome, output: c.toChrome });
  const p = conn.send('DOM.querySelector');
  await tick();
  c.reply({ id: 1, error: { code: -32000, message: 'No node with given id found' } });
  await assert.rejects(p, (e) => e instanceof CdpError && e.method === 'DOM.querySelector' && e.code === -32000);
  conn.close();
});

test('rejects with CdpTimeoutError after timeoutMs', async () => {
  const c = fakeChrome();
  const conn = createConnection({ input: c.fromChrome, output: c.toChrome, timeoutMs: 20 });
  await assert.rejects(conn.send('Slow.call'), (e) => e instanceof CdpTimeoutError && e.method === 'Slow.call');
  conn.close();
});

test('rejects pending commands with ChromeExitedError when Chrome goes away', async () => {
  const c = fakeChrome();
  const conn = createConnection({ input: c.fromChrome, output: c.toChrome });
  let closed = false;
  conn.onClose(() => { closed = true; });
  const p = conn.send('Never.answered');
  await tick();
  c.fromChrome.end();
  await assert.rejects(p, ChromeExitedError);
  assert.equal(closed, true);
  await assert.rejects(conn.send('After.close'), ChromeExitedError);
});
