import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub, HttpError } from '../../src/report/github.js';
import { createFakeGitHub } from '../helpers/fake-github.js';

// A fetch stand-in that answers from a list of responses (or errors) and records each request.
function scripted(responses) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    const { status = 200, json = {}, text } = next;
    return new Response(text ?? (status === 204 ? null : JSON.stringify(json)), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, requests };
}
const client = (s) => createGitHub({ token: 't0k', repo: 'acme/shop', fetchImpl: s.fetchImpl, backoff: () => 0 });
const timeout = () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });

test('never retries a POST that timed out', async () => {
  const s = scripted([timeout(), { status: 201, json: { id: 1 } }]);
  await assert.rejects(client(s).createComment(7, 'hello'), /timeout/);
  assert.equal(s.requests.length, 1);
});

test('retries a GET on 502 twice', async () => {
  const ok = scripted([{ status: 502 }, { status: 502 }, { json: [{ number: 1, title: 'a' }] }]);
  assert.deepEqual((await client(ok).listIssues({ state: 'open' })).map((i) => i.number), [1]);
  assert.equal(ok.requests.length, 3);
  const down = scripted([{ status: 502 }, { status: 502 }, { status: 502 }, { json: [] }]);
  await assert.rejects(client(down).listIssues({ state: 'open' }), (e) => e instanceof HttpError && e.status === 502);
  assert.equal(down.requests.length, 3);
});

test('drops assignees once on a 422', async () => {
  const s = scripted([{ status: 422, json: { message: 'Validation Failed' } }, { status: 201, json: { number: 9 } }]);
  assert.equal((await client(s).createIssue({ title: 't', body: 'b', labels: ['scriptsnitch'], assignees: ['someone'] })).number, 9);
  assert.equal(s.requests.length, 2);
  assert.deepEqual(s.requests[0].body.assignees, ['someone']);
  assert.equal('assignees' in s.requests[1].body, false);
  const plain = scripted([{ status: 422, json: { message: 'Validation Failed' } }]);
  await assert.rejects(client(plain).createIssue({ title: 't', body: 'b', labels: [] }), (e) => e.status === 422);
  assert.equal(plain.requests.length, 1);
});

test('sends the token and the API version, and reads missing content as null', async () => {
  const s = scripted([{ json: { content: Buffer.from('{"a":1}').toString('base64'), sha: 'abc' } }, { status: 404, json: { message: 'Not Found' } }]);
  const gh = client(s);
  assert.deepEqual(await gh.getContent('scriptsnitch/approved.json', 'main'), { text: '{"a":1}', sha: 'abc' });
  assert.equal(await gh.getContent('missing.json', 'main'), null);
  assert.equal(s.requests[0].headers.authorization, 'Bearer t0k');
  assert.equal(s.requests[0].headers['x-github-api-version'], '2026-03-10');
  assert.match(s.requests[0].url, /\/repos\/acme\/shop\/contents\/scriptsnitch\/approved\.json\?ref=main$/);
});

test('the fake GitHub has the same surface as the real client', () => {
  const real = Object.keys(createGitHub({ token: 'x', repo: 'a/b', fetchImpl: async () => new Response('{}') })).sort();
  const fake = createFakeGitHub();
  assert.deepEqual(real.filter((k) => typeof fake[k] !== 'function'), []);
});

test('the fake GitHub keeps issues, branches, contents and pull requests', async () => {
  const gh = createFakeGitHub({ contents: { main: { 'scriptsnitch/approved.json': '{}' } }, permissions: { octocat: 'write' } });
  const issue = await gh.createIssue({ title: 'x', body: 'y', labels: ['scriptsnitch'], assignees: ['nobody'] });
  assert.deepEqual((await gh.listIssues({ labels: 'scriptsnitch', state: 'open' })).map((i) => i.number), [issue.number]);
  await gh.updateIssue(issue.number, { state: 'closed' });
  assert.deepEqual(await gh.listIssues({ labels: 'scriptsnitch', state: 'open' }), []);
  const base = await gh.getRef('heads/main');
  await gh.createRef('heads/scriptsnitch/approve', base);
  const file = await gh.getContent('scriptsnitch/approved.json', 'scriptsnitch/approve');
  await gh.putContent('scriptsnitch/approved.json', { text: '{"v":2}', sha: file.sha, branch: 'scriptsnitch/approve', message: 'm' });
  assert.equal((await gh.getContent('scriptsnitch/approved.json', 'main')).text, '{}');
  assert.equal((await gh.getContent('scriptsnitch/approved.json', 'scriptsnitch/approve')).text, '{"v":2}');
  await assert.rejects(gh.putContent('scriptsnitch/approved.json', { text: '{}', sha: 'stale', branch: 'scriptsnitch/approve', message: 'm' }), (e) => e.status === 409);
  const pr = await gh.createPull({ title: 'p', head: 'scriptsnitch/approve', base: 'main', body: 'b' });
  assert.deepEqual((await gh.listPulls({ head: 'acme:scriptsnitch/approve', state: 'open' })).map((p) => p.number), [pr.number]);
  assert.equal(await gh.getPermission('octocat'), 'write');
  assert.equal(await gh.getPermission('stranger'), 'none');
  assert.ok(gh.calls.some((c) => c.name === 'createIssue'));
});
