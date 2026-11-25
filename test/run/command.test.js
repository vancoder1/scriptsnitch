import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleComment } from '../../src/modes/command.js';
import { reconcileSite, readSites } from '../../src/report/site-issue.js';
import { syncApprovalPr } from '../../src/report/pr.js';
import { readMarker, writeMarker } from '../../src/report/markers.js';
import { parseApproved, serializeApproved, emptyApproved, addPending } from '../../src/config/approved.js';
import { findingKey } from '../../src/analyze/keys.js';
import { createFakeGitHub } from '../helpers/fake-github.js';

const SITE = 'https://shop.example';
const PATH = 'scriptsnitch/approved.json';
const KEY = findingKey('new-origin', 'https://chat.example/w.js');
const ROUTINE_KEY = findingKey('new-destination', 'https://api.example');
const entry = { id: 'chat-example-w-js', match: 'https://chat.example/w.js', trust: 'origin', pages: ['**'], reason: 'TODO: why does this page need it?', approved: '2026-11-24' };
const pendingProposal = { site: SITE, finding: KEY, severity: 'high', section: 'scripts', mode: 'pending', entry };
const routineProposal = { site: SITE, finding: ROUTINE_KEY, severity: 'medium', section: 'destinations', mode: 'routine', entry: { match: 'https://api.example', pages: ['**'], reason: 'TODO: why does this page need it?', approved: '2026-11-24' } };
const finding = (key, kind, subject, severity) => ({ kind, key, severity, site: SITE, page: '*', profiles: ['desktop'], subject, reasons: ['r'], evidence: [], seenOn: ['/'], firstRun: false, observedAs: [] });

async function setup({ withPr = true, permissions = { octocat: 'write' } } = {}) {
  const gh = createFakeGitHub({ permissions, contents: { main: { [PATH]: serializeApproved(withPr ? emptyApproved() : addPending(emptyApproved(), SITE, { finding: KEY, severity: 'high', into: 'scripts', entry })) } } });
  if (withPr) await syncApprovalPr(gh, { site: SITE, proposals: [pendingProposal, routineProposal], approvedPath: PATH, base: 'main', botLogin: 'github-actions[bot]', propose: 'pr' });
  await reconcileSite(gh, { site: SITE, findings: [finding(KEY, 'new-origin', 'https://chat.example/w.js', 'high'), finding(ROUTINE_KEY, 'new-destination', 'https://api.example', 'medium')], run: { conclusive: new Set(['/|desktop']) }, now: Date.UTC(2026, 10, 24), links: {}, diffs: new Map() });
  const issue = [...(await readSites(gh)).values()][0].issue;
  return { gh, issue };
}
const event = (issue, body, user = { login: 'octocat', type: 'User' }) => ({ action: 'created', issue: { number: issue.number, body: issue.body, labels: issue.labels, ...(issue.pull_request ? { pull_request: issue.pull_request } : {}) }, comment: { id: 1, body, user } });
const handle = (gh, ev) => handleComment({ event: ev, github: gh, approvedPath: PATH, botLogin: 'github-actions[bot]', base: 'main' });
const replies = (gh, issue) => (gh.state.comments[issue.number] ?? []).map((c) => c.body);

test('approves one pending finding with its reason on the approval branch', async () => {
  const { gh, issue } = await setup();
  const r = await handle(gh, event(issue, `/scriptsnitch approve ${KEY} because Our support chat, reviewed by the security team`));
  assert.equal(r.action, 'approved');
  const pr = gh.state.pulls.find((p) => p.state === 'open');
  const file = parseApproved(gh.file(PATH, pr.head.ref), PATH).sites[SITE];
  assert.deepEqual(file.pending, []);
  assert.equal(file.scripts.find((e) => e.id === entry.id).reason, 'Our support chat, reviewed by the security team');
  assert.equal(gh.file(PATH, 'main'), serializeApproved(emptyApproved()), 'nothing is approved until the pull request is merged');
  assert.match(replies(gh, issue).at(-1), new RegExp(`#${pr.number}`));
});

test('approves a pending item that is already on main by opening a pull request', async () => {
  const { gh, issue } = await setup({ withPr: false });
  const r = await handle(gh, event(issue, `/scriptsnitch approve ${KEY} because Checked with the vendor`));
  assert.equal(r.action, 'approved');
  const [pr] = gh.state.pulls;
  assert.equal(pr.state, 'open');
  assert.deepEqual(parseApproved(gh.file(PATH, pr.head.ref), PATH).sites[SITE].pending, []);
  assert.equal(readMarker(pr.body, 'pr').site, SITE, 'a pull request the scheduled runs recognise');
});

test('a routine finding is approved by merging the pull request', async () => {
  const { gh, issue } = await setup();
  const r = await handle(gh, event(issue, `/scriptsnitch approve ${ROUTINE_KEY} because Our API`));
  assert.equal(r.action, 'refused');
  assert.match(r.reply, /merg/i);
});

