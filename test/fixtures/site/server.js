// The demo site the tests visit: one node:http server answering for shop.test, cdn.test, pay.test,
// evil.test and tags.test (Chrome maps *.test to 127.0.0.1). A scenario module decides the answers;
// everything the server receives is recorded, so tests can prove nothing left the browser.
import http from 'node:http';
import crypto from 'node:crypto';

export async function startDemoSite() {
  let scenario = null;
  let scenarioName = '';
  let options = {};
  const received = [];
  const wsFrames = [];
  const counters = new Map();

  const server = http.createServer(async (req, res) => {
    const host = (req.headers.host ?? '').split(':')[0];
    const url = new URL(req.url, `http://${req.headers.host}`);
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ method: req.method, host, path: `${url.pathname}${url.search}`, body });
    const key = `${host}${url.pathname}`;
    counters.set(key, (counters.get(key) ?? 0) + 1);
    const ctx = { host, path: url.pathname, query: url.searchParams, method: req.method, body, origin, options, hits: counters.get(key), userAgent: req.headers['user-agent'] ?? '' };
    const answer = scenario?.respond(ctx);
    if (!answer) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    const type = answer.type ?? (url.pathname.endsWith('.js') || answer.js ? 'text/javascript' : 'text/html; charset=utf-8');
    res.writeHead(answer.status ?? 200, { 'content-type': type, ...(answer.headers ?? {}) });
    res.end(answer.body ?? '');
  });

  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', (data) => {
      if ((data[0] & 0x0f) !== 1) return;
      let len = data[1] & 0x7f;
      let offset = 2;
      if (len === 126) { len = data.readUInt16BE(2); offset = 4; }
      const mask = data.subarray(offset, offset + 4);
      const payload = Buffer.from(data.subarray(offset + 4, offset + 4 + len).map((b, i) => b ^ mask[i % 4]));
      wsFrames.push({ host: (req.headers.host ?? '').split(':')[0], text: payload.toString('utf8') });
    });
    socket.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  function origin(host) {
    return `http://${host}:${port}`;
  }

  return {
    port,
    origin,
    received,
    wsFrames,
    async setScenario(name, opts = {}) {
      scenario = await import(new URL(`./scenarios/${name}.js`, import.meta.url));
      scenarioName = name;
      options = opts;
      received.length = 0;
      wsFrames.length = 0;
      counters.clear();
    },
    get scenario() {
      return scenarioName;
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

export const DEMO_HOSTS = ['shop.test', 'cdn.test', 'pay.test', 'evil.test', 'tags.test'];
