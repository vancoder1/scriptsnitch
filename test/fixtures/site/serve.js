// Runs the demo site for the self-test workflows, answering on *.localhost:
//   node test/fixtures/site/serve.js --port 8123 --scenario baseline
// A control server on the next port switches scenarios: GET http://127.0.0.1:8124/scenario?name=intermittent
import http from 'node:http';
import { startDemoSite } from './server.js';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const port = Number(arg('port', '8123'));
const site = await startDemoSite({ tld: 'localhost', port });
await site.setScenario(arg('scenario', 'baseline'));
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://control');
  const name = url.searchParams.get('name') ?? '';
  if (url.pathname !== '/scenario' || !/^[a-z0-9-]+$/.test(name)) { res.statusCode = 404; res.end(); return; }
  await site.setScenario(name);
  res.end(`scenario ${name}\n`);
}).listen(port + 1, '127.0.0.1');
console.log(`demo site on http://shop.localhost:${port}/ (control on 127.0.0.1:${port + 1})`);
