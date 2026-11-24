// report.json and the plain-text summary (design §12). `check` and `report` both write report.json
// through writeReport; `approve --all` and `approve --headers` read it back.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION } from '../version.js';

export const REPORT_FORMAT = 1;

const publicFinding = ({ kind, key, severity, site, page, profiles, subject, reasons, evidence, seenOn, sensitivePages, firstRun, drill }) => ({ kind, key, severity, site, page, profiles, subject, reasons, evidence, seenOn, sensitivePages, firstRun, drill });

export function reportOf(result, proposals) {
  return {
    findings: result.findings.map(publicFinding),
    held: result.held.map(publicFinding),
    info: result.info.map(publicFinding),
    proposals,
    headers: result.headers,
    inconclusive: result.inconclusive,
    drill: result.drill && { result: result.drill.result, missed: result.drill.missed },
  };
}

export function writeReport(outDir, report) {
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, 'report.json');
  writeFileSync(path, `${JSON.stringify({ format: REPORT_FORMAT, tool: VERSION, ...report }, null, 2)}\n`);
  return path;
}

const where = (f) => `${f.seenOn?.length ? f.seenOn.join(', ') : f.page}${f.profiles?.length ? `, ${f.profiles.join('+')}` : ''}`;

export function formatSummary(report) {
  const high = report.findings.filter((f) => f.severity === 'high');
  const medium = report.findings.filter((f) => f.severity === 'medium');
  const lines = [`scriptsnitch: ${high.length} High, ${medium.length} Medium, ${report.inconclusive.length} inconclusive`];
  for (const f of [...high, ...medium]) {
    lines.push(`  ${f.severity.toUpperCase().padEnd(6)} ${f.kind} ${f.subject} (${where(f)})`);
    for (const r of f.reasons) lines.push(`         ${r}`);
  }
  if (report.held.length) lines.push(`  ${report.held.length} Medium seen once, waiting for a second sighting: ${report.held.map((f) => `${f.kind} ${f.subject}`).join('; ')}`);
  for (const i of report.inconclusive) lines.push(`  inconclusive: ${i.page} (${i.profile}): ${i.reason}`);
  if (report.drill) lines.push(`  fire drill: ${report.drill.result}${report.drill.missed.length ? ` (missed ${report.drill.missed.join(', ')})` : ''}`);
  return `${lines.join('\n')}\n`;
}

const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');

// The job summary (GITHUB_STEP_SUMMARY): every finding, Info included, and the full diffs.
export function formatSummaryMarkdown(report, { diffs = [], prs = {} } = {}) {
  const high = report.findings.filter((f) => f.severity === 'high').length;
  const medium = report.findings.filter((f) => f.severity === 'medium').length;
  const lines = [`## scriptsnitch`, '', report.failure ? `**This run failed:** ${cell(report.failure)}` : `${high} High, ${medium} Medium, ${report.inconclusive.length} inconclusive.`, ''];
  const rows = [...report.findings, ...report.held.map((f) => ({ ...f, severity: `${f.severity} (seen once)` })), ...report.info];
  if (rows.length) {
    lines.push('| Severity | Kind | Subject | Where | Why |', '| --- | --- | --- | --- | --- |');
    for (const f of rows) lines.push(`| ${cell(f.severity)} | ${cell(f.kind)} | \`${cell(f.subject).replace(/`/g, "'")}\` | ${cell((f.seenOn?.length ? f.seenOn : [f.page]).join(', '))} | ${cell(f.reasons.join('; '))} |`);
    lines.push('');
  }
  for (const i of report.inconclusive) lines.push(`- Inconclusive: \`${cell(i.page)}\` (${i.profile}): ${cell(i.reason)}`);
  if (report.drill) lines.push(`- Fire drill: ${report.drill.result}${report.drill.missed.length ? `, missed ${report.drill.missed.join(', ')}` : ''}`);
  for (const [site, n] of Object.entries(prs)) if (n) lines.push(`- Approval pull request for ${cell(site)}: #${n}`);
  for (const n of report.notes ?? []) lines.push(`- Note: ${cell(n)}`);
  for (const d of diffs) lines.push('', `<details><summary>${cell(d.subject)}</summary>`, '', d.full, '', '</details>');
  return `${lines.join('\n')}\n`;
}
