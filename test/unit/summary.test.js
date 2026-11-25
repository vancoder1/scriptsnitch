import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSummaryMarkdown } from '../../src/report/summary.js';

const finding = (subject, reasons) => ({ kind: 'new-origin', key: `new-origin|${subject}|*`, severity: 'high', site: 'https://shop.example', page: '*', profiles: ['desktop'], subject, reasons, evidence: [], seenOn: ['/checkout'] });

test('the job summary shows page text as text: no links, mentions, HTML or broken table cells', () => {
  const evil = 'https://evil.example/a.js|[x](https://phish.example)';
  const md = formatSummaryMarkdown({ findings: [finding(evil, ['a script from https://evil.example, ping @octocat <img src=x onerror=alert(1)>'])], held: [], info: [], inconclusive: [{ page: '/x', profile: 'desktop', reason: '<b>hi</b>' }], drill: null, notes: ['see https://evil.example/note'] }, { diffs: [{ subject: '<script>x</script>', full: '```diff\n+x\n```' }] });
  const row = md.split('\n').find((l) => l.startsWith('| high'));
  assert.equal(row.split(/(?<!\\)\|/).length - 2, 5, row);
  const outside = md.replace(/(`+)[\s\S]*?\1/g, '');
  assert.ok(!/https:\/\/(evil|phish)/.test(outside), outside);
  assert.ok(!/(^|[^\w])@octocat/.test(outside));
  assert.ok(!/<img|<b>|<script>/.test(outside));
});
