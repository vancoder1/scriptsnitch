import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileStatus, readStatus, STATUS_TITLE } from '../../src/report/status-issue.js';
import { readMarker } from '../../src/report/markers.js';
import { emptyStatusState } from '../../src/state.js';
import { createFakeGitHub } from '../helpers/fake-github.js';

const SITE = 'https://shop.example';
const T0 = Date.UTC(2026, 10, 24, 6, 0, 0);
const day = (n) => T0 + n * 86400000;

function runInfo({ conclusive = true, reason = null, drill = null, missed = [], high = 0, medium = 0, submitted = true, failure = null } = {}) {
  return {
    startedAt: '2026-11-24T06:00:00.000Z', finishedAt: '2026-11-24T06:03:10.000Z', failure,
    pages: [
      { site: SITE, path: '/', name: 'Home', profile: 'desktop', conclusive: true, reason: null, probed: false, submitted: null },
      { site: SITE, path: '/checkout', name: 'Checkout', profile: 'desktop', conclusive, reason, probed: true, submitted },
    ],
    high, medium, drill: drill && { result: drill, missed },
  };
}
// One report run: read the state, advance it as judge would, write the status issue.
async function oneRun(gh, n, info) {
  const { issue, state: previous } = await readStatus(gh);
  const state = structuredClone(previous);
  state.run += 1;
  for (const p of info.pages) {
    const key = `${p.site}${p.path}|${p.profile}`;
    const prev = state.pages[key] ?? { lastConclusiveRun: null, inconclusiveStreak: 0 };
    state.pages[key] = p.conclusive ? { lastConclusiveRun: state.run, inconclusiveStreak: 0 } : { lastConclusiveRun: prev.lastConclusiveRun, inconclusiveStreak: prev.inconclusiveStreak + 1 };
  }
  await reconcileStatus(gh, { issue, previous, state, run: info, now: day(n), notes: [] });
}
const statusIssues = (gh) => gh.state.issues.filter((i) => i.title === STATUS_TITLE);

test('creates the status issue once and rewrites it', async () => {
  const gh = createFakeGitHub();
  await oneRun(gh, 0, runInfo());
  await oneRun(gh, 1, runInfo());
  assert.equal(statusIssues(gh).length, 1);
  const issue = statusIssues(gh)[0];
  assert.deepEqual(issue.labels.map((l) => l.name), ['scriptsnitch']);
  const visible = issue.body.replace(/^<!--[\s\S]*?-->\n/, '');
  assert.equal(visible.split('\n')[0], `Last run ${new Date(day(1)).toISOString()}. If this is more than two days old, scriptsnitch has stopped running.`);
  assert.equal(readMarker(issue.body, 'status').run, 2);
  assert.equal(readMarker(issue.body, 'status').log.length, 2);
  assert.match(visible, /Checkout/);
});

test('a closed status issue is reopened, not duplicated', async () => {
  const gh = createFakeGitHub();
  await oneRun(gh, 0, runInfo());
  await gh.updateIssue(statusIssues(gh)[0].number, { state: 'closed' });
  await oneRun(gh, 1, runInfo());
  assert.equal(statusIssues(gh).length, 1);
  assert.equal(statusIssues(gh)[0].state, 'open');
  assert.equal(readMarker(statusIssues(gh)[0].body, 'status').run, 2, 'the state survives the close');
});

test('comments when a page has been inconclusive three runs and when it recovers', async () => {
  const gh = createFakeGitHub();
  const blocked = runInfo({ conclusive: false, reason: 'bot challenge (Cloudflare)' });
  for (let n = 0; n < 4; n++) await oneRun(gh, n, blocked);
  const n = statusIssues(gh)[0].number;
  const comments = () => (gh.state.comments[n] ?? []).map((c) => c.body);
  assert.equal(comments().length, 1, 'one comment at the third run, none at the fourth');
  assert.match(comments()[0], /three runs/);
  assert.match(comments()[0], /Checkout.*desktop/s);
  assert.match(comments()[0], /bot challenge/);
  await oneRun(gh, 4, runInfo());
  assert.equal(comments().length, 2);
  assert.match(comments()[1], /conclusive again/);
  assert.match(comments()[1], /Checkout/);
  assert.match(statusIssues(gh)[0].body, /Checkout/);
});

test('records drill pass and fail', async () => {
  const gh = createFakeGitHub();
  await oneRun(gh, 0, runInfo({ drill: 'pass' }));
  await oneRun(gh, 1, runInfo({ drill: 'fail', missed: ['listener'] }));
  await oneRun(gh, 2, runInfo({ drill: 'fail', missed: ['listener'] }));
  await oneRun(gh, 3, runInfo());
  const issue = statusIssues(gh)[0];
  const log = readMarker(issue.body, 'status').log;
  assert.deepEqual(log.map((l) => l[4]), ['pass', 'fail', 'fail', null]);
  const comments = (gh.state.comments[issue.number] ?? []).map((c) => c.body);
  assert.equal(comments.length, 2, 'a comment when the result changes, not on every drill');
  assert.match(comments[0], /drill passed/i);
  assert.match(comments[1], /drill failed.*listener/is);
});

test('records a failed run on the status issue and keeps the state', async () => {
  const gh = createFakeGitHub();
  await oneRun(gh, 0, runInfo());
  const { issue, state } = await readStatus(gh);
  await reconcileStatus(gh, { issue, previous: state, state, run: runInfo({ failure: 'no snapshot: the collect job failed or uploaded nothing' }), now: day(1), notes: [] });
  const body = statusIssues(gh)[0].body;
  assert.match(body, /no snapshot/);
  assert.deepEqual(readMarker(body, 'status'), state);
});

test('notes from the run are shown, escaped', async () => {
  const gh = createFakeGitHub();
  const { issue, state } = await readStatus(gh);
  await reconcileStatus(gh, { issue, previous: state, state: { ...state, run: 1 }, run: runInfo(), now: day(0), notes: ['the cross-check could not compare https://cdn.example/@evil/x.js'] });
  const body = statusIssues(gh)[0].body;
  assert.ok(!body.includes('https://cdn.example/@evil'));
  assert.match(body, /cross-check/);
  assert.deepEqual((await readStatus(createFakeGitHub())).state, emptyStatusState());
});

test('the status issue body stays under GitHub\'s limit however large the state grows', async () => {
  const gh = createFakeGitHub();
  const { issue, state } = await readStatus(gh);
  const big = structuredClone(state);
  big.run = 5000;
  for (let r = 1; r <= 4000; r++) big.log.push(['2026-01-01', 12, 0, 1, null]);
  for (let i = 0; i < 2000; i++) big.sightings[`new-destination|https://h${i}.example.test/a/long/path/for/size|*`] = [4999];
  await reconcileStatus(gh, { issue, previous: state, state: big, run: runInfo(), now: day(0), notes: [] });
  assert.ok(statusIssues(gh)[0].body.length < 65536);
});