test('refuses a commenter without write access', async () => {
  const { gh, issue } = await setup({ permissions: { octocat: 'read' } });
  const before = gh.file(PATH, gh.state.pulls[0].head.ref);
  const r = await handle(gh, event(issue, `/scriptsnitch approve ${KEY} because looks fine`));
  assert.equal(r.action, 'refused');
  assert.match(replies(gh, issue).at(-1), /write access/);
  assert.equal(gh.file(PATH, gh.state.pulls[0].head.ref), before);
});

test('ignores bots and other issues', async () => {
  const { gh, issue } = await setup();
  const count = (gh.state.comments[issue.number] ?? []).length;
  assert.equal((await handle(gh, event(issue, `/scriptsnitch approve ${KEY} because x`, { login: 'renovate[bot]', type: 'Bot' }))).action, 'ignored');
  const other = await gh.createIssue({ title: 'Unrelated', body: 'hello', labels: [] });
  assert.equal((await handle(gh, event(other, `/scriptsnitch approve ${KEY} because x`))).action, 'ignored');
  assert.equal((await handle(gh, event({ ...issue, pull_request: { url: 'x' } }, `/scriptsnitch approve ${KEY} because x`))).action, 'ignored');
  assert.equal((await handle(gh, event(issue, 'Thanks, looking into it'))).action, 'ignored');
  assert.equal((await handle(gh, { ...event(issue, `/scriptsnitch mute ${KEY}`), action: 'edited' })).action, 'ignored');
  assert.equal((gh.state.comments[issue.number] ?? []).length, count);
});

test('rejects an unknown key', async () => {
  const { gh, issue } = await setup();
  const r = await handle(gh, event(issue, '/scriptsnitch approve new-origin|https://other.example/x.js|* because x'));
  assert.equal(r.action, 'refused');
  assert.match(replies(gh, issue).at(-1), /not an open finding/);
});

test('requires a reason', async () => {
  const { gh, issue } = await setup();
  for (const body of [`/scriptsnitch approve ${KEY}`, `/scriptsnitch approve ${KEY} because   `, `/scriptsnitch approve ${KEY} because TODO later`]) {
    const r = await handle(gh, event(issue, body));
    assert.equal(r.action, 'refused', body);
    assert.match(r.reply, /because <reason>/);
  }
});

test('mutes one finding', async () => {
  const { gh, issue } = await setup();
  const r = await handle(gh, event(issue, `/scriptsnitch mute ${ROUTINE_KEY}`));
  assert.equal(r.action, 'muted');
  const state = readMarker(gh.state.issues.find((i) => i.number === issue.number).body, 'site');
  assert.equal(state.findings[ROUTINE_KEY].muted, true);
  assert.equal(state.findings[KEY].muted, false);
});

test('never echoes hostile comment text unescaped', async () => {
  const { gh, issue } = await setup();
  await handle(gh, event(issue, '/scriptsnitch approve <img src=x onerror=alert(1)>@everyone|https://x.example|* because @octocat <b>hi</b> https://evil.example'));
  await handle(gh, event(issue, `/scriptsnitch frobnicate @team <script>`));
  for (const reply of replies(gh, issue)) {
    assert.ok(!/<img|<script|<b>/.test(reply), reply);
    assert.ok(!/(^|[^`])@everyone|(^|[^`])@team|https:\/\/evil/.test(reply.replace(/`[^`]*`/g, '')), reply);
  }
});

test('an issue that copies a site marker without the scriptsnitch label is ignored', async () => {
  const { gh, issue } = await setup();
  const fake = await gh.createIssue({ title: 'Please approve', body: issue.body, labels: [] });
  assert.equal((await handle(gh, event(fake, `/scriptsnitch approve ${KEY} because trust me`))).action, 'ignored');
  assert.deepEqual(gh.state.comments[fake.number] ?? [], []);
});

test('an approval by comment never lands on a branch named by a fork pull request', async () => {
  const { gh, issue } = await setup({ withPr: false });
  const base = gh.file(PATH, 'main');
  gh.state.pulls.push({ number: 90, title: 'scriptsnitch: approve changes on shop.example', body: writeMarker('x', 'pr', { v: 1, site: SITE, keys: [], deferred: [] }), state: 'open', merged: false, head: { ref: 'main', repo: { full_name: 'mallory/repo' } }, base: { ref: 'main', repo: { full_name: 'acme/repo' } }, user: { login: 'mallory', type: 'User' } });
  const r = await handle(gh, event(issue, `/scriptsnitch approve ${KEY} because Our support chat`));
  assert.equal(r.action, 'approved');
  assert.equal(gh.file(PATH, 'main'), base, 'the default branch is untouched');
  const pr = gh.state.pulls.find((p) => p.state === 'open' && p.number !== 90);
  assert.match(pr.head.ref, /^scriptsnitch\/approve-/);
});
