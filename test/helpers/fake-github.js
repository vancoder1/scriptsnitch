// An in-memory GitHub with the same surface as src/report/github.js, for run tests. It keeps issues,
// comments, branches (as commits of whole trees), file contents, pull requests, permissions,
// workflow runs and artifacts, records every call, and can be told to fail the next call to a method.
import { createHash } from 'node:crypto';
import { HttpError } from '../../src/report/github.js';

const hash = (s) => createHash('sha1').update(String(s)).digest('hex');
const WRITE = new Set(['write', 'maintain', 'admin']);

export function createFakeGitHub(initial = {}) {
  const owner = initial.owner ?? 'acme';
  const bot = { login: 'github-actions[bot]' };
  let number = 0;
  let commentId = 0;
  let clock = Date.parse(initial.now ?? '2026-11-24T06:00:00Z');
  const tick = () => new Date((clock += 1000)).toISOString();

  const trees = {};
  const commits = {};
  // Commits made through the API with the job's token are authored by the bot, as on GitHub.
  const commit = (tree, parents, message, author = 'github-actions[bot]') => {
    const list = [parents].flat().filter(Boolean);
    const sha = hash(JSON.stringify([tree, list, message, clock]));
    trees[sha] = tree;
    commits[sha] = { sha, parents: list, parent: list[0] ?? null, commit: { message, author: { name: author, date: tick() } }, author: { login: author } };
    return sha;
  };
  const ancestors = (sha) => {
    const seen = new Set();
    const stack = [sha];
    while (stack.length) {
      const c = stack.pop();
      if (!c || seen.has(c) || !commits[c]) continue;
      seen.add(c);
      stack.push(...commits[c].parents);
    }
    return seen;
  };
  const refs = {};
  for (const [branch, files] of Object.entries(initial.contents ?? { main: {} })) refs[`heads/${branch}`] = commit({ ...files }, null, 'initial');
  if (!refs['heads/main']) refs['heads/main'] = commit({}, null, 'initial');

  const state = {
    issues: [],
    pulls: [],
    comments: {},
    refs,
    permissions: { ...(initial.permissions ?? {}) },
    runs: [...(initial.runs ?? [])],
    artifacts: { ...(initial.artifacts ?? {}) },
    blobs: { ...(initial.blobs ?? {}) },
    labels: [],
  };
  const calls = [];
  const failures = new Map();
  const notFound = (what) => new HttpError('GET', what, 404, '{"message":"Not Found"}');

  const api = {
    async listIssues({ labels, state: wanted = 'open' } = {}) {
      const need = labels ? String(labels).split(',') : [];
      return state.issues.filter((i) => (wanted === 'all' || i.state === wanted) && need.every((l) => i.labels.some((x) => x.name === l))).map((i) => structuredClone(i));
    },
    async getIssue(n) {
      const i = state.issues.find((x) => x.number === n) ?? state.pulls.find((x) => x.number === n);
      if (!i) throw notFound(`issue ${n}`);
      return structuredClone(i);
    },
    async createIssue({ title, body, labels = [], assignees = [] }) {
      // The real client retries once without assignees on a 422; the fake just keeps the valid ones.
      const issue = { number: ++number, title, body, state: 'open', labels: labels.map((name) => ({ name })), assignees: assignees.filter((a) => WRITE.has(state.permissions[a])).map((login) => ({ login })), user: bot, created_at: tick(), html_url: `https://github.com/${owner}/repo/issues/${number}` };
      state.issues.push(issue);
      return structuredClone(issue);
    },
    async updateIssue(n, patch) {
      const i = state.issues.find((x) => x.number === n);
      if (!i) throw notFound(`issue ${n}`);
      for (const [k, v] of Object.entries(patch)) {
        if (k === 'labels') i.labels = v.map((name) => ({ name: typeof name === 'string' ? name : name.name }));
        else if (k === 'assignees') i.assignees = v.map((login) => ({ login }));
        else i[k] = v;
      }
      return structuredClone(i);
    },
    async createComment(n, body, user = bot) {
      const c = { id: ++commentId, body, user: typeof user === 'string' ? { login: user } : user, created_at: tick() };
      (state.comments[n] ??= []).push(c);
      return structuredClone(c);
    },
    async listComments(n) { return structuredClone(state.comments[n] ?? []); },
    async ensureLabels(wanted) { for (const l of wanted) if (!state.labels.some((x) => x.name.toLowerCase() === l.name.toLowerCase())) state.labels.push(l); },
    async getRef(ref) { return state.refs[ref] ?? null; },
    async createRef(ref, sha) {
      if (state.refs[ref]) throw new HttpError('POST', ref, 422, '{"message":"Reference already exists"}');
      if (!trees[sha]) throw new HttpError('POST', ref, 422, '{"message":"Object does not exist"}');
      state.refs[ref] = sha;
      return { ref: `refs/${ref}`, object: { sha } };
    },
    async updateRef(ref, sha) {
      if (!state.refs[ref]) throw notFound(ref);
      state.refs[ref] = sha;
      return { ref: `refs/${ref}`, object: { sha } };
    },
    async getContent(path, ref = 'main') {
      const sha = state.refs[`heads/${ref}`] ?? (trees[ref] ? ref : null);
      const text = sha ? trees[sha][path] : undefined;
      return text === undefined ? null : { text, sha: hash(`blob ${text}`) };
    },
    async putContent(path, { text, sha, branch, message }) {
      const ref = `heads/${branch}`;
      const head = state.refs[ref];
      if (!head) throw notFound(ref);
      const current = trees[head][path];
      if (current !== undefined && !sha) throw new HttpError('PUT', path, 422, '{"message":"sha wasn\'t supplied"}');
      if (current !== undefined && sha !== hash(`blob ${current}`)) throw new HttpError('PUT', path, 409, '{"message":"does not match"}');
      state.refs[ref] = commit({ ...trees[head], [path]: text }, head, message);
      return { content: { sha: hash(`blob ${text}`) }, commit: { sha: state.refs[ref] } };
    },
    async listPulls({ head, state: wanted = 'open' } = {}) {
      const branch = head?.includes(':') ? head.split(':').slice(1).join(':') : head;
      return state.pulls.filter((p) => (wanted === 'all' || p.state === wanted) && (!branch || p.head.ref === branch)).map((p) => structuredClone(p));
    },
    async createPull({ title, head, base, body }) {
      if (!state.refs[`heads/${head}`]) throw new HttpError('POST', 'pulls', 422, '{"message":"head does not exist"}');
      const pr = { number: ++number, title, body, state: 'open', merged: false, head: { ref: head }, base: { ref: base }, user: bot, created_at: tick(), html_url: `https://github.com/${owner}/repo/pull/${number}` };
      state.pulls.push(pr);
      return structuredClone(pr);
    },
    async updatePull(n, patch) {
      const p = state.pulls.find((x) => x.number === n);
      if (!p) throw notFound(`pull ${n}`);
      Object.assign(p, patch);
      return structuredClone(p);
    },
    // Merges base into the pull request's branch (a merge commit, never a force-push).
    async updateBranch(n) {
      const p = state.pulls.find((x) => x.number === n);
      if (!p) throw notFound(`pull ${n}`);
      const headRef = `heads/${p.head.ref}`;
      const head = state.refs[headRef];
      const base = state.refs[`heads/${p.base.ref}`];
      const fromHead = ancestors(head);
      if (fromHead.has(base)) return { message: 'Already up to date.' };
      const mergeBase = [...ancestors(base)].filter((c) => fromHead.has(c)).sort((x, y) => commits[y].commit.author.date.localeCompare(commits[x].commit.author.date))[0];
      const merged = { ...trees[base] };
      for (const [path, text] of Object.entries(trees[head])) if (text !== trees[mergeBase]?.[path]) merged[path] = text;
      state.refs[headRef] = commit(merged, [head, base], `Merge branch '${p.base.ref}' into ${p.head.ref}`);
      return { message: 'Updating pull request branch.' };
    },
    async compare(base, head) {
      const b = state.refs[`heads/${base}`] ?? base;
      const h = state.refs[`heads/${head}`] ?? head;
      const fromBase = ancestors(b);
      const fromHead = ancestors(h);
      const ahead = [...fromHead].filter((c) => !fromBase.has(c));
      return { aheadBy: ahead.length, behindBy: [...fromBase].filter((c) => !fromHead.has(c)).length, commits: ahead.map((c) => ({ sha: c, author: commits[c].author.login, message: commits[c].commit.message })) };
    },
    async deleteRef(ref) {
      if (!state.refs[ref]) throw notFound(ref);
      delete state.refs[ref];
      return null;
    },
    async listCommits({ sha = 'main', path } = {}) {
      const out = [];
      for (let c = state.refs[`heads/${sha}`] ?? sha; c && commits[c]; c = commits[c].parent) {
        const parent = commits[c].parent;
        if (!path || trees[c][path] !== (parent ? trees[parent][path] : undefined)) out.push(structuredClone(commits[c]));
      }
      return out;
    },
    async getPermission(user) { return state.permissions[user] ?? 'none'; },
    async listWorkflowRuns({ workflowFile, status }) { return state.runs.filter((r) => (!workflowFile || r.workflowFile === workflowFile) && (!status || r.status === status)).map((r) => structuredClone(r)); },
    async listRunArtifacts(runId) { return structuredClone(state.artifacts[runId] ?? []); },
    async downloadArtifact(id) {
      if (!state.blobs[id]) throw notFound(`artifact ${id}`);
      return Buffer.from(state.blobs[id]);
    },
  };

  const fake = { state, calls, owner, fail: (name, error) => failures.set(name, error) };
  for (const [name, fn] of Object.entries(api)) {
    fake[name] = async (...args) => {
      calls.push({ name, args });
      const error = failures.get(name);
      if (error) { failures.delete(name); throw error; }
      return fn(...args);
    };
  }
  // Helpers for tests: what a person does on GitHub between runs.
  fake.mergePull = (n) => {
    const p = state.pulls.find((x) => x.number === n);
    const head = state.refs[`heads/${p.head.ref}`];
    state.refs[`heads/${p.base.ref}`] = commit({ ...trees[head] }, state.refs[`heads/${p.base.ref}`], `${p.title} (#${n})`, 'reviewer');
    Object.assign(p, { state: 'closed', merged: true });
  };
  fake.commitFile = (path, text, { branch = 'main', author = 'someone', message = `edit ${path}` } = {}) => {
    const ref = `heads/${branch}`;
    state.refs[ref] = commit({ ...trees[state.refs[ref]], [path]: text }, state.refs[ref], message, author);
  };
  fake.file = (path, branch = 'main') => trees[state.refs[`heads/${branch}`]]?.[path];
  return fake;
}
