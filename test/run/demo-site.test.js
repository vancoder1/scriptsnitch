import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startDemoSite } from '../fixtures/site/server.js';

const get = (port, host, path) => new Promise((resolve, reject) => {
  request({ host: '127.0.0.1', port, path, headers: { host: `${host}:${port}` } }, (res) => {
    let body = '';
    res.on('data', (c) => { body += c; });
    res.on('end', () => resolve({ status: res.statusCode, body }));
  }).on('error', reject).end();
});

test('the demo site can answer on .localhost names, which Chrome resolves without flags', async (t) => {
  const site = await startDemoSite({ tld: 'localhost', port: 0 });
  t.after(() => site.close());
  await site.setScenario('baseline');
  assert.equal(site.origin('cdn.test'), `http://cdn.localhost:${site.port}`);
  const home = await get(site.port, 'shop.localhost', '/');
  assert.equal(home.status, 200);
  assert.ok(home.body.includes(`http://cdn.localhost:${site.port}/lib@1.2.3/lib.min.js`));
  assert.equal(site.received[0].host, 'shop.test', 'scenarios still see the .test names');
});
