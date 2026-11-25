import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileSite, readSites } from '../../src/report/site-issue.js';
import { readMarker } from '../../src/report/markers.js';
import { findingKey } from '../../src/analyze/keys.js';
import { createFakeGitHub } from '../helpers/fake-github.js';

const SITE = 'https://shop.example';
const T0 = Date.UTC(2026, 10, 24, 6);
const day = (n) => T0 + n * 86400000;
const f = (kind, subject, severity, { site = SITE, page = '*', seenOn = ['/'], profiles = ['desktop'], reasons = ['because'] } = {}) => ({ kind, key: findingKey(kind, subject, page), severity, site, page, profiles, subject, reasons, evidence: [], seenOn, firstRun: false });
const H1 = f('new-origin', 'https://evil.example/x.js', 'high', { seenOn: ['/checkout'], reasons: ['a script from https://evil.example, which nothing approves'] });
const M1 = f('new-slot', 'https://chat.example/extra.js', 'medium');
const M2 = f('new-destination', 'https://api.example', 'medium');
const allConclusive = new Set(['/|desktop', '/checkout|desktop']);

async function step(gh, n, findings, { site = SITE, conclusive = allConclusive, notify = [] } = {}) {
  const sites = await readSites(gh);
  const { issue, state } = sites.get(site) ?? {};
  return reconcileSite(gh, { site, issue, siteState: state, findings, run: { conclusive }, now: day(n), notify, links: { runUrl: 'https://github.com/acme/repo/actions/runs/1', prUrl: null, evidenceUrl: null }, diffs: new Map() });
}
const issuesFor = (gh, site = SITE) => gh.state.issues.filter((i) => readMarker(i.body, 'site')?.site === site);
const commentsOn = (gh, issue) => (gh.state.comments[issue.number] ?? []).map((c) => c.body);

test('opens one issue per site with the worst severity in the title', async () => {
  const gh = createFakeGitHub();
  await step(gh, 0, [M1, H1]);
  await step(gh, 0, [f('new-slot', 'https://w.example/a.js', 'medium', { site: 'https://other.example' })], { site: 'https://other.example' });
  await step(gh, 1, [M1, H1]);
  const [issue] = issuesFor(gh);
  assert.equal(issuesFor(gh).length, 1);
  assert.equal(issue.title, '🔴 scriptsnitch: 2 unapproved changes on shop.example');
  assert.deepEqual(issue.labels.map((l) => l.name), ['scriptsnitch']);
  assert.equal(issuesFor(gh, 'https://other.example')[0].title, '🟠 scriptsnitch: 1 unapproved change on other.example');
  assert.match(issue.body, /`https:\/\/evil\.example\/x\.js`/);
  const visible = issue.body.replace(/^<!--[\s\S]*?-->\n/, '');
  assert.ok(!/https:\/\/evil\.example, which/.test(visible), 'reasons are defanged in the visible text');
  assert.match(visible, /https\[:\]\/\/evil\.example, which/);
  assert.ok(visible.indexOf('evil.example/x.js') < visible.indexOf('chat.example/extra.js'), 'High first');
  assert.ok(issue.body.includes(H1.key), 'the finding key is shown for the comment command');
});

test('comments only when a new key appears', async () => {
  const gh = createFakeGitHub();
  await step(gh, 0, [M1]);
  await step(gh, 1, [M1]);
  const [issue] = issuesFor(gh);
  assert.deepEqual(commentsOn(gh, issue), []);
  await step(gh, 2, [M1, M2]);
  await step(gh, 3, [M1, M2]);
  assert.equal(commentsOn(gh, issue).length, 1);
  assert.match(commentsOn(gh, issue)[0], /api\.example/);
  assert.ok(!commentsOn(gh, issue)[0].includes('chat.example'));
});

test('drops a Medium after two conclusive runs and lists a return within 30 days without a comment', async () => {
  const gh = createFakeGitHub();
  await step(gh, 0, [M1]);
  await step(gh, 1, [], { conclusive: new Set() });
  await step(gh, 2, []);
  let [issue] = issuesFor(gh);
  assert.equal(issue.state, 'open', 'one conclusive miss (the inconclusive run does not count)');
  await step(gh, 3, []);
  [issue] = issuesFor(gh);
  assert.equal(issue.state, 'closed');
  await step(gh, 10, [M1]);
  [issue] = issuesFor(gh);
  assert.equal(issue.state, 'open');
  assert.match(issue.body, /chat\.example\/extra\.js/);
  assert.deepEqual(commentsOn(gh, issue), []);
  await step(gh, 11, []);
  await step(gh, 12, []);
  await step(gh, 50, [M1]);
  assert.equal(commentsOn(gh, issuesFor(gh)[0]).length, 1, 'a return after 30 days is new again');
});

test('keeps a vanished High as "not seen since" and does not close', async () => {
  const gh = createFakeGitHub();
  await step(gh, 0, [H1]);
  for (let n = 1; n <= 5; n++) await step(gh, n, []);
  const [issue] = issuesFor(gh);
  assert.equal(issue.state, 'open');
  assert.match(issue.body, /not seen since 2026-11-24/i);
  assert.equal(issue.title, '🔴 scriptsnitch: 1 unapproved change on shop.example');
});

test('closes when nothing live is unapproved and no High waits', async () => {
  const gh = createFakeGitHub();
  await step(gh, 0, [M1]);
  await step(gh, 1, []);
  await step(gh, 2, []);
  const [issue] = issuesFor(gh);
  assert.equal(issue.state, 'closed');
  assert.equal(issue.title, 'scriptsnitch: nothing unapproved on shop.example');
  assert.equal(readMarker(issue.body, 'site').closedByBot, true);
});

