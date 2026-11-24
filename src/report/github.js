// The GitHub REST calls scriptsnitch makes, with the job's token. Reads are retried; a POST never
// is: one that timed out may still have reached GitHub, and sending it again could open a second
// issue or pull request. The next run is the retry, and it sees whatever did go through.
import { VERSION } from '../version.js';

export class HttpError extends Error {
  constructor(method, url, status, body) {
    const why = String(body ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
    super(`HTTP ${status} from ${method} ${url}${why ? `: ${why}` : ''}`);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (path) => path.split('/').map(encodeURIComponent).join('/');

export function createGitHub({ token, repo, apiUrl = 'https://api.github.com', fetchImpl = fetch, backoff = (attempt) => 2 ** attempt * 1000, timeoutMs = 60000 }) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': `scriptsnitch/${VERSION} (+https://github.com/vancoder1/scriptsnitch)`,
    'x-github-api-version': '2026-03-10',
  };

  async function request(method, path, { body, raw = false, absolute = false } = {}) {
    const url = absolute ? path : `${apiUrl}${path}`;
    const retries = method === 'POST' ? 0 : 2;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(backoff(attempt));
      let res;
      try {
        res = await fetchImpl(url, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      } catch (err) {
        lastError = err;
        continue;
      }
      if (res.ok) {
        if (raw) return Buffer.from(await res.arrayBuffer());
        return res.status === 204 ? null : res.json();
      }
      lastError = new HttpError(method, url, res.status, (await res.text()).slice(0, 500));
      if (!(res.status === 429 || res.status >= 500)) throw lastError;
    }
    throw lastError;
  }
  const repoCall = (method, path, opts) => request(method, `/repos/${repo}${path}`, opts);
  const orNull = async (promise) => { try { return await promise; } catch (e) { if (e instanceof HttpError && e.status === 404) return null; throw e; } };

  async function paginate(path, pick = (x) => x) {
    const all = [];
    for (let page = 1; ; page++) {
      const batch = pick(await repoCall('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`));
      all.push(...batch);
      if (batch.length < 100) return all;
    }
  }
  const query = (params) => Object.entries(params).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

  return {
    async listIssues({ labels, state = 'open' } = {}) {
      return (await paginate(`/issues?${query({ labels, state })}`)).filter((i) => !i.pull_request);
    },
    getIssue: (n) => repoCall('GET', `/issues/${n}`),
    async createIssue({ title, body, labels = [], assignees = [] }) {
      try {
        return await repoCall('POST', '/issues', { body: { title, body, labels, ...(assignees.length ? { assignees } : {}) } });
      } catch (err) {
        // 422 when an assignee cannot be assigned: the first request failed validation and created
        // nothing, so this one re-send is safe. Open it unassigned rather than not at all.
        if (err instanceof HttpError && err.status === 422 && assignees.length) return repoCall('POST', '/issues', { body: { title, body, labels } });
        throw err;
      }
    },
    updateIssue: (n, patch) => repoCall('PATCH', `/issues/${n}`, { body: patch }),
    createComment: (n, body) => repoCall('POST', `/issues/${n}/comments`, { body: { body } }),
    listComments: (n) => paginate(`/issues/${n}/comments`),
    async ensureLabels(wanted) {
      const existing = new Set((await paginate('/labels')).map((l) => l.name.toLowerCase()));
      for (const { name, color, description } of wanted) {
        if (!existing.has(name.toLowerCase())) await repoCall('POST', '/labels', { body: { name, color, description } });
      }
    },
    async getRef(ref) {
      const r = await orNull(repoCall('GET', `/git/ref/${enc(ref)}`));
      return r?.object?.sha ?? null;
    },
    createRef: (ref, sha) => repoCall('POST', '/git/refs', { body: { ref: `refs/${ref}`, sha } }),
    updateRef: (ref, sha, force = false) => repoCall('PATCH', `/git/refs/${enc(ref)}`, { body: { sha, force } }),
    deleteRef: (ref) => repoCall('DELETE', `/git/refs/${enc(ref)}`),
    // Commits on head that base lacks, with their author logins, and how far head is behind.
    async compare(base, head) {
      const r = await repoCall('GET', `/compare/${enc(base)}...${enc(head)}`);
      return { aheadBy: r.ahead_by, behindBy: r.behind_by, commits: (r.commits ?? []).map((c) => ({ sha: c.sha, author: c.author?.login ?? null, message: c.commit?.message ?? '' })) };
    },
    async getContent(path, ref) {
      const r = await orNull(repoCall('GET', `/contents/${enc(path)}?${query({ ref })}`));
      return r ? { text: Buffer.from(r.content ?? '', 'base64').toString('utf8'), sha: r.sha } : null;
    },
    putContent: (path, { text, sha, branch, message }) => repoCall('PUT', `/contents/${enc(path)}`, { body: { message, content: Buffer.from(text, 'utf8').toString('base64'), branch, ...(sha ? { sha } : {}) } }),
    listPulls: ({ head, state = 'open' } = {}) => paginate(`/pulls?${query({ head: head && !head.includes(':') ? `${repo.split('/')[0]}:${head}` : head, state })}`),
    createPull: ({ title, head, base, body }) => repoCall('POST', '/pulls', { body: { title, head, base, body } }),
    updatePull: (n, patch) => repoCall('PATCH', `/pulls/${n}`, { body: patch }),
    updateBranch: (n) => repoCall('PUT', `/pulls/${n}/update-branch`, { body: {} }),
    listCommits: ({ sha, path } = {}) => paginate(`/commits?${query({ sha, path })}`),
    async getPermission(user) {
      const r = await orNull(repoCall('GET', `/collaborators/${encodeURIComponent(user)}/permission`));
      return r?.permission ?? 'none';
    },
    listWorkflowRuns: ({ workflowFile, status }) => paginate(`/actions/workflows/${encodeURIComponent(workflowFile)}/runs?${query({ status })}`, (r) => r.workflow_runs),
    listRunArtifacts: (runId) => paginate(`/actions/runs/${runId}/artifacts`, (r) => r.artifacts),
    // GitHub answers with a redirect to storage; fetch drops the token on that cross-origin hop.
    downloadArtifact: (id) => repoCall('GET', `/actions/artifacts/${id}/zip`, { raw: true }),
  };
}
