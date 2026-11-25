// The report job (design §6): judges the snapshot the collect job wrote, against the approved file
// and the state in the status issue, then reconciles the site issues, the approval pull requests
// and the status issue, and writes report.json and the job summary. With dryRun it only reads.
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseJsonText } from '../util/json.js';
import { validateSnapshot } from '../snapshot.js';
import { judge, observedIndex } from '../analyze/judge.js';
import { proposalsFor, staleProposals } from '../analyze/proposals.js';
import { readStatus, reconcileStatus } from '../report/status-issue.js';
import { readSites, reconcileSite } from '../report/site-issue.js';
import { syncApprovalPr, findApprovalPull } from '../report/pr.js';
import { previousEvidence } from '../report/artifacts.js';
import { renderDiff } from '../report/diff.js';
import { domainsToCheck, checkDomains } from '../report/domains.js';
import { reportOf, writeReport, formatSummaryMarkdown } from '../report/summary.js';
import { siteState } from '../state.js';
import { isoDate, daysBetween } from '../util/time.js';

const DIFF_KINDS = new Set(['content-mismatch', 'in-place-change', 'own-change', 'build-file', 'new-origin', 'new-slot', 'new-own-script', 'new-version', 'cloaking', 'new-inline']);
const NEW_SCRIPT = new Set(['new-origin', 'new-slot', 'new-own-script', 'build-file', 'new-inline']);
const STALE_ALONE_DAYS = 30;

function loadSnapshot(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) {
    return { failure: e.code === 'ENOENT' ? 'no snapshot: the collect job failed or uploaded nothing' : `the snapshot could not be read (${e.message})` };
  }
  try { return { snapshot: validateSnapshot(parseJsonText(text, path)) }; } catch (e) { return { failure: `the snapshot is invalid (${e.message})` }; }
}

function pagesInfo(snapshot, config) {
  const names = new Map(config.pages.map((p) => [`${p.site}${p.path}`, p.name]));
  return snapshot.pages.flatMap((p) => Object.entries(p.profiles).filter(([, r]) => r).map(([profile, r]) => {
    const probes = r.visits.filter((v) => v.probe && v.role !== 'drill');
    return { site: p.site, path: p.path, name: names.get(`${p.site}${p.path}`) ?? p.name, profile, conclusive: r.conclusive, reason: r.reason, probed: probes.length > 0, submitted: probes.length ? probes.some((v) => v.probe.submitted) : null };
  }));
}

async function buildDiffs({ findings, snapshot, outDir, github, workflowFile, runId }) {
  const wanted = findings.filter((f) => DIFF_KINDS.has(f.kind) && snapshot.evidence[f.data?.hash ?? f.data?.template]);
  const diffs = new Map();
  const fulls = [];
  if (!wanted.length) return { diffs, fulls, note: null };
  const prev = github && workflowFile ? await previousEvidence(github, { workflowFile, currentRunId: runId }) : { files: new Map(), urls: new Map(), note: null };
  mkdirSync(join(outDir, 'diffs'), { recursive: true });
  for (const [i, f] of wanted.entries()) {
    const hash = f.data.hash ?? f.data.template;
    let source;
    try { source = readFileSync(join(outDir, snapshot.evidence[hash].file), 'utf8'); } catch { continue; }
    let oldHash = f.data.previousUrl ? prev.urls.get(f.data.previousUrl) ?? null : null;
    if (!oldHash && f.data.url && !NEW_SCRIPT.has(f.kind)) oldHash = prev.urls.get(f.data.url) ?? null;
    if (oldHash === hash) oldHash = null;
    const old = oldHash ? prev.files.get(oldHash)?.toString('utf8') ?? null : null;
    const { issue, full } = renderDiff(old, source);
    diffs.set(f.key, issue);
    fulls.push({ key: f.key, subject: f.subject, full });
    writeFileSync(join(outDir, 'diffs', `${String(i + 1).padStart(3, '0')}-${f.kind}.md`), `${f.key}\n\n${full}\n`);
  }
  return { diffs, fulls, note: prev.note };
}

function openCounts(siteStates, fallback) {
  if (!siteStates.length) return { high: fallback.filter((f) => f.severity === 'high').length, medium: fallback.filter((f) => f.severity === 'medium').length };
  const active = siteStates.flatMap((s) => Object.values(s.findings ?? {})).filter((e) => !e.muted && !e.droppedAt);
  return { high: active.filter((e) => e.severity === 'high').length, medium: active.filter((e) => e.severity === 'medium').length };
}