test('closing by hand mutes, and a new key reopens with muted findings collapsed', async () => {
  const gh = createFakeGitHub();
  await step(gh, 0, [H1]);
  let [issue] = issuesFor(gh);
  await gh.updateIssue(issue.number, { state: 'closed' });
  await step(gh, 1, [H1]);
  [issue] = issuesFor(gh);
  assert.equal(issue.state, 'closed', 'a muted finding does not reopen the issue');
  assert.deepEqual(commentsOn(gh, issue), []);
  await step(gh, 2, [H1, M2]);
  [issue] = issuesFor(gh);
  assert.equal(issue.state, 'open');
  assert.equal(commentsOn(gh, issue).length, 1);
  assert.match(commentsOn(gh, issue)[0], /api\.example/);
  assert.match(issue.body, /<details><summary>Muted \(1\)<\/summary>[\s\S]*evil\.example\/x\.js[\s\S]*<\/details>/);
  assert.equal(issue.title, '🟠 scriptsnitch: 1 unapproved change on shop.example');
});

test('assigns notify users and falls back without assignees', async () => {
  const gh = createFakeGitHub({ permissions: { octocat: 'write' } });
  await step(gh, 0, [M1], { notify: ['octocat', 'nobody', 'acme/security'] });
  const [issue] = issuesFor(gh);
  assert.deepEqual(issue.assignees.map((a) => a.login), ['octocat']);
  assert.match(issue.body, /cc @octocat @nobody @acme\/security/);
  await step(gh, 1, [M1, M2], { notify: ['octocat'] });
  assert.match(commentsOn(gh, issue)[0], /cc @octocat/);
});

test('a first-run issue says nothing is approved yet', async () => {
  const gh = createFakeGitHub();
  await step(gh, 0, [{ ...M1, firstRun: true }]);
  assert.match(issuesFor(gh)[0].body, /Nothing is approved for this site yet/);
});

test('a finding with no page (a domain finding) counts as missed on every run it is absent', async () => {
  const gh = createFakeGitHub();
  const domain = { kind: 'domain-expiring', key: 'domain-expiring|widgets.com|*', severity: 'medium', site: SITE, page: '*', profiles: [], subject: 'widgets.com', reasons: ['expires in 10 days'], evidence: [], seenOn: [], firstRun: false };
  await step(gh, 0, [domain]);
  await step(gh, 1, [], { conclusive: new Set() });
  await step(gh, 2, [], { conclusive: new Set() });
  assert.equal(issuesFor(gh)[0].state, 'closed');
});

test('a finding still observed but no longer raised was approved and is resolved, even a High', async () => {
  const gh = createFakeGitHub();
  const high = { ...H1, observedAs: ['content:https://evil.example/x.js|abc'] };
  await step(gh, 0, [high]);
  const sites = await readSites(gh);
  const { issue, state } = sites.get(SITE);
  await reconcileSite(gh, { site: SITE, issue, siteState: state, findings: [], run: { conclusive: allConclusive, observed: new Set(['content:https://evil.example/x.js|abc']) }, now: day(1), links: {}, diffs: new Map() });
  assert.equal(issuesFor(gh)[0].state, 'closed');
  assert.ok(!issuesFor(gh)[0].body.includes('Not seen since'));
});

test('a High that a deploy accepted, rather than an approval, stays listed until a person closes the issue', async () => {
  const gh = createFakeGitHub();
  const dropped = 'https://shop.example/assets/evil-Zz9Yy8Xx.js';
  const seen = `content:${dropped}|abc`;
  await step(gh, 0, [{ ...f('build-file', dropped, 'high', { seenOn: ['/checkout'] }), observedAs: [seen] }]);
  for (const n of [1, 2]) {
    const { issue, state } = (await readSites(gh)).get(SITE);
    // Day 1 the deploy accepted it; on day 2 it is simply part of the baseline.
    await reconcileSite(gh, { site: SITE, issue, siteState: state, findings: [], run: { conclusive: allConclusive, observed: new Set([seen]), acceptedByDeploy: new Set(n === 1 ? [seen] : []) }, now: day(n), links: {}, diffs: new Map() });
    assert.equal(issuesFor(gh)[0].state, 'open', `day ${n}`);
    assert.match(issuesFor(gh)[0].body, /Accepted with a deploy on 2026-11-25/);
  }
});

test('a subject with a pipe cannot break out of its table cell', async () => {
  const gh = createFakeGitHub();
  await step(gh, 0, [f('new-origin', 'https://evil.example/a.js|[x](https://phish.example)', 'high')]);
  const rows = issuesFor(gh)[0].body.split('\n').filter((l) => l.startsWith('|'));
  for (const row of rows) assert.equal(row.split(/(?<!\\)\|/).length - 2, 5, row);
});

test('hundreds of long findings still fit in one issue, which can be rewritten next run', async () => {
  const gh = createFakeGitHub();
  const many = Array.from({ length: 400 }, (_, i) => f('new-destination', `https://host-${i}.example/${'p'.repeat(250)}`, i % 3 ? 'medium' : 'high', { reasons: ['x'.repeat(400), 'y'.repeat(400)] }));
  await step(gh, 0, many);
  const [issue] = issuesFor(gh);
  assert.ok(issue.body.length <= 65536, String(issue.body.length));
  assert.match(issue.body, /and \d+ more/);
  assert.ok(readMarker(issue.body, 'site'), 'the state is still readable');
  await step(gh, 1, many);
  assert.ok(issuesFor(gh)[0].body.length <= 65536);
});
