import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secretValues, redactText, redactDeep } from '../../src/util/redact.js';
import { createEvidenceStore } from '../../src/capture/evidence.js';
import { parseConfig } from '../../src/config/config.js';

const config = parseConfig(JSON.stringify({
  consent: [{ click: '#ok' }, { type: '#code', secret: 'CONSENT_PIN' }],
  pages: [{ name: 'Account', url: 'https://shop.example/account', steps: [{ goto: 'https://shop.example/login' }, { type: '#user', secret: 'SHOP_USER' }, { type: '#otp', totp: 'SHOP_TOTP' }, { type: '#q', value: 'public text' }] }],
}), 'config.json');

test('secret values come from the steps that name them, never short ones', () => {
  const env = { SHOP_USER: 'demo-user-123', SHOP_TOTP: 'JBSWY3DPEHPK3PXP', CONSENT_PIN: '12', OTHER: 'not used' };
  assert.deepEqual(secretValues(config, env), ['JBSWY3DPEHPK3PXP', 'demo-user-123']);
});

test('redacts a secret raw, URL-encoded and JSON-escaped, in text and in every string of an object', () => {
  const values = ['p@ss "w/rd"'];
  assert.equal(redactText('a p@ss "w/rd" b p%40ss%20%22w%2Frd%22 c', values), 'a [redacted] b [redacted] c');
  const obj = { url: 'https://x.example/?u=p%40ss%20%22w%2Frd%22', nested: [{ t: 'p@ss "w/rd"' }], n: 3, keep: 'plain' };
  assert.deepEqual(redactDeep(obj, values), { url: 'https://x.example/?u=[redacted]', nested: [{ t: '[redacted]' }], n: 3, keep: 'plain' });
  assert.equal(redactText('nothing here', []), 'nothing here');
});

test('the evidence store writes redacted copies', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ss-ev-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createEvidenceStore(dir, { secrets: ['demo-user-123'] });
  const e = store.add('a'.repeat(64), 'var u = "demo-user-123";', 'https://shop.example/a.js');
  assert.equal(readFileSync(join(dir, e.file), 'utf8'), 'var u = "[redacted]";');
});

test('hashes are never redacted, so a secret cannot corrupt an identity', () => {
  const hash = 'ab12cd34'.repeat(8);
  assert.deepEqual(redactDeep({ contentHash: hash, sri: 'sha384-ab12cd34xyz', note: 'x ab12cd34 y' }, ['ab12cd34']), { contentHash: hash, sri: 'sha384-ab12cd34xyz', note: 'x [redacted] y' });
  assert.deepEqual(secretValues(config, { SHOP_USER: '20261', SHOP_TOTP: 'JBSWY3DPEHPK3PXP' }), ['JBSWY3DPEHPK3PXP'], 'values under six characters are left alone');
});
