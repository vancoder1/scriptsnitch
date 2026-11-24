import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOptions, OptionsError, MODES, stepSecrets } from '../../src/options.js';

const base = (inputs = {}) => ({ GITHUB_WORKSPACE: '/work', GITHUB_REPOSITORY: 'acme/shop', ...Object.fromEntries(Object.entries(inputs).map(([k, v]) => [`INPUT_${k.toUpperCase()}`, v])) });

test('mode is required', () => {
  assert.throws(() => readOptions(base()), (e) => e instanceof OptionsError && /mode input is required/.test(e.message));
  assert.throws(() => readOptions(base({ mode: '  ' })), OptionsError);
});

test('unknown mode fails with the list of modes', () => {
  assert.throws(() => readOptions(base({ mode: 'scan' })), (e) => MODES.every((m) => e.message.includes(m)));
});

test('collect mode drops the token input from the environment', () => {
  for (const mode of ['collect', 'validate']) {
    const env = base({ mode, 'github-token': 'ghs_secret' });
    env.GITHUB_TOKEN = 'ghs_other';
    const o = readOptions(env);
    assert.equal(o.token, null);
    assert.equal('INPUT_GITHUB-TOKEN' in env, false);
    assert.equal('GITHUB_TOKEN' in env, false);
  }
  const report = readOptions(base({ mode: 'report', 'github-token': 'ghs_secret' }));
  assert.equal(report.token, 'ghs_secret');
});

test('boolean inputs accept true/false only', () => {
  assert.equal(readOptions(base({ mode: 'report', 'dry-run': 'true' })).dryRun, true);
  assert.equal(readOptions(base({ mode: 'report', 'dry-run': 'FALSE' })).dryRun, false);
  assert.equal(readOptions(base({ mode: 'report', 'dry-run': '' })).dryRun, false);
  assert.throws(() => readOptions(base({ mode: 'report', 'dry-run': 'yes' })), /dry-run must be true or false/);
  assert.throws(() => readOptions(base({ mode: 'collect', drill: '1' })), /drill must be true or false/);
});

test('choices, paths and jitter are checked and resolved against the workspace', () => {
  const o = readOptions(base({ mode: 'report', config: 'site/sn.json', out: 'out', 'fail-on': 'high', propose: 'issue', jitter: '15' }));
  assert.equal(o.configPath.replace(/\\/g, '/').replace(/^[A-Z]:/i, ''), '/work/site/sn.json');
  assert.equal(o.outDir.replace(/\\/g, '/').replace(/^[A-Z]:/i, ''), '/work/out');
  assert.deepEqual([o.failOn, o.propose, o.jitter], ['high', 'issue', 15]);
  assert.throws(() => readOptions(base({ mode: 'report', 'fail-on': 'low' })), /fail-on/);
  assert.throws(() => readOptions(base({ mode: 'collect', jitter: '-3' })), /jitter/);
  assert.throws(() => readOptions(base({ mode: 'collect', jitter: '90' })), /jitter/);
});

test('step secrets arrive as one JSON object and become environment variables for the steps', () => {
  assert.deepEqual(stepSecrets({ SCRIPTSNITCH_STEP_SECRETS: '{"SHOP_USER":"demo","SHOP_PASS":"p@ss"}' }), { SHOP_USER: 'demo', SHOP_PASS: 'p@ss' });
  assert.deepEqual(stepSecrets({}), {});
  assert.throws(() => stepSecrets({ SCRIPTSNITCH_STEP_SECRETS: '["x"]' }), /JSON object of strings/);
  assert.throws(() => stepSecrets({ SCRIPTSNITCH_STEP_SECRETS: '{"A":1}' }), /JSON object of strings/);
});
