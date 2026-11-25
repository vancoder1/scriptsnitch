// Approval pull requests (design §12): one branch and pull request per site that edits the approved
// file. Routine (Medium) proposals go live when merged; pending (High) ones land in `pending`, which
// merging does not approve. While every commit on the branch is the bot's, each run adds what is new
// (contents API, never a force-push) and merges main in when behind; once a person has pushed, the
// bot leaves the branch alone and comments once per new finding. A person's edits are never lost.
import { parseApproved, emptyApproved, serializeApproved, entryKey, siteSection } from '../config/approved.js';
import { applyProposals } from '../analyze/proposals.js';
import { readMarker, writeMarker } from './markers.js';
import { md, code, cellCode, fence } from './text.js';
import { HttpError } from './github.js';

const NOT_PERMITTED = /not permitted to create or approve pull requests/i;
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'ac', 'edu']);
const BADGE = { high: '🔴 High', medium: '🟠 Medium' };
export const ENABLE_PULL_REQUESTS = 'GitHub Actions is not allowed to open pull requests in this repository, so the edits are shown here instead. To let scriptsnitch open them, go to Settings → Actions → General → Workflow permissions and tick "Allow GitHub Actions to create and approve pull requests".';

const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };
const keyOf = (p) => p.finding ?? `${p.section}|${p.id ?? entryKey(p.section, p.entry ?? {})}|${p.remove ? 'remove' : 'change'}`;
const keysOf = (p) => [keyOf(p), ...(p.also ?? [])];
export const branchFor = (site) => `scriptsnitch/approve-${hostOf(site).replace(/:/g, '-')}`;
export const prTitle = (site) => `scriptsnitch: approve changes on ${hostOf(site)}`;

// The site's open approval pull request: scriptsnitch's marker on a branch of this repository named
// for the site. Anyone can open a pull request with a copied marker, from a fork whose branch is
// called `main`, say; writing to its branch name would write to this repository's default branch.
export function findApprovalPull(pulls, site) {
  const root = branchFor(site);
  const isOurs = (ref) => ref === root || (ref.startsWith(`${root}-`) && /^\d+$/.test(ref.slice(root.length + 1)));
  return pulls.find((p) => {
    const sameRepo = Boolean(p.head?.repo?.full_name) && p.head.repo.full_name === p.base?.repo?.full_name;
    return sameRepo && isOurs(p.head.ref ?? '') && readMarker(p.body, 'pr')?.site === site;
  }) ?? null;
}

// Commits pushed with the job's token are authored by its account: github-actions[bot] for
// GITHUB_TOKEN, <app>[bot] for a GitHub App. No person's login ends in [bot]; a commit whose e-mail is
// linked to no account has no login and counts as a person's.
const byBot = (login) => /\[bot\]$/.test(login ?? '');

// A new approval branch started from base. An old bot-only branch is started again; one with a
// person's commits is left alone (its pull request holds them) and a new name is used.
export async function startBranch(github, { site, base }) {
  const root = branchFor(site);
  let branch = root;
  for (let n = 2; await github.getRef(`heads/${branch}`); n++) {
    const cmp = await github.compare(base, branch);
    if (cmp.commits.every((c) => byBot(c.author))) { await github.deleteRef(`heads/${branch}`); break; }
    branch = `${root}-${n}`;
  }
  await github.createRef(`heads/${branch}`, await github.getRef(`heads/${base}`));
  return branch;
}
const parseFile = (file, path) => (file ? parseApproved(file.text, path) : emptyApproved());

// Same site, roughly: the last two labels agree (three for names like shop.co.uk).
function siteOf(host) {
  const labels = host.toLowerCase().split(':')[0].split('.');
  const n = labels.length >= 3 && labels.at(-1).length === 2 && SECOND_LEVEL.has(labels.at(-2)) ? 3 : 2;
  return labels.slice(-n).join('.');
}

// `c` is the code span to use: cellCode inside a table, code elsewhere.
function describe(p, c = code) {
  if (p.remove) return `remove ${p.section} entry ${c(p.id)}: not seen for 30 days`;
  if (p.section === 'headers') return `set the header baseline for ${c(p.id)}: ${Object.keys(p.add).map(c).join(', ')}`;
  if (p.entry) {
    const e = p.entry;
    const what = p.section === 'scripts' ? (e.match === 'inline' ? `inline scripts on ${e.pages.map(c).join(', ')}` : c(e.match)) : p.section === 'fields' ? c(`${e.frame} ${e.form} ${e.field} ${e.kind}`) : p.section === 'allow' ? c(e.what) : c(e.match);
    return `new ${p.section} entry ${what}${e.trust ? ` with ${c(e.trust)} trust` : ''}${e.receives?.length ? `, may receive ${e.receives.map(c).join(', ')}` : ''}`;
  }
  return `add ${Object.entries(p.add).map(([k, v]) => `${c(k)} ${c(JSON.stringify(v))}`).join(', ')} to ${p.section} entry ${c(p.id)}`;
}

