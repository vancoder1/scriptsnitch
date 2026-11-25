import { test } from 'node:test';
import assert from 'node:assert/strict';
import { syncApprovalPr } from '../../src/report/pr.js';
import { parseApproved } from '../../src/config/approved.js';
import { writeMarker } from '../../src/report/markers.js';
import { HttpError } from '../../src/report/github.js';
import { createFakeGitHub } from '../helpers/fake-github.js';

const SITE = 'https://shop.example';
const PATH = 'scriptsnitch/approved.json';
const BRANCH = 'scriptsnitch/approve-shop.example';
const TODO = 'TODO: why does this page need it?';
const mine = { id: 'mine', match: 'https://cdn.example/lib@1.0.0/lib.js', trust: 'exact', sha256: ['a'.repeat(64)], pages: ['**'], reason: 'Our gallery', approved: '2026-11-01' };
const baseFile = (eol = '\n') => JSON.stringify({ version: 1, sites: { [SITE]: { scripts: [mine] } } }, null, 2).replace(/\n/g, eol);
const routine = (name) => ({ site: SITE, finding: `new-slot|https://chat.example/${name}.js|*`, severity: 'medium', section: 'scripts', mode: 'routine', entry: { id: `chat-${name}`, match: `https://chat.example/${name}.js`, trust: 'origin', pages: ['**'], behavior: { hosts: [], listens: [], input: false, eval: false, obfuscation: 'minified' }, reason: TODO, approved: '2026-11-24' } });
const pending = { site: SITE, finding: 'new-origin|https://evil.example/x.js|*', severity: 'high', section: 'scripts', mode: 'pending', entry: { id: 'evil-example-x-js', match: 'https://evil.example/x.js', trust: 'origin', pages: ['/checkout'], reason: TODO, approved: '2026-11-24' } };
const sync = (gh, proposals, extra = {}) => syncApprovalPr(gh, { site: SITE, proposals, approvedPath: PATH, base: 'main', botLogin: 'github-actions[bot]', propose: 'pr', ...extra });
const branchFile = (gh, branch = BRANCH) => parseApproved(gh.file(PATH, branch), PATH).sites[SITE];
const fresh = () => createFakeGitHub({ contents: { main: { [PATH]: baseFile() } } });

test('opens a PR with routine entries live and High ones in pending', async () => {
  const gh = fresh();
  const r = await sync(gh, [routine('a'), pending]);
  assert.ok(r.prNumber);
  const pr = gh.state.pulls.find((p) => p.number === r.prNumber);
  assert.equal(pr.head.ref, BRANCH);
  assert.equal(pr.base.ref, 'main');
  const file = branchFile(gh);
  assert.deepEqual(file.scripts.map((e) => e.id), ['chat-a', 'mine']);
  assert.deepEqual(file.pending.map((p) => p.finding), [pending.finding]);
  const visible = pr.body.replace(/^<!--[\s\S]*?-->\n/, '');
  assert.ok(visible.indexOf('evil.example') < visible.indexOf('chat.example'), 'pending (High) listed first');
  assert.match(pr.body, /merging .*does not approve/i);
  assert.equal(gh.file(PATH, 'main'), baseFile(), 'main is untouched');
});

test('adds commits for new findings while the branch is bot-only', async () => {
  const gh = fresh();
  const first = await sync(gh, [routine('a')]);
  const second = await sync(gh, [routine('a'), routine('b')]);
  assert.equal(second.prNumber, first.prNumber);
  assert.equal(gh.state.pulls.length, 1);
  assert.deepEqual(branchFile(gh).scripts.map((e) => e.id), ['chat-a', 'chat-b', 'mine']);
  assert.match(gh.state.pulls[0].body, /chat\.example\/b\.js/);
});

test('stops touching the branch after a person pushes and comments once', async () => {
  const gh = fresh();
  const { prNumber } = await sync(gh, [routine('a')]);
  const edited = gh.file(PATH, BRANCH).replace(TODO, 'Chat widget for support');
  gh.commitFile(PATH, edited, { branch: BRANCH, author: 'octocat' });
  await sync(gh, [routine('a'), routine('b')]);
  await sync(gh, [routine('a'), routine('b')]);
  assert.equal(gh.file(PATH, BRANCH), edited, "the person's commit is the branch's last");
  const comments = gh.state.comments[prNumber] ?? [];
  assert.equal(comments.length, 1);
  assert.match(comments[0].body, /chat\.example\/b\.js/);
  assert.match(comments[0].body, /next one/);
});

test('never force-pushes', async () => {
  const gh = fresh();
  await sync(gh, [routine('a')]);
  gh.commitFile('README.md', 'hello', { branch: 'main' });
  await sync(gh, [routine('a'), routine('b')]);
  gh.commitFile(PATH, gh.file(PATH, BRANCH), { branch: BRANCH, author: 'octocat' });
  await sync(gh, [routine('a'), routine('c')]);
  assert.deepEqual(gh.calls.filter((c) => c.name === 'updateRef'), []);
  assert.ok(gh.calls.some((c) => c.name === 'updateBranch'), 'a branch behind main is updated through the merge API');
});

