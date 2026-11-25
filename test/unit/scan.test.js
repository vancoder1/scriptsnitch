import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onePerPath, uniqueNames } from '../../src/modes/scan.js';
import { parseConfig } from '../../src/config/config.js';

test('init keeps one page per path, the first one found', () => {
  assert.deepEqual(onePerPath(['https://shop.example/login', 'https://shop.example/login?next=/account', 'https://shop.example/', 'https://other.example/login']), ['https://shop.example/login', 'https://shop.example/', 'https://other.example/login']);
});

test('init gives pages that share a title names of their own, so the config it writes loads', () => {
  const pages = uniqueNames([
    { name: 'Shop', url: 'https://shop.example/' },
    { name: 'Shop', url: 'https://shop.example/login' },
    { name: 'Shop', url: 'https://shop.example/checkout' },
  ]);
  assert.deepEqual(pages.map((p) => p.name), ['Shop', 'Shop (/login)', 'Shop (/checkout)']);
  assert.doesNotThrow(() => parseConfig(JSON.stringify({ pages }), 'config.json'));
});
