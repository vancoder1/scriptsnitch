// The status issue (design §12): one issue, `scriptsnitch status`, kept open and rewritten each run.
// Its first visible line says when the last run was, so a stopped schedule is noticed; its marker
// holds the cross-run state (§6). It comments when a page has been inconclusive for three runs or
// recovers, and when the fire drill result changes.
import { readMarker, writeMarker, fitStatusState } from './markers.js';
import { emptyStatusState } from '../state.js';
import { md, code, cellCode } from './text.js';
import { isoDate, isoTime } from '../util/time.js';

export const STATUS_TITLE = 'scriptsnitch status';
export const LABEL = 'scriptsnitch';
const ALERT_STREAK = 3;

export async function readStatus(github) {
  const issues = (await github.listIssues({ labels: LABEL, state: 'all' })).filter((i) => i.title === STATUS_TITLE && readMarker(i.body, 'status'));
  issues.sort((a, b) => Number(a.state === 'open') - Number(b.state === 'open') || a.number - b.number);
  const issue = issues.at(-1) ?? null;
  return { issue, state: issue ? { ...emptyStatusState(), ...readMarker(issue.body, 'status') } : emptyStatusState() };
}

const pageKey = (p) => `${p.site}${p.path}|${p.profile}`;
const label = (p) => `${md(p.name ?? p.path)} (${cellCode(p.path)}, ${md(p.profile)})`;
const lastDrill = (log) => [...log].reverse().find((l) => l[4])?.[4] ?? null;

function duration(run) {
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function render({ state, run, now, notes }) {
  const lines = [`Last run ${isoTime(now)}. If this is more than two days old, scriptsnitch has stopped running.`, ''];
  if (run.failure) lines.push(`**This run failed:** ${md(run.failure)}. Nothing else was changed; the next run tries again.`, '');
  if (run.pages.length) {
    lines.push('| Page | Result | Last conclusive run |', '| --- | --- | --- |');
    for (const p of run.pages) {
      const s = state.pages[pageKey(p)] ?? { lastConclusiveRun: null, inconclusiveStreak: 0 };
      const result = p.conclusive ? `conclusive${p.endedOn ? `, ended on ${cellCode(p.endedOn)}` : ''}` : `inconclusive: ${md(p.reason ?? 'unknown')}${s.inconclusiveStreak > 1 ? ` (${s.inconclusiveStreak} runs in a row)` : ''}`;
      lines.push(`| ${label(p)} | ${result} | ${s.lastConclusiveRun ? `run ${s.lastConclusiveRun}` : 'none yet'} |`);
    }
    if (run.pages.some((p) => p.endedOn)) lines.push('', 'A page that ends on another page is judged where it ended. If that is not the page you meant to watch (an empty cart sends the checkout elsewhere), add `steps` or `expect` to it in the config.');
    lines.push('');
  }
  const lost = run.pages.filter((p) => p.probeLost);
  if (lost.length) lines.push(`The probe could not run on ${lost.map((p) => `${label(p)}: ${md(p.probeLost)}`).join('; ')}. Nothing typed into its forms was checked this run.`, '');
  const typedOnly = run.pages.filter((p) => p.probed && p.submitted === false);
  if (typedOnly.length) lines.push(`The probe filled the form but nothing left it on: ${typedOnly.map(label).join(', ')}. Check the page's steps and fields.`, '');
  if (run.drill) lines.push(`Fire drill: ${run.drill.result === 'pass' ? 'passed' : `**failed**, missed ${run.drill.missed.map(code).join(', ')}`}.`, '');
  if (notes.length) lines.push('Notes:', ...notes.map((n) => `- ${md(n)}`), '');
  const took = duration(run);
  lines.push(`Run ${state.run}${took ? `, took ${took}` : ''}. The run log in this issue's marker goes back to ${state.log[0]?.[0] ?? isoDate(now)}.`);
  return lines.join('\n');
}

function comments({ previous, state, run }) {
  const out = [];
  const stuck = [];
  const recovered = [];
  for (const p of run.pages) {
    const before = previous.pages[pageKey(p)]?.inconclusiveStreak ?? 0;
    const after = state.pages[pageKey(p)]?.inconclusiveStreak ?? 0;
    if (before < ALERT_STREAK && after >= ALERT_STREAK) stuck.push(`- ${label(p)}: ${md(p.reason ?? 'unknown')}`);
    if (before >= ALERT_STREAK && after === 0) recovered.push(`- ${label(p)}`);
  }
  if (stuck.length) out.push(['These pages have been inconclusive for three runs in a row, so nothing on them is being checked:', ...stuck, '', 'A bot challenge or a changed page usually causes this; see the README section on inconclusive pages.'].join('\n'));
  if (recovered.length) out.push(['These pages are conclusive again:', ...recovered].join('\n'));
  if (run.drill && run.drill.result !== lastDrill(previous.log)) {
    out.push(run.drill.result === 'pass'
      ? 'Fire drill passed: scriptsnitch raised every finding the test skimmer should cause.'
      : `Fire drill failed: scriptsnitch missed ${run.drill.missed.map(code).join(', ')} for the test skimmer. Detection is not working as it should; check the collect job's log and the Chrome version.`);
  }
  return out;
}

// Writes the status issue. On a failed run (no or invalid snapshot) the state is left exactly as it
// was; otherwise the run-log line is added and the marker is fitted under GitHub's size limit.
export async function reconcileStatus(github, { issue = null, previous = emptyStatusState(), state, run, now = Date.now(), notes = [] }) {
  let next = previous;
  if (!run.failure) {
    next = structuredClone(state);
    next.log = [...next.log, [isoDate(now), run.pages.filter((p) => p.conclusive).length, run.high ?? 0, run.medium ?? 0, run.drill?.result ?? null]];
    next = fitStatusState(next);
  }
  const body = writeMarker(render({ state: next, run, now, notes }), 'status', next);
  const written = issue
    ? await github.updateIssue(issue.number, { title: STATUS_TITLE, body, state: 'open' })
    : await github.createIssue({ title: STATUS_TITLE, body, labels: [LABEL] });
  if (!run.failure) for (const c of comments({ previous, state: next, run })) await github.createComment(written.number, c);
  return { number: written.number, state: next };
}
