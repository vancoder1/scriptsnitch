// The evidence pack (design §12): one Markdown file for an assessor. The inventory with each entry's
// reason, trust level and how its integrity is assured; who approved what and when, from the git
// history of the approved file; the run log from the status issue and how far back it reaches;
// drill results; the PCI DSS mapping. It supports, and does not certify, compliance.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { siteSection, entryKey } from '../config/approved.js';
import { parseJsonText } from '../util/json.js';
import { md, code } from '../report/text.js';
import { daysBetween } from '../util/time.js';

const run = promisify(execFile);
const FIELD = '\x1f';
const LIVE = ['scripts', 'destinations', 'frames', 'fields', 'allow'];

const INTEGRITY = {
  exact: (e) => (e.match === 'inline' ? `template hash (${e.template?.length ?? 0} approved)` : `SHA-256 content hash (${e.sha256?.length ?? 0} approved version${e.sha256?.length === 1 ? '' : 's'})`),
  origin: () => 'the vendor may update it; scriptsnitch checks its behaviour, listeners, destinations and domains on every run',
  deploy: (e) => `your own release process: changes outside an evident deploy are reported${e.sha256?.length ? `; ${e.sha256.length} extra content hash${e.sha256.length === 1 ? '' : 'es'} approved` : ''}`,
};

// The live entries of one version of the approved file, read leniently (old versions may predate a
// field); pending items are not approved, so they are left out.
function liveEntries(text) {
  let raw;
  try { raw = parseJsonText(text ?? '', 'approved.json'); } catch { return null; }
  const out = [];
  for (const site of Object.values(raw?.sites ?? {})) {
    for (const section of LIVE) {
      for (const e of site?.[section] ?? []) {
        if (!e || typeof e !== 'object') continue;
        const key = entryKey(section, { pages: ['**'], ...e });
        out.push(section === 'scripts' ? String(key) : `${section}: ${key}`);
      }
    }
  }
  return new Set(out);
}

// versions: newest first, [{ commit, author, date, subject, text }]; each is compared with the next.
export function historyFromVersions(versions) {
  return versions.map((v, i) => {
    const now = liveEntries(v.text) ?? new Set();
    const before = i + 1 < versions.length ? liveEntries(versions[i + 1].text) ?? new Set() : new Set();
    return { commit: v.commit, author: v.author, date: String(v.date).slice(0, 10), subject: v.subject, added: [...now].filter((k) => !before.has(k)), removed: [...before].filter((k) => !now.has(k)) };
  });
}

export async function approvalHistoryFromGit(approvedPath, { cwd = process.cwd() } = {}) {
  const { stdout } = await run('git', ['log', `--format=%H${FIELD}%an${FIELD}%aI${FIELD}%s`, '--', approvedPath], { cwd, maxBuffer: 64 * 1024 * 1024 });
  const versions = [];
  for (const line of stdout.replace(/\r/g, '').split('\n').filter(Boolean)) {
    const [commit, author, date, subject] = line.split(FIELD);
    const text = await run('git', ['show', `${commit}:${approvedPath.replace(/\\/g, '/')}`], { cwd, maxBuffer: 64 * 1024 * 1024 }).then((r) => r.stdout, () => null);
    versions.push({ commit, author, date, subject, text });
  }
  return historyFromVersions(versions);
}

const row = (cells) => `| ${cells.join(' | ')} |`;
const pages = (e) => (e.pages ?? ['**']).map(code).join(', ');

function inventory(approved) {
  const lines = [];
  for (const site of Object.keys(approved.sites).sort()) {
    const s = siteSection(approved, site);
    lines.push(`### ${code(site)}`, '');
    if (s.own.length) lines.push(`Own origins: ${s.own.map(code).join(', ')}.`, '');
    lines.push('**Scripts**', '', row(['Entry', 'Script', 'Pages', 'Trust', 'Integrity assured by', 'Reason', 'Proposed']), row(Array(7).fill('---')));
    for (const e of s.scripts) lines.push(row([code(e.id), e.match === 'inline' ? 'inline scripts' : code(e.match), pages(e), e.trust, INTEGRITY[e.trust](e), md(e.reason), e.approved]));
    lines.push('');
    if (s.destinations.length) {
      lines.push('**Where data may go**', '', row(['Destination', 'Pages', 'May receive', 'Reason', 'Proposed']), row(Array(5).fill('---')));
      for (const d of s.destinations) lines.push(row([code(d.match), pages(d), d.receives?.length ? d.receives.join(', ') : 'nothing typed into forms', md(d.reason), d.approved]));
      lines.push('');
    }
    if (s.frames.length) {
      lines.push('**Frames**', '', row(['Frame', 'Pages', 'Sensitive fields', 'Reason', 'Proposed']), row(Array(5).fill('---')));
      for (const f of s.frames) lines.push(row([code(f.match), pages(f), f.fields?.length ? f.fields.join(', ') : 'none', md(f.reason), f.approved]));
      lines.push('');
    }
    if (s.fields.length) {
      lines.push('**Sensitive fields**', '', row(['Field', 'Pages', 'Count', 'Reason', 'Proposed']), row(Array(5).fill('---')));
      for (const f of s.fields) lines.push(row([code(`${f.frame} ${f.form} ${f.field} ${f.kind}`), pages(f), f.count ?? 1, md(f.reason), f.approved]));
      lines.push('');
    }
    if (s.allow.length) {
      lines.push('**Allowed capabilities**', '');
      for (const a of s.allow) lines.push(`- ${code(a.what)} on ${pages(a)}: ${md(a.reason)} (${a.approved})`);
      lines.push('');
    }
    const headers = Object.entries(s.headers);
    if (headers.length) {
      lines.push('**Expected security headers (11.6.1)**', '');
      for (const [pattern, values] of headers) for (const [name, value] of Object.entries(values)) lines.push(`- ${code(pattern)}: ${code(name)} ${code(typeof value === 'string' ? value : JSON.stringify(value))}`);
      lines.push('');
    }
    if (s.pending.length) {
      lines.push('**Not approved (pending review)**', '', 'These were proposed after a High finding and are not part of the approved inventory until a person moves them into it.', '');
      for (const p of s.pending) lines.push(`- ${code(p.finding)}`);
      lines.push('');
    }
  }
  return lines;
}

