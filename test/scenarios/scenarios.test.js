// Every scenario of design §17, through `check` against the demo site, as scheduled runs see them:
// the base scenario is checked, everything it shows is approved, it is checked again (it must be
// clean), and then the scenario runs with that approved file and state. Attacks assert the exact
// finding kinds; false alarms assert zero High and Medium.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { check } from '../../src/modes/check.js';
import { parseConfig } from '../../src/config/config.js';
import { emptyApproved } from '../../src/config/approved.js';
import { applyProposals } from '../../src/analyze/proposals.js';
import { emptyStatusState } from '../../src/state.js';
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

// The cloaking cross-check fetches from Node, which cannot resolve the demo's *.test hosts.
function demoFetch(url, init = {}) {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    request({ host: '127.0.0.1', port: u.port, path: `${u.pathname}${u.search}`, method: init.method ?? 'GET', headers: { ...(init.headers ?? {}), host: u.host, 'user-agent': 'node' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    }).on('error', reject).end();
  });
}

const pageUrl = (path) => `${site.origin('shop.test')}${path}`;
const config = (pages, profiles) => parseConfig(JSON.stringify({ profiles, pages: pages.map((p) => ({ name: p, url: pageUrl(p), ...(p === '/' ? {} : { sensitive: true }) })) }), 'config.json');
async function runCheck(cfg, approved, state) {
  const outDir = mkdtempSync(join(tmpdir(), 'ss-sc-'));
  dirs.push(outDir);
  return check({ config: cfg, approved, outDir, executable, extraArgs: demoChromeArgs(site.port), fetchImpl: demoFetch, state });
}
const kinds = (r) => r.report.findings.map((f) => `${f.kind}:${f.severity}`).sort();
const describe = (r) => r.report.findings.map((f) => `${f.kind}:${f.severity} ${f.subject} — ${f.reasons[0]}`).join('\n');

// A clean, approved starting point for a base scenario, cached per base, pages and profiles.
const bases = new Map();
async function establish(base, pages, profiles) {
  const key = `${base}|${pages}|${profiles}`;
  if (bases.has(key)) return bases.get(key);
  const cfg = config(pages, profiles);
  await site.setScenario(base);
  const first = await runCheck(cfg, emptyApproved(), emptyStatusState());
  const approved = applyProposals(emptyApproved(), site.origin('shop.test'), first.report.proposals.map((p) => ({ ...p, mode: 'routine' })));
  await site.setScenario(base);
  const second = await runCheck(cfg, approved, first.state);
  assert.deepEqual(kinds(second), [], `the base scenario ${base} is clean once approved:\n${describe(second)}`);
  const ready = { cfg, approved, state: second.state };
  bases.set(key, ready);
  return ready;
}

async function scenario(name, { base = 'baseline', pages = ['/login'], profiles = ['desktop'], after: then = null } = {}) {
  let { cfg, approved, state } = await establish(base, pages, profiles);
  if (then) {
    await site.setScenario(then);
    state = (await runCheck(cfg, approved, state)).state;
  }
  await site.setScenario(name);
  return runCheck(cfg, approved, state);
}

const attack = (title, name, expected, options) => test(`attack: ${title}`, async (t) => {
  if (!site) return t.skip('no Chrome');
  const r = await scenario(name, options);
  assert.deepEqual(kinds(r), [...expected].sort(), describe(r));
});
const quiet = (title, name, options) => test(`quiet: ${title}`, async (t) => {
  if (!site) return t.skip('no Chrome');
  const r = await scenario(name, options);
  assert.deepEqual(kinds(r), [], describe(r));
});
const medium = (title, name, expected, options) => test(`expected Medium: ${title}`, async (t) => {
  if (!site) return t.skip('no Chrome');
  const r = await scenario(name, options);
  assert.deepEqual(kinds(r), [expected], describe(r));
});

