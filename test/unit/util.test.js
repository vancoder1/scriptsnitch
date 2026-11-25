import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stableStringify, parseJsonText, JsonSyntaxError } from '../../src/util/json.js';
import { sha256Hex, sha384Base64, short } from '../../src/util/hash.js';
import { totp } from '../../src/util/totp.js';
import { readZip } from '../../src/util/zip.js';
import { isoDate, daysBetween } from '../../src/util/time.js';
import { writeZip } from '../helpers/zip-writer.js';

test('stableStringify sorts keys deeply and ends with a newline', () => {
  assert.equal(stableStringify({ b: 1, a: { d: 1, c: 2 } }), '{\n  "a": {\n    "c": 2,\n    "d": 1\n  },\n  "b": 1\n}\n');
});

test('stableStringify keeps array order', () => {
  assert.equal(stableStringify({ x: [3, 1, 2] }), '{\n  "x": [\n    3,\n    1,\n    2\n  ]\n}\n');
});

test('parseJsonText reports the line and column of a syntax error', () => {
  assert.throws(() => parseJsonText('{\n  "a": 1,\n}', 'config.json'), (e) => e instanceof JsonSyntaxError && e.line === 3 && e.label === 'config.json');
});

test('parseJsonText refuses a key given twice in one object, and names its line', () => {
  // A second "scripts" in a site would silently drop every approval in the first.
  assert.throws(() => parseJsonText('{\r\n  "scripts": [1],\r\n  "scripts": []\r\n}', 'approved.json'), (e) => e instanceof JsonSyntaxError && e.line === 3 && /"scripts" appears twice/.test(e.message));
  assert.deepEqual(parseJsonText('{"a": {"x": 1}, "b": {"x": 2}, "c": [{"x": 1}, {"x": 2}], "d": "\\"a\\": 1, \\"a\\""}', 'x.json').b, { x: 2 }, 'the same key in different objects, or inside a string, is fine');
});

test('parseJsonText accepts a BOM and CRLF line endings', () => {
  assert.deepEqual(parseJsonText('﻿{\r\n"a":1\r\n}', 'x'), { a: 1 });
});

test('sha256Hex and sha384Base64 match known digests', () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha384Base64(Buffer.from('abc')), 'ywB1P0WjXou1oD1pmsZQBycsMqsO3tFjGotgWkP/W+2AhgcroefMI1i67KE0yCWn');
  assert.equal(short('ba7816bf8f01cfea414140de5dae2223'), 'ba7816bf8f01');
});

test('totp matches the RFC 6238 SHA-1 test vectors', () => {
  const rfcSeed = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of "12345678901234567890", RFC 6238 appendix B
  const want = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
  for (const [t, code] of want) assert.equal(totp(rfcSeed, t * 1000, { digits: 8 }), code, `t=${t}`);
});

test('totp defaults to six digits', () => {
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59000), '287082');
});

test('readZip reads stored and deflated entries', () => {
  const zip = writeZip([{ name: 'a.txt', data: 'hello' }, { name: 'evidence/b.js', data: 'x'.repeat(5000), deflate: true }]);
  const files = readZip(zip);
  assert.equal(files.get('a.txt').toString(), 'hello');
  assert.equal(files.get('evidence/b.js').toString(), 'x'.repeat(5000));
});

test('readZip refuses an entry that inflates past its limit', () => {
  // 64 MB of zeros deflate to about 64 KB.
  const bomb = writeZip([{ name: 'evidence/big.js', data: Buffer.alloc(64 * 1024 * 1024), deflate: true }]);
  assert.throws(() => readZip(bomb), /too large/);
  assert.equal(readZip(bomb, { maxEntry: 128 * 1024 * 1024 }).get('evidence/big.js').length, 64 * 1024 * 1024);
});

test('readZip rejects data that is not a zip', () => {
  assert.throws(() => readZip(Buffer.from('not a zip at all')), /not a zip/i);
});

test('isoDate and daysBetween work in UTC', () => {
  assert.equal(isoDate(Date.UTC(2026, 10, 23, 23, 59)), '2026-11-23');
  assert.equal(daysBetween('2026-11-01', '2026-12-01'), 30);
});
