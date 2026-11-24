import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { evidencePack, approvalHistoryFromGit, historyFromVersions } from '../../src/modes/evidence.js';
import { SITE, entry, approved } from '../helpers/snapshots.js';
import { emptyStatusState } from '../../src/state.js';

const appr = approved({
  scripts: [
    entry({ id: 'jquery', match: 'https://cdn.example/jquery@3.7.1/jquery.min.js', trust: 'exact', sha256: ['a'.repeat(64)], reason: 'Gallery' }),
    entry({ id: 'chat', match: 'https://chat.example/w.js', trust: 'origin', reason: 'Support chat' }),
    entry({ id: 'build', match: `${SITE}/assets/*-{token}.js`, trust: 'deploy', pages: ['**', '/checkout'], reason: 'Our app' }),
    entry({ id: 'inline-checkout', match: 'inline', trust: 'exact', template: ['b'.repeat(64)], pages: ['/checkout'], reason: 'Sets up the form' }),
  ],
  destinations: [{ match: 'POST https://pay.example/charge', receives: ['card'], pages: ['/checkout'], reason: 'Card gateway', approved: '2026-11-01' }],
  frames: [{ match: 'https://js.pay.example', fields: ['card'], pages: ['/checkout'], reason: 'Card fields', approved: '2026-11-01' }],
  fields: [{ frame: 'top', form: 'POST /login', field: 'password', kind: 'password', pages: ['/login'], reason: 'Sign-in', approved: '2026-11-01' }],
  allow: [{ what: 'peer-connection', pages: ['/support'], reason: 'Video help', approved: '2026-11-01' }],
  headers: { '**': { 'strict-transport-security': 'max-age=31536000' } },
  pending: [{ finding: 'new-origin|https://evil.example/x.js|*', severity: 'high', into: 'scripts', entry: { id: 'evil', match: 'https://evil.example/x.js', trust: 'origin', pages: ['/checkout'], reason: 'TODO: why does this page need it?', approved: '2026-11-24' } }],
});
const status = () => {
  const s = emptyStatusState();
  s.log = [['2026-10-01', 4, 0, 0, null], ['2026-10-02', 4, 0, 1, null], ['2026-11-01', 4, 1, 0, 'pass'], ['2026-11-09', 3, 0, 0, 'fail'], ['2026-11-24', 4, 0, 0, null]];
  return s;
};
const pack = (extra = {}) => evidencePack({ approved: appr, approvalHistory: [], statusState: status(), since: '2026-09-01', until: '2026-11-30', generatedAt: '2026-11-30', ...extra });

