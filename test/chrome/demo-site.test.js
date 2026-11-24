import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startDemoSite } from '../fixtures/site/server.js';

function get(port, host, path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: { host: `${host}:${port}` } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
    }).on('error', reject);
  });
}

test('serves each demo host separately and records what it receives', async () => {
  const site = await startDemoSite();
  try {
    await site.setScenario('baseline');
    const home = await get(site.port, 'shop.test', '/');
    assert.equal(home.status, 200);
    assert.match(home.body, /assets\/index-B7kQ0aRz\.js/);
    assert.match(home.body, new RegExp(`http://cdn.test:${site.port}/lib@1.2.3/lib.min.js`));
    const lib = await get(site.port, 'cdn.test', '/lib@1.2.3/lib.min.js');
    assert.equal(lib.type, 'text/javascript');
    assert.match(lib.body, /window\.lib=/);
    assert.equal((await get(site.port, 'evil.test', '/lib@1.2.3/lib.min.js')).status, 404);
    assert.deepEqual(site.received.map((r) => `${r.host}${r.path}`), ['shop.test/', 'cdn.test/lib@1.2.3/lib.min.js', 'evil.test/lib@1.2.3/lib.min.js']);
  } finally {
    await site.close();
  }
});
