import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { loadConfig } from '../../src/config/config.js';

const files = [...readdirSync('.github/workflows').map((f) => `.github/workflows/${f}`), ...readdirSync('examples').filter((f) => f.endsWith('.yml')).map((f) => `examples/${f}`)];

test('every external action is pinned to a commit, except scriptsnitch itself in the examples', () => {
  for (const file of files) {
    for (const [, ref] of readFileSync(file, 'utf8').matchAll(/^(?!\s*#)[^\n]*?uses:\s*([^\s#]+)/gm)) {
      if (ref.startsWith('./')) continue;
      if (file.startsWith('examples/') && /^vancoder1\/scriptsnitch(\/\.github\/workflows\/scriptsnitch\.yml)?@v1$/.test(ref)) continue;
      assert.match(ref, /@[0-9a-f]{40}$/, `${file}: ${ref}`);
    }
  }
});

test('the example config loads', () => {
  assert.equal(loadConfig('examples/config.json').pages.length, 3);
});

test('action.yml declares exactly the inputs the action reads', () => {
  const declared = [...readFileSync('action.yml', 'utf8').split('outputs:')[0].matchAll(/^ {2}([a-z-]+):$/gm)].map((m) => m[1]).sort();
  const read = [...new Set([...readFileSync('src/options.js', 'utf8').matchAll(/(?:input|bool|choice)\('([a-z-]+)'/g)].map((m) => m[1]))].sort();
  assert.deepEqual(declared, read);
});