test('lists every live entry with its reason and integrity method', () => {
  const md = pack();
  for (const text of ['jquery', 'Gallery', 'Support chat', 'Our app', 'Sets up the form', 'Card gateway', 'Card fields', 'Sign-in', 'Video help', 'strict-transport-security']) assert.ok(md.includes(text), text);
  assert.match(md, /jquery[^\n]*exact[^\n]*SHA-256/);
  assert.match(md, /chat[^\n]*origin[^\n]*vendor/);
  assert.match(md, /build[^\n]*deploy[^\n]*release/);
  assert.match(md, /inline-checkout[^\n]*template/);
  assert.match(md, /Not approved[\s\S]*evil\.example/);
  assert.ok(!/\| [^|]*https:\/\/chat\.example/.test(md.replace(/`[^`]*`/g, '')), 'URLs are in code spans');
});

test('attributes approvals to commits from a fixture history', () => {
  const version = (scripts, destinations = [], pending = []) => JSON.stringify({ version: 1, sites: { [SITE]: { scripts, destinations, pending } } });
  const evil = { id: 'evil', match: 'https://evil.example/x.js' };
  const history = historyFromVersions([
    { commit: '9f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c', author: 'Alex Doe', date: '2026-11-02T10:00:00+00:00', subject: 'Approve the flagged script', text: version([{ id: 'jquery' }, evil], [{ match: 'https://api.example' }]) },
    { commit: '2222222222222222222222222222222222222222', author: 'Sam Roe', date: '2026-10-15T09:00:00+00:00', subject: 'Propose', text: version([{ id: 'jquery' }, { id: 'old-widget' }], [], [{ finding: 'k', entry: evil }]) },
    { commit: '1111111111111111111111111111111111111111', author: 'Sam Roe', date: '2026-10-01T09:00:00+00:00', subject: 'First inventory', text: version([{ id: 'jquery' }, { id: 'old-widget' }]) },
  ]);
  assert.deepEqual(history.map((h) => [h.commit.slice(0, 7), h.author, h.date, h.added, h.removed]), [
    ['9f1c2d3', 'Alex Doe', '2026-11-02', ['evil', 'destinations: https://api.example'], ['old-widget']],
    ['2222222', 'Sam Roe', '2026-10-15', [], []],
    ['1111111', 'Sam Roe', '2026-10-01', ['jquery', 'old-widget'], []],
  ], 'moving a pending item into the live file is an approval; pending items are not');
  const md = pack({ approvalHistory: history });
  assert.match(md, /2026-11-02[^\n]*9f1c2d3[^\n]*Alex Doe[^\n]*evil/);
  assert.match(md, /removed[^\n]*old-widget/);
});

test('reads the approval history from git', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'scriptsnitch-git-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Alex Doe', '-c', 'user.email=alex@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
  git('init', '-q');
  const file = (ids) => JSON.stringify({ version: 1, sites: { [SITE]: { scripts: ids.map((id) => ({ id })) } } }, null, 2);
  writeFileSync(join(dir, 'approved.json'), file(['first']));
  git('add', '.');
  git('commit', '-q', '-m', 'one');
  writeFileSync(join(dir, 'approved.json'), file(['first', 'second']));
  git('commit', '-q', '-am', 'two');
  const history = await approvalHistoryFromGit('approved.json', { cwd: dir });
  assert.deepEqual(history.map((h) => [h.author, h.added]), [['Alex Doe', ['second']], ['Alex Doe', ['first']]]);
});

test('says how far back the run log reaches', () => {
  const md = pack();
  assert.match(md, /goes back to 2026-10-01/);
  assert.match(md, /\| 2026-11-09 \| 3 \| 0 \| 0 \| fail \|/);
  assert.match(md, /5 runs/);
  assert.match(md, /longest gap between two runs was 30 days/i);
  assert.ok(!pack({ since: '2026-11-05' }).includes('| 2026-10-02 |'), 'runs outside the range are left out');
});

test('includes drill results and the not-certification sentence', () => {
  const md = pack();
  assert.match(md, /2026-11-01[^\n]*passed/);
  assert.match(md, /2026-11-09[^\n]*failed/);
  assert.match(md, /supports[^\n]*does not certify compliance/i);
  assert.match(md, /6\.4\.3/);
  assert.match(md, /11\.6\.1/);
});

test('the CLI evidence command writes the pack into the out directory', async (t) => {
  const { runCli } = await import('../../src/cli.js');
  const dir = mkdtempSync(join(tmpdir(), 'scriptsnitch-ev-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { mkdirSync, readFileSync } = await import('node:fs');
  mkdirSync(join(dir, 'scriptsnitch'));
  writeFileSync(join(dir, 'scriptsnitch', 'config.json'), JSON.stringify({ pages: [{ name: 'Home', url: `${SITE}/` }] }));
  writeFileSync(join(dir, 'scriptsnitch', 'approved.json'), JSON.stringify(appr));
  const out = [];
  const code = await runCli(['evidence', '--since', '2026-01-01', '--until', '2026-11-30'], { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) }, env: {}, cwd: dir });
  assert.equal(code, 0, out.join(''));
  assert.match(readFileSync(join(dir, 'scriptsnitch-out', 'evidence-2026-11-30.md'), 'utf8'), /Support chat/);
  assert.equal(await runCli(['evidence', '--since', 'last week'], { stdout: { write: () => {} }, stderr: { write: () => {} }, env: {}, cwd: dir }), 3);
});
