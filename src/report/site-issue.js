// Site issues (design §12): one issue per site, rewritten each run to show what is live and not
// approved. A comment (which notifies) only when a new finding key appears. A Medium drops off after
// two conclusive runs without it and returns silently within 30 days; a vanished High stays listed
// until a person closes the issue. Closing by hand mutes what is in it; a new key reopens it.
import { readMarker, writeMarker } from './markers.js';
import { md, code } from './text.js';
import { emptySiteState } from '../state.js';
import { isoDate, daysBetween } from '../util/time.js';
import { LABEL } from './status-issue.js';

const KEEP_DROPPED_DAYS = 30;
const KEEP_MUTED_DAYS = 90;
const BODY_LIMIT = 60000;
const BADGE = { high: '🔴 High', medium: '🟠 Medium' };

export async function readSites(github) {
  const out = new Map();
  for (const issue of await github.listIssues({ labels: LABEL, state: 'all' })) {
    const st = readMarker(issue.body, 'site');
    if (!st?.site) continue;
    const cur = out.get(st.site);
    const better = !cur || Number(issue.state === 'open') > Number(cur.issue.state === 'open') || (issue.state === cur.issue.state && issue.number > cur.issue.number);
    if (better) out.set(st.site, { issue, state: { ...emptySiteState(st.site), ...st } });
  }
  return out;
}

const hostOf = (site) => { try { return new URL(site).host; } catch { return site; } };
const where = (e) => `${(e.seenOn?.length ? e.seenOn : [e.page]).map(code).join(', ')}${e.profiles?.length ? ` (${e.profiles.join(', ')})` : ''}`;
const row = (key, e, today, links) => {
  const gone = e.last !== today ? `**Not seen since ${e.last}.** ` : '';
  const why = `${gone}${e.reasons.map(md).join('<br>')}${links.evidenceUrl ? ` [evidence](${links.evidenceUrl})` : ''}`;
  const approve = e.severity === 'high' ? 'pending' : 'routine';
  return `| ${BADGE[e.severity] ?? e.severity} | ${code(e.kind)} ${code(e.subject)} | ${where(e)} | ${why} | ${links.prUrl ? `[${approve}](${links.prUrl})` : approve} |`;
};
const table = (entries, today, links) => ['| Severity | Finding | Where | Why | To approve |', '| --- | --- | --- | --- | --- |', ...entries.map(([k, e]) => row(k, e, today, links))].join('\n');
const order = ([, a], [, b]) => Number(b.severity === 'high') - Number(a.severity === 'high') || a.first.localeCompare(b.first);

function render({ site, active, muted, today, links, diffs, firstRun, notify, withDiffs = true }) {
  const lines = [];
  if (firstRun) lines.push('> Nothing is approved for this site yet. Everything below was seen on its first run: this inventory is only as clean as the site is today. Review it in the approval pull request before merging.', '');
  if (active.length) {
    lines.push(`**${active.length} unapproved change${active.length === 1 ? '' : 's'} on ${md(site)}.** Last checked ${today}${links.runUrl ? ` ([run](${links.runUrl}))` : ''}.`, '', table(active, today, links), '');
    lines.push('<details><summary>Finding keys</summary>', '', ...active.map(([k]) => `- ${code(k)}`), '', '</details>', '');
    if (withDiffs) {
      for (const [k, e] of active) {
        if (diffs?.has(k)) lines.push(`<details><summary>What changed: ${md(e.subject)}</summary>`, '', diffs.get(k), '', '</details>', '');
      }
    }
    lines.push(`To approve, check each entry in the approval pull request${links.prUrl ? ` (${links.prUrl})` : ''} and merge it, or comment ${code('/scriptsnitch approve <finding key> because <reason>')} here. High findings are only ever proposed as pending: a person moves them into the live file. To dismiss everything listed, close this issue; the findings in it are muted until something new appears.`, '');
  } else {
    lines.push(`Nothing unapproved is live on ${md(site)}. Last checked ${today}${links.runUrl ? ` ([run](${links.runUrl}))` : ''}.`, '');
  }
  if (muted.length) lines.push(`<details><summary>Muted (${muted.length})</summary>`, '', table(muted, today, links), '', '</details>', '');
  if (notify.length) lines.push(`cc ${notify.map((n) => `@${n}`).join(' ')}`);
  return lines.join('\n').trimEnd();
}

