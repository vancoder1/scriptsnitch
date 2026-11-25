import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { startProxy, parseHostRules } from '../../src/capture/proxy.js';

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
function echoServer() {
  const sockets = new Set();
  const server = net.createServer((s) => { sockets.add(s); s.on('data', (d) => s.write(d)); s.on('error', () => {}); });
  return { server, sockets };
}
// Opens a tunnel through the proxy and resolves with the socket once the proxy answered.
function connect(proxyPort, target) {
  return new Promise((resolve) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`));
    s.once('data', (d) => resolve({ socket: s, answer: d.toString() }));
    s.on('error', () => {});
  });
}
const nextData = (s) => new Promise((r) => s.once('data', (d) => r(d.toString())));
const closed = (s) => new Promise((r) => { if (s.destroyed) r(); else s.once('close', r); });

test('tunnels CONNECT, then cut closes every tunnel and refuses new ones', async (t) => {
  const echo = echoServer();
  const port = await listen(echo.server);
  const proxy = await startProxy();
  t.after(async () => { await proxy.close(); echo.server.close(); });
  const { socket, answer } = await connect(proxy.port, `127.0.0.1:${port}`);
  assert.match(answer, /^HTTP\/1\.1 200/);
  socket.write('hello');
  assert.equal(await nextData(socket), 'hello');
  proxy.cut();
  await closed(socket);
  const again = await connect(proxy.port, `127.0.0.1:${port}`);
  assert.match(again.answer, /^HTTP\/1\.1 502/);
});

test('while the probe holds the network, new tunnels are refused before their names are looked up; open ones stay', async (t) => {
  const echo = echoServer();
  const port = await listen(echo.server);
  // The host rule stands in for name resolution: without the hold, this tunnel would be opened.
  const proxy = await startProxy({ rules: [{ pattern: '*.evil.example', target: '127.0.0.1' }] });
  t.after(async () => { await proxy.close(); echo.server.close(); });
  const open = await connect(proxy.port, `127.0.0.1:${port}`);
  proxy.hold();
  const leak = await connect(proxy.port, `4111111111111111.evil.example:${port}`);
  assert.match(leak.answer, /^HTTP\/1\.1 502/);
  open.socket.write('still');
  assert.equal(await nextData(open.socket), 'still');
});

test('data written after the cut never reaches the server', async (t) => {
  const received = [];
  const server = net.createServer((s) => { s.on('data', (d) => received.push(d.toString())); s.on('error', () => {}); });
  const port = await listen(server);
  const proxy = await startProxy();
  t.after(async () => { await proxy.close(); server.close(); });
  const { socket } = await connect(proxy.port, `127.0.0.1:${port}`);
  socket.write('before');
  await new Promise((r) => setTimeout(r, 50));
  proxy.cut();
  socket.write('after', () => {});
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(received.join(''), 'before');
});

test('forwards plain HTTP requests in absolute form, applying the host rules', async (t) => {
  const server = http.createServer((req, res) => res.end(`${req.headers.host} ${req.url}`));
  const port = await listen(server);
  const proxy = await startProxy({ rules: parseHostRules([`--host-resolver-rules=MAP *.test 127.0.0.1`]) });
  t.after(async () => { await proxy.close(); server.close(); });
  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: proxy.port, path: `http://shop.test:${port}/a?b=1`, headers: { host: `shop.test:${port}` } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve(text));
    }).on('error', reject);
  });
  assert.equal(body, `shop.test:${port} /a?b=1`);
});

test('localhost names are loopback, and host rules map tunnels too', async (t) => {
  const echo = echoServer();
  const port = await listen(echo.server);
  const proxy = await startProxy({ rules: parseHostRules(['--host-resolver-rules=MAP *.test 127.0.0.1']) });
  t.after(async () => { await proxy.close(); echo.server.close(); });
  for (const host of ['shop.localhost', 'evil.test']) {
    const { socket, answer } = await connect(proxy.port, `${host}:${port}`);
    assert.match(answer, /^HTTP\/1\.1 200/, host);
    socket.destroy();
  }
});

test('reads MAP rules from Chrome flags', () => {
  assert.deepEqual(parseHostRules(['--headless', '--host-resolver-rules=MAP *.test 127.0.0.1, MAP api.example 10.0.0.2,EXCLUDE x.test']), [{ pattern: '*.test', target: '127.0.0.1' }, { pattern: 'api.example', target: '10.0.0.2' }]);
  assert.deepEqual(parseHostRules([]), []);
});