test('closes when its findings are gone', async () => {
  const gh = fresh();
  const { prNumber } = await sync(gh, [routine('a')]);
  const r = await sync(gh, []);
  assert.equal(r.prNumber, null);
  assert.equal(gh.state.pulls.find((p) => p.number === prNumber).state, 'closed');
  const again = await sync(gh, [routine('b')]);
  assert.notEqual(again.prNumber, prNumber);
  assert.deepEqual(branchFile(gh).scripts.map((e) => e.id), ['chat-b', 'mine'], 'a bot-only branch is started again from main');
});

test('falls back to the issue on the 403', async () => {
  const gh = fresh();
  gh.fail('createPull', new HttpError('POST', 'pulls', 403, '{"message":"GitHub Actions is not permitted to create or approve pull requests."}'));
  const r = await sync(gh, [routine('a'), pending]);
  assert.deepEqual([r.prNumber, r.fallback], [null, 'issue']);
  assert.match(r.edits, /chat\.example\/a\.js/);
  assert.match(r.edits, /Allow GitHub Actions to create and approve pull requests/);
});

test('propose issue opens no PR', async () => {
  const gh = fresh();
  const r = await sync(gh, [routine('a')], { propose: 'issue' });
  assert.deepEqual([r.prNumber, r.fallback], [null, 'issue']);
  assert.match(r.edits, /chat\.example\/a\.js/);
  assert.deepEqual(gh.calls.filter((c) => ['createPull', 'createRef', 'putContent'].includes(c.name)), []);
});

test("an approved.json edited with CRLF is rewritten without losing the person's entries", async () => {
  const gh = createFakeGitHub({ contents: { main: { [PATH]: `﻿${baseFile('\r\n')}` } } });
  await sync(gh, [routine('a')]);
  const text = gh.file(PATH, BRANCH);
  assert.ok(!text.includes('\r'));
  assert.deepEqual(branchFile(gh).scripts.map((e) => e.id), ['chat-a', 'mine']);
  assert.equal(branchFile(gh).scripts.find((e) => e.id === 'mine').reason, 'Our gallery');
});

test('a site with no approved file yet gets one', async () => {
  const gh = createFakeGitHub();
  await sync(gh, [routine('a')]);
  assert.deepEqual(branchFile(gh).scripts.map((e) => e.id), ['chat-a']);
});

test('finding keys and URLs with pipes stay in their table cells', async () => {
  const gh = fresh();
  const match = 'https://evil.example/a.js|[x](https://phish.example)';
  const evil = { ...pending, finding: `new-origin|${match}|*`, entry: { ...pending.entry, id: 'evil-a', match } };
  const r = await sync(gh, [routine('a'), evil]);
  const rows = gh.state.pulls.find((p) => p.number === r.prNumber).body.split('\n').filter((l) => l.startsWith('|'));
  assert.ok(rows.length >= 4);
  for (const row of rows) assert.equal(row.split(/(?<!\\)\|/).length - 2, 3, row);
});

// A pull request anyone could open: scriptsnitch's marker, from a fork or on a branch of another name.
const lookalike = (number, ref, fullName) => ({ number, title: 'scriptsnitch: approve changes on shop.example', body: writeMarker('Looks like ours', 'pr', { v: 1, site: SITE, keys: [], deferred: [] }), state: 'open', merged: false, head: { ref, repo: { full_name: fullName } }, base: { ref: 'main', repo: { full_name: 'acme/repo' } }, user: { login: 'mallory', type: 'User' } });

test('a pull request from a fork, or on another branch, is never taken for the approval pull request', async () => {
  const gh = fresh();
  gh.state.pulls.push(lookalike(90, 'main', 'mallory/repo'), lookalike(91, 'feature/x', 'acme/repo'));
  const r = await sync(gh, [routine('a')]);
  assert.equal(gh.file(PATH, 'main'), baseFile(), 'nothing is written to the default branch');
  assert.ok(![90, 91].includes(r.prNumber));
  assert.equal(gh.state.pulls.find((p) => p.number === r.prNumber).head.ref, BRANCH);
  assert.deepEqual(branchFile(gh).scripts.map((e) => e.id), ['chat-a', 'mine']);
  assert.equal((gh.state.comments[90] ?? []).length + (gh.state.comments[91] ?? []).length, 0);
});

test("commits made with a GitHub App token are the bot's, not a person's", async () => {
  const gh = createFakeGitHub({ botLogin: 'shop-scriptsnitch[bot]', contents: { main: { [PATH]: baseFile() } } });
  const { prNumber } = await sync(gh, [routine('a')]);
  await sync(gh, [routine('a'), routine('b')]);
  assert.deepEqual(branchFile(gh).scripts.map((e) => e.id), ['chat-a', 'chat-b', 'mine']);
  assert.deepEqual(gh.state.comments[prNumber] ?? [], []);
});

test("a commit with no linked account counts as a person's", async () => {
  const gh = fresh();
  await sync(gh, [routine('a')]);
  const edited = gh.file(PATH, BRANCH).replace(TODO, 'Chat widget for support');
  gh.commitFile(PATH, edited, { branch: BRANCH, author: null });
  await sync(gh, [routine('a'), routine('b')]);
  assert.equal(gh.file(PATH, BRANCH), edited);
});