export async function reconcileSite(github, { site, issue = null, siteState = null, findings, run, now = Date.now(), notify = [], links = {}, diffs = new Map() }) {
  const today = isoDate(now);
  const prev = siteState ?? emptySiteState(site);
  const st = structuredClone(prev);
  st.findings ??= {};
  for (const [k, e] of Object.entries(st.findings)) {
    if (e.droppedAt && daysBetween(e.droppedAt, today) > KEEP_DROPPED_DAYS) delete st.findings[k];
    else if (e.muted && daysBetween(e.last, today) > KEEP_MUTED_DAYS) delete st.findings[k];
  }
  // A closed issue that the bot did not close was closed by a person: that mutes what is in it.
  if (issue?.state === 'closed' && !prev.closedByBot) for (const e of Object.values(st.findings)) if (!e.droppedAt) e.muted = true;

  const live = new Set(findings.map((f) => f.key));
  const fresh = [];
  for (const f of findings) {
    let e = st.findings[f.key];
    if (!e) { e = st.findings[f.key] = { first: today, reported: today, muted: false }; fresh.push(f); }
    Object.assign(e, { last: today, missed: 0, droppedAt: null, kind: f.kind, severity: f.severity, subject: f.subject, page: f.page, seenOn: f.seenOn ?? [], profiles: f.profiles ?? [], reasons: f.reasons.slice(0, 3) });
  }
  for (const [k, e] of Object.entries(st.findings)) {
    if (live.has(k) || e.droppedAt) continue;
    const pairs = (e.seenOn.length ? e.seenOn : [e.page]).flatMap((p) => (e.profiles.length ? e.profiles : ['desktop']).map((pr) => `${p}|${pr}`));
    if (pairs.every((x) => run.conclusive.has(x))) e.missed += 1;
    if (e.severity !== 'high' && e.missed >= 2) e.droppedAt = today;
  }

  const entries = Object.entries(st.findings).sort(order);
  const active = entries.filter(([, e]) => !e.muted && !e.droppedAt);
  const muted = entries.filter(([, e]) => e.muted);
  const host = hostOf(site);
  const worst = active.some(([, e]) => e.severity === 'high') ? '🔴' : '🟠';
  const title = active.length ? `${worst} scriptsnitch: ${active.length} unapproved change${active.length === 1 ? '' : 's'} on ${host}` : `scriptsnitch: nothing unapproved on ${host}`;

  if (!issue && !active.length) return st;
  let action;
  if (!issue) action = 'create';
  else if (active.length) action = 'open';
  else action = issue.state === 'open' ? 'close' : 'keep';
  st.closedByBot = action === 'close' || (action === 'keep' && prev.closedByBot);

  const view = { site, active, muted, today, links, diffs, firstRun: findings.some((f) => f.firstRun), notify };
  let text = render(view);
  if (text.length > BODY_LIMIT) text = render({ ...view, withDiffs: false });
  let body = writeMarker(text, 'site', st);
  if (body.length > BODY_LIMIT) body = writeMarker(`${text.slice(0, BODY_LIMIT - 2000)}\n\n…cut to fit GitHub's limit; report.json and the job summary list everything.`, 'site', st);

  let number = issue?.number;
  if (action === 'create') number = (await github.createIssue({ title, body, labels: [LABEL], assignees: notify.filter((n) => !n.includes('/')) })).number;
  else await github.updateIssue(number, { title, body, ...(action === 'open' && issue.state !== 'open' ? { state: 'open' } : {}), ...(action === 'close' ? { state: 'closed', state_reason: 'completed' } : {}) });

  if (action !== 'create' && fresh.length) {
    const list = fresh.map((f) => `- ${BADGE[f.severity]} ${code(f.kind)} ${code(f.subject)} on ${where(f)}`);
    await github.createComment(number, [`New unapproved change${fresh.length === 1 ? '' : 's'} on ${md(site)}:`, ...list, ...(notify.length ? ['', `cc ${notify.map((n) => `@${n}`).join(' ')}`] : [])].join('\n'));
  }
  return { ...st, issue: number };
}