export async function report({ snapshotPath, outDir = dirname(snapshotPath), config, approved, approvedPath, github, dryRun = false, propose = 'pr', failOn = 'never', workflowFile = null, runId = null, runUrl = null, repoUrl = null, base = 'main', now = Date.now(), resolve, fetchImpl = fetch, summaryPath = process.env.GITHUB_STEP_SUMMARY }) {
  const summary = (text) => { if (summaryPath) try { appendFileSync(summaryPath, text); } catch { /* the summary is a convenience */ } };
  const { snapshot, failure } = loadSnapshot(snapshotPath);
  const status = await readStatus(github);

  if (failure) {
    if (!dryRun) await reconcileStatus(github, { issue: status.issue, previous: status.state, state: status.state, run: { failure, pages: [], startedAt: null, finishedAt: null }, now });
    const failed = { failure, findings: [], held: [], info: [], proposals: [], inconclusive: [], drill: null, notes: [] };
    writeReport(outDir, failed);
    summary(formatSummaryMarkdown(failed));
    return { exitCode: 3, high: 0, medium: 0, inconclusive: 0 };
  }

  const sites = await readSites(github);
  const result = judge({ snapshot, approved, state: status.state, now });
  const observed = observedIndex(snapshot, now);
  const state = result.state;
  const today = isoDate(now);
  const notes = result.info.filter((f) => f.kind === 'note').flatMap((f) => f.reasons);
  const bySite = new Map([...new Set(snapshot.pages.map((p) => p.site))].map((s) => [s, { findings: [], held: [] }]));
  for (const f of result.findings) bySite.get(f.site)?.findings.push(f);
  for (const f of result.held) bySite.get(f.site)?.held.push(f);

  // Domain risk, once a week per site; the last check's findings stand in between.
  for (const [site, group] of bySite) {
    const hosts = domainsToCheck(approved, snapshot, site);
    if (!hosts.length) continue;
    const st = siteState(state, site);
    const r = await checkDomains(hosts, { site, resolve, fetchImpl, prior: { domains: st.domains, domainCheck: st.domainCheck, domainFindings: st.domainFindings }, now });
    Object.assign(st, r.results);
    group.findings.push(...r.findings);
    notes.push(...r.notes);
  }

  const allFindings = [...bySite.values()].flatMap((g) => g.findings);
  const { diffs, fulls, note } = await buildDiffs({ findings: allFindings, snapshot, outDir, github, workflowFile, runId });
  if (note) notes.push(note);

  const openPulls = dryRun ? [] : await github.listPulls({ state: 'open' });
  const hasOpenPr = (site) => Boolean(findApprovalPull(openPulls, site));
  const allProposals = [];
  const prs = {};
  const siteStates = [];
  const conclusiveBySite = new Map();
  for (const p of snapshot.pages) for (const [profile, r] of Object.entries(p.profiles)) if (r?.conclusive) (conclusiveBySite.get(p.site) ?? conclusiveBySite.set(p.site, new Set()).get(p.site)).add(`${p.path}|${profile}`);

  for (const [site, group] of bySite) {
    const st = siteState(state, site);
    const firstRun = !approved.sites[site];
    const proposals = proposalsFor([...group.findings, ...(firstRun ? group.held : [])], approved, { now, headers: { [site]: result.headers[site] ?? {} } });
    // Stale entries ride with other proposals or an open pull request, or go alone once a month.
    const stale = staleProposals({ ...approved, sites: approved.sites[site] ? { [site]: approved.sites[site] } : {} }, state, now);
    if (stale.length && (proposals.length || hasOpenPr(site) || !st.staleAt || daysBetween(st.staleAt, today) >= STALE_ALONE_DAYS)) {
      if (!proposals.length && !hasOpenPr(site)) st.staleAt = today;
      proposals.push(...stale);
    }
    allProposals.push(...proposals);
    if (dryRun) continue;
    const pr = await syncApprovalPr(github, { site, proposals, approvedPath, base, propose });
    prs[site] = pr.prNumber;
    const existing = sites.get(site);
    const siteResult = await reconcileSite(github, {
      site, issue: existing?.issue ?? null, siteState: existing?.state ?? null, findings: group.findings, run: { conclusive: conclusiveBySite.get(site) ?? new Set(), observed }, now, notify: config.notify ?? [],
      links: { runUrl, prUrl: pr.prNumber && repoUrl ? `${repoUrl}/pull/${pr.prNumber}` : null, evidenceUrl: runUrl ? `${runUrl}#artifacts` : null },
      diffs, edits: pr.fallback === 'issue' ? pr.edits : null,
    });
    siteStates.push(siteResult);
  }

  const reportable = allFindings;
  const counts = openCounts(siteStates, reportable);
  const run = { startedAt: snapshot.run.startedAt, finishedAt: snapshot.run.finishedAt, failure: null, pages: pagesInfo(snapshot, config), high: reportable.filter((f) => f.severity === 'high').length, medium: reportable.filter((f) => f.severity === 'medium').length, drill: result.drill && { result: result.drill.result, missed: result.drill.missed } };
  if (!dryRun) await reconcileStatus(github, { issue: status.issue, previous: status.state, state, run, now, notes });

  const out = { ...reportOf({ ...result, findings: reportable }, allProposals), notes };
  writeReport(outDir, out);
  summary(formatSummaryMarkdown(out, { diffs: fulls, prs }));
  const fail = (failOn === 'high' && counts.high > 0) || (failOn === 'medium' && counts.high + counts.medium > 0);
  return { exitCode: fail ? 1 : 0, high: counts.high, medium: counts.medium, inconclusive: result.inconclusive.length };
}
