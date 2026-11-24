import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previousEvidence } from '../../src/report/artifacts.js';
import { createFakeGitHub } from '../helpers/fake-github.js';
import { writeZip } from '../helpers/zip-writer.js';

const H = 'a'.repeat(64);
const zip = (source) => writeZip([
  { name: 'snapshot.json', data: JSON.stringify({ evidence: { [H]: { file: `evidence/${H}.js`, url: 'https://shop.example/js/app.js', bytes: source.length } } }), deflate: true },
  { name: `evidence/${H}.js`, data: source, deflate: true },
]);
const run = (id, conclusion = 'success') => ({ id, workflowFile: 'scriptsnitch.yml', status: 'completed', conclusion, created_at: `2026-11-${10 + id}T06:00:00Z` });

test("reads the previous run's evidence from its zip artifact", async () => {
  const gh = createFakeGitHub({
    runs: [run(10), run(11, 'failure'), run(12)],
    artifacts: { 10: [{ id: 500, name: 'scriptsnitch', expired: false }], 11: [{ id: 501, name: 'scriptsnitch', expired: false }] },
    blobs: { 500: zip('old old'), 501: zip('window.app = 1;') },
  });
  const prev = await previousEvidence(gh, { workflowFile: 'scriptsnitch.yml', currentRunId: 12 });
  assert.equal(prev.runId, 11, 'the latest earlier run, even one that failed on a finding');
  assert.equal(prev.files.get(H).toString(), 'window.app = 1;');
  assert.equal(prev.urls.get('https://shop.example/js/app.js'), H);
});

test('returns nothing when there is no earlier run or its artifact expired', async () => {
  const none = await previousEvidence(createFakeGitHub({ runs: [run(12)] }), { workflowFile: 'scriptsnitch.yml', currentRunId: 12 });
  assert.equal(none.files.size, 0);
  const expired = createFakeGitHub({ runs: [run(10), run(12)], artifacts: { 10: [{ id: 500, name: 'scriptsnitch', expired: true }] }, blobs: { 500: zip('stale') } });
  const r = await previousEvidence(expired, { workflowFile: 'scriptsnitch.yml', currentRunId: 12 });
  assert.equal(r.files.size, 0);
  assert.equal(r.runId, null);
  const broken = createFakeGitHub({ runs: [run(10), run(12)], artifacts: { 10: [{ id: 500, name: 'scriptsnitch', expired: false }] }, blobs: { 500: Buffer.from('not a zip') } });
  const b = await previousEvidence(broken, { workflowFile: 'scriptsnitch.yml', currentRunId: 12 });
  assert.equal(b.files.size, 0);
  assert.match(b.note, /zip/);
});