export function evidencePack({ approved, approvalHistory = [], statusState, since, until, generatedAt }) {
  const inRange = (d) => d >= since && d <= until;
  const runs = (statusState?.log ?? []).filter(([d]) => inRange(d));
  const firstLogged = statusState?.log?.[0]?.[0] ?? null;
  const gaps = runs.slice(1).map(([d], i) => daysBetween(runs[i][0], d));
  const approvals = approvalHistory.filter((h) => inRange(h.date));
  const drills = runs.filter((r) => r[4]);
  const lines = [
    '# scriptsnitch evidence pack', '',
    `Generated ${generatedAt}, covering ${since} to ${until}.`, '',
    '> This pack supports a PCI DSS 4.0.1 assessment of requirements 6.4.3 and 11.6.1 with records scriptsnitch keeps. It does not certify compliance: the assessor decides.', '',
    '## Inventory of scripts and where data may go (6.4.3)', '',
    'Every entry below was approved by merging a change to the approved file; each has a written reason and a trust level that says how its integrity is assured.', '',
    ...inventory(approved),
    '## Approvals (6.4.3, authorization)', '',
  ];
  if (approvals.length) {
    lines.push(row(['Date', 'Commit', 'Author', 'Change']), row(Array(4).fill('---')));
    for (const h of approvals) lines.push(row([h.date, code(h.commit.slice(0, 7)), md(h.author), [h.added.length ? `added ${h.added.map(code).join(', ')}` : '', h.removed.length ? `removed ${h.removed.map(code).join(', ')}` : ''].filter(Boolean).join('; ') || md(h.subject)]));
  } else lines.push('No changes to the approved file in this period.');
  lines.push('', 'The merge commits are the authoritative record of who approved what; branch protection decides who may merge.', '', '## Monitoring runs (11.6.1)', '');
  if (firstLogged) lines.push(`The run log kept in the status issue goes back to ${firstLogged}${firstLogged > since ? '; earlier runs in the period are not recorded here' : ''}.`, '');
  if (runs.length) {
    lines.push(`${runs.length} run${runs.length === 1 ? '' : 's'} in the period${gaps.length ? `; the longest gap between two runs was ${Math.max(...gaps)} days` : ''}.`, '');
    lines.push(row(['Date', 'Conclusive pages', 'High', 'Medium', 'Fire drill']), row(Array(5).fill('---')));
    for (const [d, pagesOk, high, medium, drill] of runs) lines.push(row([d, pagesOk, high, medium, drill ?? '—']));
  } else lines.push('No runs are recorded in this period.');
  lines.push('', '## Fire drills', '');
  if (drills.length) for (const [d, , , , r] of drills) lines.push(`- ${d}: ${r === 'pass' ? 'passed' : 'failed'}`);
  else lines.push('No fire drills in this period.');
  lines.push('', '## How this maps to PCI DSS 4.0.1', '',
    row(['Requirement', 'What scriptsnitch provides', 'Where']), row(Array(3).fill('---')),
    row(['6.4.3: each script is authorized', 'Entries enter the approved file only through a reviewed, merged change; High findings are proposed as pending and a merge never approves them', 'Approvals']),
    row(['6.4.3: each script\'s integrity is assured', '`exact`: SHA-256 hash; `origin`: the vendor is authorized to update and every run checks behaviour, destinations and domains; `deploy`: your release process, with changes outside a deploy reported', 'Inventory, trust column']),
    row(['6.4.3: an inventory with a written justification', 'The approved file, with a reason for every entry; `validate` fails while a live entry has none', 'Inventory']),
    row(['11.6.1: alert on unauthorized changes to scripts and security headers as the browser receives them', 'Scheduled checks in Chrome raise a GitHub issue for each unapproved change and a weakened header', 'Monitoring runs']),
    '', 'Limits: a scheduled check from a data center is a tripwire, not a guarantee, and a skimmer that uses only approved channels can pass. The README lists every limit.', '');
  return lines.join('\n');
}