const rows = (list) => ['| Severity | Change | Finding |', '| --- | --- | --- |', ...list.map((p) => `| ${BADGE[p.severity] ?? 'routine'} | ${describe(p, cellCode)} | ${p.finding ? cellCode(p.finding) : ''} |`)];

function renderBody({ site, path, proposals, liveKeys, known, approved }) {
  const pending = proposals.filter((p) => p.mode === 'pending');
  const routine = proposals.filter((p) => p.mode === 'routine');
  const lines = [`scriptsnitch proposes these changes to ${code(path)} for ${md(site)}. Check each one, replace every ${code('TODO')} reason with why the page needs it, then merge.`, ''];
  if (pending.length) {
    lines.push('> [!WARNING]', '> **Pending: merging this pull request does not approve these.** They are High findings, added only to the site\'s `pending` list. Investigate each one first. To approve one, move it into the live section by hand, run `scriptsnitch approve --id <finding key>`, or comment `/scriptsnitch approve <finding key> because <reason>` on the site issue.', '', ...rows(pending), '');
  }
  if (routine.length) lines.push('**Routine: merging approves these.**', '', ...rows(routine), '');
  const sri = proposals.filter((p) => p.sri && p.entry?.trust === 'exact');
  if (sri.length) lines.push('Third-party files with fixed content can also be pinned in your HTML with Subresource Integrity:', '', ...sri.map((p) => `- ${code(`<script src="${p.entry.match}" integrity="${p.sri}" crossorigin="anonymous"></script>`)}`), '');
  const own = new Set(siteSection(approved, site).own);
  const ownLike = [...new Set(proposals.filter((p) => p.entry?.match && /^[a-z]+:\/\//i.test(p.entry.match)).map((p) => new URL(p.entry.match.replace(/\*\./, 'x.').replace(/\{token\}|\{version\}|\*/g, 'x')).origin))]
    .filter((o) => o !== site && !own.has(o) && siteOf(hostOf(o)) === siteOf(hostOf(site)));
  if (ownLike.length) lines.push(`These look like your own: ${ownLike.map(code).join(', ')}. If they are, add them to ${code('own')} in the approved file; scriptsnitch never does that by itself.`, '');
  const gone = [...known].filter((k) => !liveKeys.has(k));
  if (gone.length) lines.push('No longer live (approving these approves something that is gone):', '', ...gone.map((k) => `- ${code(k)}`), '');
  lines.push('Commits pushed with the default `GITHUB_TOKEN` start no workflows, so a required `validate` check runs once a person pushes, such as the commit that fills in the reasons.');
  return lines.join('\n');
}

export function renderEdits(site, proposals, path) {
  if (!proposals.length) return '';
  const lines = [`Proposed edits to ${code(path)} for ${md(site)}:`, ''];
  for (const p of proposals) {
    lines.push(`- ${BADGE[p.severity] ?? 'routine'} ${describe(p)}${p.mode === 'pending' ? ' (into `pending`; merging does not approve it)' : ''}`);
    const json = p.mode === 'pending' ? { finding: p.finding, severity: p.severity, into: p.section, ...(p.entry ? { entry: p.entry } : { id: p.id, add: p.add }) } : p.entry ?? p.add ?? { remove: p.id };
    lines.push('', fence(JSON.stringify(json, null, 2), 'json').split('\n').map((l) => `  ${l}`).join('\n'), '');
  }
  return lines.join('\n');
}

async function writeFile(github, { path, branch, site, proposals, message }) {
  const current = await github.getContent(path, branch);
  const next = applyProposals(parseFile(current, path), site, proposals);
  const text = serializeApproved(next);
  parseApproved(text, path); // never write a file the next run could not read
  await github.putContent(path, { text, sha: current?.sha, branch, message });
  return next;
}

// Proposals the approved file could not read back, such as a URL holding `*` or `{` proposed as an
// exact match, are left out and reported: writing one would stop every later run at the loader.
function readableProposals(site, proposals, path) {
  const ok = [];
  const rejected = [];
  for (const p of proposals) {
    try {
      parseApproved(serializeApproved(applyProposals(emptyApproved(), site, [p])), path);
      ok.push(p);
    } catch (e) {
      rejected.push({ key: keyOf(p), why: e.message });
    }
  }
  return { ok, rejected };
}

export async function syncApprovalPr(github, { site, proposals, approvedPath, base = 'main', propose = 'pr' }) {
  const { ok, rejected } = readableProposals(site, proposals.filter((p) => !p.site || p.site === site), approvedPath);
  return { ...(await syncReadable(github, { site, live: ok, approvedPath, base, propose })), rejected };
}

async function syncReadable(github, { site, live, approvedPath, base, propose }) {
  const edits = renderEdits(site, live, approvedPath);
  if (propose === 'issue') return { prNumber: null, fallback: live.length ? 'issue' : null, edits };
  const host = hostOf(site);
  const liveKeys = new Set(live.flatMap(keysOf));
  const title = prTitle(site);

  const open = findApprovalPull(await github.listPulls({ state: 'open' }), site);
  if (open) {
    const marker = readMarker(open.body, 'pr');
    const head = open.head.ref;
    const known = new Set(marker.keys ?? []);
    const deferred = new Set(marker.deferred ?? []);
    const cmp = await github.compare(base, head);
    const touched = cmp.commits.some((c) => !byBot(c.author));
    const fresh = live.filter((p) => !keysOf(p).some((k) => known.has(k)));
    let approved = parseFile(await github.getContent(approvedPath, head), approvedPath);
    if (!touched && fresh.length) {
      approved = await writeFile(github, { path: approvedPath, branch: head, site, proposals: fresh, message: `scriptsnitch: propose ${fresh.length} more change${fresh.length === 1 ? '' : 's'} on ${host}` });
      for (const p of fresh) for (const k of keysOf(p)) known.add(k);
    }
    if (![...known].some((k) => liveKeys.has(k))) {
      await github.createComment(open.number, 'None of the findings this pull request proposes is live any more, so scriptsnitch closes it: merging it would approve things that are gone.');
      await github.updatePull(open.number, { state: 'closed' });
      if (!touched) await github.deleteRef(`heads/${head}`).catch(() => {});
    } else {
      const untold = touched ? fresh.filter((p) => !keysOf(p).some((k) => deferred.has(k))) : [];
      if (untold.length) {
        await github.createComment(open.number, [`New finding${untold.length === 1 ? '' : 's'} not in this pull request, because a person has pushed to its branch and scriptsnitch no longer changes it:`, ...untold.map((p) => `- ${describe(p)} (${code(keyOf(p))})`), '', 'They will come in the next one, opened after this one is merged or closed.'].join('\n'));
        for (const p of untold) for (const k of keysOf(p)) deferred.add(k);
      }
      if (!touched && cmp.behindBy > 0) await github.updateBranch(open.number).catch((e) => { if (!(e instanceof HttpError && e.status === 422)) throw e; });
      const listed = live.filter((p) => keysOf(p).some((k) => known.has(k)));
      const body = writeMarker(renderBody({ site, path: approvedPath, proposals: listed, liveKeys, known, approved }), 'pr', { v: 1, site, keys: [...known], deferred: [...deferred] });
      await github.updatePull(open.number, { title, body });
      return { prNumber: open.number, fallback: null, edits };
    }
  }
  if (!live.length) return { prNumber: null, fallback: null, edits };

  const branch = await startBranch(github, { site, base });
  const approved = await writeFile(github, { path: approvedPath, branch, site, proposals: live, message: `scriptsnitch: propose ${live.length} change${live.length === 1 ? '' : 's'} on ${host}` });
  const body = writeMarker(renderBody({ site, path: approvedPath, proposals: live, liveKeys, known: liveKeys, approved }), 'pr', { v: 1, site, keys: [...liveKeys], deferred: [] });
  try {
    return { prNumber: (await github.createPull({ title, head: branch, base, body })).number, fallback: null, edits };
  } catch (err) {
    if (err instanceof HttpError && err.status === 403 && NOT_PERMITTED.test(`${err.body} ${err.message}`)) return { prNumber: null, fallback: 'issue', edits: `${edits}\n${ENABLE_PULL_REQUESTS}` };
    throw err;
  }
}
