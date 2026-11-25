// Writes docs/example-issue.md and docs/example-pr.md from a real run: the demo site's baseline is
// collected and reported to an in-memory GitHub, everything is approved as a person would, the
// baseline is checked clean, then the gtm-inline-skimmer scenario is collected and reported. The
// issue and pull request bodies are copied as written; only the demo's host names are rewritten
// (`http://name.test:PORT` -> `https://name.example`) and the hidden state markers left out.
//
//   npm run examples
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { collect } from '../../../src/modes/collect.js';
import { report } from '../../../src/modes/report.js';
import { parseConfig } from '../../../src/config/config.js';
import { parseApproved, emptyApproved, approvePending, serializeApproved, siteSection } from '../../../src/config/approved.js';
import { readMarker } from '../../../src/report/markers.js';
import { findChrome } from '../../../src/chrome/find.js';
import { startDemoSite } from './server.js';
import { demoChromeArgs } from '../../helpers/browser.js';
import { createFakeGitHub } from '../../helpers/fake-github.js';
import { writeZip } from '../../helpers/zip-writer.js';

const PATH = 'scriptsnitch/approved.json';
const T0 = Date.UTC(2026, 10, 24, 6);
const DOCS = new URL('../../../docs/', import.meta.url);

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

const executable = findChrome({});
if (!executable) throw new Error('Chrome is required');
const site = await startDemoSite();
const work = mkdtempSync(join(tmpdir(), 'scriptsnitch-examples-'));
try {
  const config = parseConfig(JSON.stringify({ notify: ['octocat'], profiles: ['desktop'], pages: [{ name: 'Sign in', url: `${site.origin('shop.test')}/login`, sensitive: true }] }), 'config.json');
  const gh = createFakeGitHub({ permissions: { octocat: 'write' } });

  async function run(n, scenario) {
    await site.setScenario(scenario);
    const outDir = join(work, `run${n}`);
    mkdirSync(outDir, { recursive: true });
    const text = gh.file(PATH, 'main');
    const approved = text ? parseApproved(text, PATH) : emptyApproved();
    const now = T0 + n * 86400000;
    await collect({ config, approved, outDir, executable, extraArgs: demoChromeArgs(site.port), fetchImpl: demoFetch, now: () => now });
    await report({
      snapshotPath: join(outDir, 'snapshot.json'), outDir, config, approved, approvedPath: PATH, github: gh, propose: 'pr',
      workflowFile: 'scriptsnitch.yml', runId: 100 + n, runUrl: `https://github.com/acme/shop/actions/runs/${100 + n}`, repoUrl: 'https://github.com/acme/shop',
      now, resolve: async () => ['192.0.2.1'], fetchImpl: async () => new Response('{}', { status: 404 }), summaryPath: join(outDir, 'summary.md'),
    });
    // The run's artifact, so the next run can diff against this run's evidence.
    const evidenceDir = join(outDir, 'evidence');
    const files = readdirSync(evidenceDir).map((f) => ({ name: `evidence/${f}`, data: readFileSync(join(evidenceDir, f)) }));
    gh.state.runs.push({ id: 100 + n, workflowFile: 'scriptsnitch.yml', status: 'completed', conclusion: 'success' });
    gh.state.artifacts[100 + n] = [{ id: 1000 + n, name: 'scriptsnitch', expired: false }];
    gh.state.blobs[1000 + n] = writeZip([{ name: 'snapshot.json', data: readFileSync(join(outDir, 'snapshot.json')) }, ...files]);
  }

  // The first run proposes the inventory; a person merges it, approves what is pending, writes reasons.
  await run(0, 'baseline');
  const first = gh.state.pulls.find((p) => p.state === 'open');
  gh.mergePull(first.number);
  let approved = parseApproved(gh.file(PATH, 'main'), PATH);
  for (const p of siteSection(approved, site.origin('shop.test')).pending) approved = approvePending(approved, site.origin('shop.test'), p.finding, 'Reviewed by the team');
  gh.commitFile(PATH, serializeApproved(approved).replaceAll('TODO: why does this page need it?', 'Part of the shop'), { author: 'octocat' });
  await run(1, 'baseline');
  await run(2, 'gtm-inline-skimmer');

  // The demo serves http://name.test:PORT; a real site would be https://name.example. Entry ids are
  // made from URLs, so they carry the demo's host and port too (tags-test-PORT-gtm-js...).
  const tidy = (body) => body
    .replace(/<!--\s*scriptsnitch:[\s\S]*?-->\n?/g, '')
    .replace(/http(:\/\/|\[:\]\/\/)([a-z0-9.-]+)\.test:\d+/g, 'https$1$2.example')
    .replace(/([a-z0-9.-]+)\.test:\d+/g, '$1.example')
    .replace(/\b([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.test\b/g, '$1.example')
    .replace(/\b([a-z0-9]+)-test-\d+-/g, '$1-example-')
    .trimEnd();
  const issue = gh.state.issues.find((i) => readMarker(i.body, 'site') && i.state === 'open');
  const pr = gh.state.pulls.find((p) => p.state === 'open');
  if (!issue || !pr) throw new Error(`expected an open site issue and pull request, got ${gh.state.issues.length} issues and ${gh.state.pulls.length} pull requests`);
  const header = (what) => `<!-- Generated by test/fixtures/site/examples.js from a real run of the demo's gtm-inline-skimmer scenario; the demo's host names are rewritten to example.com-style names. Do not edit by hand. -->\n\n> An example ${what} as scriptsnitch writes it, from a run of the demo site's tag-manager skimmer scenario.\n\n`;
  writeFileSync(new URL('example-issue.md', DOCS), `${header('site issue')}# ${tidy(issue.title)}\n\n${tidy(issue.body)}\n`);
  writeFileSync(new URL('example-pr.md', DOCS), `${header('approval pull request')}# ${tidy(pr.title)}\n\n${tidy(pr.body)}\n`);
  console.log(`wrote docs/example-issue.md (issue #${issue.number}) and docs/example-pr.md (pull request #${pr.number})`);
} finally {
  await site.close();
  rmSync(work, { recursive: true, force: true });
}
