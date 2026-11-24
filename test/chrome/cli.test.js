import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { startDemoSite } from '../fixtures/site/server.js';
import { demoChromeArgs } from '../helpers/browser.js';
import { requireChrome } from '../helpers/chrome.js';

let site;
let executable;
const dirs = [];
before(async (t) => {
  executable = requireChrome(t);
  if (!executable) return;
  site = await startDemoSite();
});
after(async () => {
  await site?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const tempDir = () => { const d = mkdtempSync(join(tmpdir(), 'scriptsnitch-cli-')); dirs.push(d); return d; };
async function cli(argv, cwd = tempDir()) {
  const out = [];
  const err = [];
  const code = await runCli([...argv, '--chrome', executable], { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, env: process.env, cwd, extraArgs: demoChromeArgs(site.port) });
  return { code, out: out.join(''), err: err.join('') };
}

test('scan prints the demo home inventory as JSON', async (t) => {
  if (!site) return t.skip('no Chrome');
  await site.setScenario('baseline');
  const r = await cli(['scan', `${site.origin('shop.test')}/`, '--json']);
  assert.equal(r.code, 0, r.err);
  const inventory = JSON.parse(r.out);
  const lib = inventory.scripts.find((s) => s.url?.includes('cdn.test'));
  assert.equal(lib.suggestedTrust, 'exact');
  assert.equal(inventory.scripts.find((s) => s.url?.includes('/assets/index-')).suggestedTrust, 'deploy');
  assert.ok(inventory.destinations.some((d) => d.url.endsWith('/api/ping')));
  assert.equal(inventory.headers['x-frame-options'], 'DENY');
});

test('scan prints a readable table by default', async (t) => {
  if (!site) return t.skip('no Chrome');
  await site.setScenario('baseline');
  const r = await cli(['scan', `${site.origin('shop.test')}/`]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Scripts \(\d+\)/);
  assert.match(r.out, /exact\s+http:\/\/cdn\.test:\d+\/lib@1\.2\.3\/lib\.min\.js/);
});

test('init writes a config with the login and checkout pages marked sensitive', async (t) => {
  if (!site) return t.skip('no Chrome');
  await site.setScenario('baseline');
  const cwd = tempDir();
  const home = `${site.origin('shop.test')}/`;
  const r = await cli(['init', home], cwd);
  assert.equal(r.code, 0, r.err);
  const config = JSON.parse(readFileSync(join(cwd, 'scriptsnitch', 'config.json'), 'utf8'));
  const byPath = Object.fromEntries(config.pages.map((p) => [new URL(p.url).pathname, p]));
  assert.deepEqual(Object.keys(byPath).sort(), ['/', '/checkout', '/login']);
  assert.equal(byPath['/login'].sensitive, true);
  assert.equal(byPath['/checkout'].sensitive, true);
  assert.equal(byPath['/'].sensitive, undefined);
  const approved = JSON.parse(readFileSync(join(cwd, 'scriptsnitch', 'approved.json'), 'utf8'));
  assert.ok(approved.sites[site.origin('shop.test')].scripts.length > 0);
  assert.equal((await cli(['init', home], cwd)).code, 3, 'init never overwrites an existing config');
});

test('check exits 1 when an unapproved script appears and 0 after approve --all', async (t) => {
  if (!site) return t.skip('no Chrome');
  await site.setScenario('baseline');
  const cwd = tempDir();
  mkdirSync(join(cwd, 'scriptsnitch'));
  writeFileSync(join(cwd, 'scriptsnitch', 'config.json'), JSON.stringify({ profiles: ['desktop'], pages: [{ name: 'Home', url: `${site.origin('shop.test')}/`, expect: { selector: '#main' } }] }));
  const first = await cli(['check'], cwd);
  assert.equal(first.code, 1, first.err);
  assert.ok(existsSync(join(cwd, 'scriptsnitch-out', 'report.json')));
  assert.equal((await cli(['approve', '--all'], cwd)).code, 0);
  const clean = await cli(['check'], cwd);
  assert.equal(clean.code, 0, clean.out);
  await site.setScenario('intermittent');
  const skimmed = await cli(['check'], cwd);
  assert.equal(skimmed.code, 1);
  assert.match(skimmed.out, /new-origin.*evil\.test/);
});

test('unknown command exits 3 with usage', async () => {
  const err = [];
  const code = await runCli(['frobnicate'], { stdout: { write: () => {} }, stderr: { write: (s) => err.push(s) }, env: {}, cwd: tmpdir() });
  assert.equal(code, 3);
  assert.match(err.join(''), /Usage/);
});
