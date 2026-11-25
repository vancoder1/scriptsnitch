import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probeValues, luhnValid, encodings, findValues, growthFields, ibanValid } from '../../src/analyze/probe-match.js';

const seeded = (seed) => () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

test('probe card numbers pass Luhn and use common card prefixes', () => {
  for (let i = 1; i < 50; i++) {
    const v = probeValues(seeded(i), { now: Date.UTC(2026, 10, 24) });
    assert.match(v.card, /^\d{16}$/);
    assert.equal(luhnValid(v.card), true);
    assert.match(v.card, /^(4|5[1-5]|2(2[2-9]|[3-6]\d|7[01]|720))/);
    const [mm, yy] = v.expiry.split('/').map(Number);
    assert.ok(mm >= 1 && mm <= 12 && 2000 + yy > 2026, v.expiry);
    assert.match(v.cvc, /^\d{3}$/);
    assert.equal(ibanValid(v.iban), true, v.iban);
  }
});

test('probe values are fresh every run', () => {
  const a = probeValues(seeded(1));
  const b = probeValues(seeded(2));
  assert.notEqual(a.card, b.card);
  assert.notEqual(a.email, b.email);
  assert.notEqual(a.password, b.password);
});

test('a length boost makes text values much longer, for the second probe', () => {
  const a = probeValues(seeded(3));
  const b = probeValues(seeded(3), { lengthBoost: 37 });
  assert.ok(b.name.length - a.name.length >= 37);
  assert.ok(b.email.length - a.email.length >= 37);
});

test('luhnValid', () => {
  assert.equal(luhnValid('4242424242424242'), true);
  assert.equal(luhnValid('4242424242424241'), false);
});

test('finds a value base64-encoded at an odd offset inside a larger payload', () => {
  const card = '4111111111111111';
  const payload = Buffer.from(`{"x":1,"c":"${card}","t":9}`).toString('base64');
  assert.deepEqual(findValues(`data=${payload}`, { card }), [{ kind: 'card', encoding: 'base64' }]);
});

test('finds values URL-encoded twice, as JSON escapes, as hex and with spaces', () => {
  const email = 'jane.doe42@mail.test';
  assert.deepEqual(findValues(encodeURIComponent(encodeURIComponent(email)), { email }), [{ kind: 'email', encoding: 'url-encoded twice' }]);
  const escaped = [...email].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  assert.deepEqual(findValues(escaped, { email }), [{ kind: 'email', encoding: 'json-escaped' }]);
  assert.deepEqual(findValues(Buffer.from(email).toString('hex').toUpperCase(), { email }), [{ kind: 'email', encoding: 'hex' }]);
  assert.deepEqual(findValues('n=4111 1111 1111 1111', { card: '4111111111111111' }), [{ kind: 'card', encoding: 'spaced' }]);
});

test('short values such as the security code are not searched on their own', () => {
  assert.deepEqual(findValues('a=123&b=12/34', { cvc: '123', expiry: '12/34' }), []);
});

test('growthFields flags a request field whose size grows with the input', () => {
  const before = [{ method: 'POST', url: 'https://evil.example/c?t=1', body: `d=${'A'.repeat(64)}&n=1` }];
  const after = [{ method: 'POST', url: 'https://evil.example/c?t=2', body: `d=${'B'.repeat(112)}&n=2` }];
  assert.deepEqual(growthFields(before, after, 48), [{ url: 'https://evil.example/c', field: 'd' }]);
  assert.deepEqual(growthFields(before, [{ method: 'POST', url: 'https://evil.example/c', body: `d=${'B'.repeat(66)}&n=2` }], 48), []);
  // Exactly three quarters of the extra input is enough.
  assert.deepEqual(growthFields(before, [{ method: 'POST', url: 'https://evil.example/c', body: `d=${'B'.repeat(100)}&n=2` }], 48), [{ url: 'https://evil.example/c', field: 'd' }]);
});

test('ibanValid checks the checksum, not only the shape', () => {
  assert.equal(ibanValid('DE89 3704 0044 0532 0130 00'), true);
  assert.equal(ibanValid('DE89 3704 0044 0532 0130 01'), false);
});

test('finds a value base64-encoded at every byte offset of a larger payload', () => {
  // Not a run of repeated digits: a repeating value matches even a misaligned slice.
  const card = '4929731562840417';
  for (const prefix of ['c=', 'cc=', 'ccc=']) {
    assert.deepEqual(findValues(Buffer.from(`${prefix}${card}&t=9`).toString('base64'), { card }), [{ kind: 'card', encoding: 'base64' }], prefix);
  }
});

test('a six-character value is searched, base64-encoded too', () => {
  const password = 'Pw9!xQ';
  assert.deepEqual(findValues(Buffer.from(`{"p":"${password}"}`).toString('base64'), { password }), [{ kind: 'password', encoding: 'base64' }]);
});

test('finds a value URL-encoded once', () => {
  const email = 'jane.doe+42@mail.test';
  assert.deepEqual(findValues(`e=${encodeURIComponent(email)}`, { email }), [{ kind: 'email', encoding: 'url-encoded' }]);
});

test('only the sensitive kinds are searched for', () => {
  assert.deepEqual(findValues('tel=+1 613 555 0199&a=12 Maple Street', { phone: '+1 613 555 0199', address: '12 Maple Street' }), []);
});

test('growthFields measures JSON fields one by one, and a body that is one JSON string as a whole', () => {
  const at = (before, after) => growthFields([{ method: 'POST', url: 'https://evil.example/c', body: before }], [{ method: 'POST', url: 'https://evil.example/c', body: after }], 48);
  assert.deepEqual(at(JSON.stringify({ d: 'A'.repeat(64), n: 1 }), JSON.stringify({ d: 'B'.repeat(112), n: 2 })), [{ url: 'https://evil.example/c', field: 'd' }]);
  assert.deepEqual(at(JSON.stringify('A'.repeat(64)), JSON.stringify('B'.repeat(112))), [{ url: 'https://evil.example/c', field: '' }]);
});
