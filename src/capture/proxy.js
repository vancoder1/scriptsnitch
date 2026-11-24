// A small local proxy for probe visits (design §11 "Real effects"). Offline emulation holds the
// WebSocket frames a page sends during the probe, but Chrome releases them when the visit's context
// is torn down; on Linux they then reach the server. A probe visit's context therefore runs through
// this proxy, and cut() destroys every connection just before the context is disposed, so released
// frames are written into a dead socket. It forwards plain HTTP requests and CONNECT tunnels
// (HTTPS, WebSockets); TLS stays end to end. Host names resolve as Chrome's own
// --host-resolver-rules say, and *.localhost is loopback.
import http from 'node:http';
import net from 'node:net';

export function parseHostRules(args = []) {
  const flag = args.find((a) => a.startsWith('--host-resolver-rules='));
  if (!flag) return [];
  return flag.slice('--host-resolver-rules='.length).split(',').map((r) => r.trim().split(/\s+/)).filter(([verb]) => verb === 'MAP').map(([, pattern, target]) => ({ pattern: pattern.toLowerCase(), target }));
}

const matches = (pattern, host) => (pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : pattern === host);
const HOP_BY_HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive']);

export async function startProxy({ rules = [] } = {}) {
  const sockets = new Set();
  let refusing = false;
  const track = (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => s.destroy()); return s; };
  const resolveHost = (host) => {
    const h = host.toLowerCase().replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost')) return '127.0.0.1';
    return rules.find((r) => matches(r.pattern, h))?.target ?? h;
  };

  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url); } catch { url = null; }
    if (refusing || !url || url.protocol !== 'http:') { res.writeHead(refusing ? 502 : 400).end(); return; }
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP_BY_HOP.has(k)));
    const upstream = http.request({ host: resolveHost(url.hostname), port: url.port || 80, method: req.method, path: `${url.pathname}${url.search}`, headers, setHost: false }, (answer) => {
      const kept = [];
      for (let i = 0; i < answer.rawHeaders.length; i += 2) {
        if (!HOP_BY_HOP.has(answer.rawHeaders[i].toLowerCase())) kept.push(answer.rawHeaders[i], answer.rawHeaders[i + 1]);
      }
      res.writeHead(answer.statusCode, answer.statusMessage, kept);
      answer.pipe(res);
    });
    upstream.on('socket', track);
    upstream.on('error', () => res.destroy());
    req.pipe(upstream);
  });

  server.on('connection', track);
  server.on('connect', (req, client, head) => {
    if (refusing) { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(req.url);
    if (!m) { client.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
    const upstream = track(net.connect(Number(m[2]), resolveHost(m[1]), () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    }));
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    // Destroys every connection and refuses new ones; whatever Chrome writes afterwards goes nowhere.
    cut() {
      refusing = true;
      for (const s of sockets) s.destroy();
    },
    close() {
      refusing = true;
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
