import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/main.js';
import { createFakeGitHub } from '../helpers/fake-github.js';
import { SITE, ext, snapshot } from '../helpers/snapshots.js';

function workspace(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ss-main-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'scriptsnitch'));
  writeFileSync(join(dir, 'scriptsnitch', 'config.json'), JSON.stringify({ profiles: ['desktop'], pages: [{ name: 'Home', url: `${SITE}/`, expect: { selector: 'main' } }] }));
  return dir;
}
const quiet = { log: { log: () => {}, error: () => {} } };
const capture = () => { const lines = []; return { lines, log: { log: (s) => lines.push(s), error: (s) => lines.push(s) } }; };

test('validate mode runs without a token and reports issues as annotations', async (t) => {
  const dir = workspace(t);
  writeFileSync(join(dir, 'scriptsnitch', 'approved.json'), JSON.stringify({ version: 1, sites: { [SITE]: { destinations: [{ match: 'https://api.example', reason: 'TODO: why does this page need it?', approved: '2026-11-24' }] } } }));
  const c = capture();
  assert.equal(await main({ GITHUB_WORKSPACE: dir, INPUT_MODE: 'validate', 'INPUT_GITHUB-TOKEN': 'secret' }, c), 1);
  assert.match(c.lines.join('\n'), /::error::.*TODO/);
});

test('an invalid input or config is an error, exit 3', async (t) => {
  const dir = workspace(t);
  assert.equal(await main({ GITHUB_WORKSPACE: dir }, quiet), 3);
  assert.equal(await main({ GITHUB_WORKSPACE: dir, INPUT_MODE: 'report', INPUT_CONFIG: 'missing.json', 'INPUT_GITHUB-TOKEN': 'x', GITHUB_REPOSITORY: 'acme/shop' }, quiet), 3);
});

test('report mode writes the step outputs', async (t) => {
  const dir = workspace(t);
  mkdirSync(join(dir, 'scriptsnitch-out'));
  writeFileSync(join(dir, 'scriptsnitch-out', 'snapshot.json'), JSON.stringify(snapshot([{ path: '/', observed: { scripts: [ext('https://evil.example/x.js')] } }])));
  const out = join(dir, 'out.txt');
  writeFileSync(out, '');
  const gh = createFakeGitHub();
  const env = { GITHUB_WORKSPACE: dir, INPUT_MODE: 'report', 'INPUT_DRY-RUN': 'true', 'INPUT_GITHUB-TOKEN': 'x', GITHUB_REPOSITORY: 'acme/shop', GITHUB_OUTPUT: out, GITHUB_WORKFLOW_REF: 'acme/shop/.github/workflows/scriptsnitch.yml@refs/heads/main' };
  assert.equal(await main(env, { githubFactory: () => gh, ...quiet }), 0);
  assert.match(readFileSync(out, 'utf8'), /^high=1\nmedium=0\ninconclusive=0\n$/);
});

test('collect mode masks step secrets in the log', async (t) => {
  const dir = workspace(t);
  const c = capture();
  const code = await main({ GITHUB_WORKSPACE: dir, INPUT_MODE: 'collect', 'INPUT_CHROME-PATH': join(dir, 'no-chrome'), SCRIPTSNITCH_STEP_SECRETS: '{"SHOP_PASS":"hunter2-long"}' }, c);
  assert.equal(code, 3, 'no Chrome at that path');
  assert.ok(c.lines.includes('::add-mask::hunter2-long'));
});