attack('injected script → new-origin High', 'injected-script', ['new-origin:high']);
attack('tag-manager container under a new account key → new-origin High', 'gtm-foreign-key', ['new-origin:high'], { base: 'gtm-real-base' });
attack('skimmer file dropped in the build folder without a deploy → build-file High', 'build-drop', ['build-file:high']);
attack('a new script added to the HTML as a new entry slot → build-file High', 'new-entry-slot', ['build-file:high']);
// The edited files also add a submit listener on the document, whose code runs during the probe's
// input; combination raises both to High. Most skimmers below run code during input, too.
attack('in-place edit of an own path-versioned file → in-place-change High', 'versioned-edit', ['input-code:high', 'in-place-change:high', 'listener:high'], { base: 'versioned-base' });
attack('changed versioned third-party file → content-mismatch High', 'lib-changed', ['input-code:high', 'content-mismatch:high', 'listener:high']);
attack('hashed file changed in place → in-place-change High', 'hashed-in-place', ['in-place-change:high']);
attack('tag-manager-injected inline skimmer → behaviour Highs on the approved tag manager', 'gtm-inline-skimmer', ['input-code:high', 'hostname:high', 'listener:high', 'new-destination:high', 'probe-exfil:high']);
attack('jQuery-delegated listener, caught by input-time code → input-code High', 'jquery-delegated', ['input-code:high', 'input-code:high', 'listener:high', 'new-origin:high', 'new-slot:high']);
attack('card-field iframe from a new origin → frame-field High', 'card-frame-new-origin', ['frame-field:high'], { pages: ['/checkout'] });
attack('second card field overlaid after "Place order" → new-field High', 'card-overlay-after-submit', ['input-code:high', 'listener:high', 'new-field:high', 'new-field:high', 'new-origin:high']);
// Prefetch hints present at load are Medium; nothing ties them to a script.
attack('keyboard listener on the password field → listener High', 'listeners', ['input-code:high', 'listener:high', 'listener:high', 'listener:high', 'new-destination:medium', 'new-destination:medium', 'new-origin:high']);
attack('mouseup listener on the submit button → listener High', 'mouseup-skimmer', ['input-code:high', 'listener:high', 'new-destination:high', 'new-origin:high', 'probe-exfil:high']);
attack('WebSocket exfiltration on submit → probe-exfil High', 'ws-exfil', ['input-code:high', 'listener:high', 'new-destination:high', 'new-origin:high', 'probe-exfil:high']);
attack('delayed send → probe-exfil High', 'delayed-send', ['input-code:high', 'listener:high', 'new-destination:high', 'new-origin:high', 'probe-exfil:high']);
attack('unload beacon → probe-exfil High', 'unload-beacon', ['listener:high', 'new-destination:high', 'new-origin:high', 'probe-exfil:high']);
attack('value stashed in localStorage → probe-exfil High', 'stash', ['input-code:high', 'listener:high', 'new-origin:high', 'probe-exfil:high']);
attack('base64 at an odd offset → probe-exfil High', 'base64-offset', ['input-code:high', 'listener:high', 'new-destination:high', 'new-origin:high', 'probe-exfil:high']);
attack('encrypted payload, caught by the second probe → probe-exfil High', 'encrypted-exfil', ['input-code:high', 'listener:high', 'new-destination:high', 'new-origin:high', 'probe-exfil:high']);
attack('post to a collector on the site\'s own origin → probe-exfil High', 'own-collector', ['input-code:high', 'listener:high', 'new-origin:high', 'probe-exfil:high']);
attack('post to an image path → probe-exfil High', 'image-path', ['input-code:high', 'listener:high', 'new-origin:high', 'probe-exfil:high']);
attack('analytics collect with a foreign key → new-destination and probe-exfil High', 'analytics-foreign-key', ['input-code:high', 'listener:high', 'new-destination:high', 'new-origin:high', 'probe-exfil:high']);
attack('WebTransport → new-destination High', 'webtransport', ['input-code:high', 'listener:high', 'new-destination:high', 'new-origin:high']);
attack('dns-prefetch exfiltration → probe-exfil High', 'dns-prefetch-exfil', ['input-code:high', 'listener:high', 'new-destination:high', 'new-origin:high', 'probe-exfil:high']);
attack('peer connection → peer-connection High', 'webrtc', ['new-origin:high', 'peer-connection:high']);
attack('blob: worker → new-destination and probe-exfil High', 'blob-worker', ['input-code:high', 'listener:high', 'new-destination:high', 'new-origin:high', 'probe-exfil:high']);
attack('mobile-only script → new-origin High on mobile', 'mobile-only', ['new-origin:high'], { profiles: ['desktop', 'mobile'] });
attack('cloaked file → content-mismatch and cloaking High', 'cloaked', ['input-code:high', 'cloaking:high', 'content-mismatch:high', 'listener:high']);
attack('page with a debugger; loop → still judged', 'debugger-loop', ['input-code:high', 'new-origin:high', 'new-inline:high']);

quiet('a deploy that renames and adds chunks (Vite style)', 'vite-deploy', { pages: ['/', '/login'] });
quiet('a deploy that renames and adds chunks (webpack style)', 'webpack-deploy', { base: 'webpack-base', pages: ['/', '/login'] });
quiet('a lazily loaded chunk first seen a day after a deploy', 'vite-lazy', { pages: ['/', '/login'], after: 'vite-deploy' });
quiet('per-visit token in a URL', 'cache-buster', { base: 'cache-buster', pages: ['/'] });
quiet('nonce and data-blob changes in inline scripts', 'inline-churn', { base: 'inline-churn', pages: ['/'] });
quiet('a Next-style flight payload change', 'next-flight', { base: 'next-flight', pages: ['/'] });
quiet('reCAPTCHA-style rotating release file under an approved loader', 'rotating-release', { base: 'rotating-release', pages: ['/'] });
quiet('approved A/B variant', 'ab-variant', { base: 'ab-variant' });
quiet('framework root and analytics document listeners already approved', 'framework-listeners', { base: 'framework-listeners' });
quiet('a page with a long-polling connection', 'long-poll', { base: 'long-poll', pages: ['/'] });
quiet('a script that appears in only one visit at an approved slot', 'sometimes-lib');
quiet('hash-based CSP churn', 'csp-hash-churn', { base: 'csp-base', pages: ['/'] });
quiet('adopting a strict CSP with \'strict-dynamic\'', 'csp-strict', { base: 'csp-base', pages: ['/'] });

medium('a library upgrade → new-version', 'lib-upgrade', 'new-version:medium', { pages: ['/'] });
medium('a new CSP host → csp-source', 'csp-new-host', 'csp-source:medium', { base: 'csp-base', pages: ['/'] });
