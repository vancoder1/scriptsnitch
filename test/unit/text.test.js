import { test } from 'node:test';
import assert from 'node:assert/strict';
import { md, neutralize, fence, code, cellCode } from '../../src/report/text.js';

const ZWJ = '‍';

test('md escapes table pipes and HTML', () => {
  const out = md('a|b <script>alert(1)</script> & [x](y) *z*');
  assert.equal(out.includes('|'), out.includes('\\|'));
  assert.ok(!/<script>/.test(out));
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /&amp;/);
  assert.match(out, /\\\[x\\\]/);
  assert.equal(md('line one\nline two'), 'line one line two', 'one line, so a table row stays one row');
});

test('neutralize stops @mentions and autolinks', () => {
  const out = neutralize('ping @octocat and @acme/team, see https://evil.example/x, www.evil.example and #12');
  assert.ok(!/@octocat/.test(out) && out.includes(`@${ZWJ}octocat`));
  assert.ok(out.includes(`@${ZWJ}acme/team`));
  assert.ok(!/https:\/\/evil/.test(out));
  assert.match(out, /https\[:\]\/\/evil\.example\/x/);
  assert.match(out, /www\[\.\]evil\.example/);
  assert.ok(out.includes(`#${ZWJ}12`));
  assert.equal(neutralize('mail me at a@b.example'), 'mail me at a@b.example', 'an @ inside a word is not a mention');
});

test('md also neutralizes', () => {
  assert.ok(md('@octocat').includes(`@${ZWJ}octocat`));
});

test('fence survives a script containing triple backticks', () => {
  const src = 'var a = "```"; var b = "````";';
  const out = fence(src, 'js');
  assert.ok(out.startsWith('`````js\n'));
  assert.ok(out.endsWith('\n`````'));
  assert.ok(out.includes(src));
  assert.equal(fence('plain'), '```\nplain\n```');
});

test('code wraps inline text in a span that backticks inside cannot close', () => {
  assert.equal(code('a`b'), '`` a`b ``');
  assert.equal(code('x'), '`x`');
});

test('cellCode escapes every pipe, so text in a table cell cannot split it', () => {
  // GitHub never splits a table cell at a pipe with a backslash before it.
  const out = cellCode('https://evil.example/a.js|[x](https://phish.example)\\|');
  assert.ok(!/(?<!\\)\|/.test(out), out);
  assert.equal(cellCode('x'), '`x`');
  // A backslash already before a pipe must not leave the escape open to a parser that pairs them.
  assert.ok(!/\\\\\|/.test(cellCode('https://evil.example/a.js?q=\\|[x](https://phish.example)')));
});

test('neutralize stops every mention and reference GitHub would make, and leaves e-mail addresses', () => {
  assert.equal(neutralize('.@octocat'), `.@${ZWJ}octocat`);
  assert.equal(neutralize('@@octocat'), `@@${ZWJ}octocat`);
  assert.equal(neutralize('see torvalds/linux#1'), `see torvalds/linux#${ZWJ}1`);
  assert.equal(neutralize('item#12'), `item#${ZWJ}12`);
  assert.equal(neutralize('GH-12 and gh-3'), `GH${ZWJ}-12 and gh${ZWJ}-3`);
  assert.equal(neutralize('a@b.example'), 'a@b.example');
  assert.equal(neutralize('&#38;'), '&#38;', 'an HTML entity is not a reference');
});
