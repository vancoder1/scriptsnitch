// `scriptsnitch approve` (design §9 "Pending", §14): `--id <finding key>` moves one pending item into
// the live sections; `--all` applies the routine proposals of the last report (pending ones are added
// to `pending`, never approved); `--headers` adopts the headers the last report observed.
import { readFileSync, writeFileSync } from 'node:fs';
import { loadApproved, emptyApproved, serializeApproved, approvePending, replaceHeaders, siteSection, UnknownPendingError } from '../config/approved.js';
import { applyProposals, headerBaseline } from '../analyze/proposals.js';
import { parseJsonText } from '../util/json.js';

export function approveMode({ approvedPath, reportPath, id = null, all = false, headers = false, reason = null }) {
  let approved = loadApproved(approvedPath) ?? emptyApproved();
  if (id) {
    const site = Object.keys(approved.sites).find((s) => siteSection(approved, s).pending.some((p) => p.finding === id));
    if (!site) throw new UnknownPendingError(id);
    const item = siteSection(approved, site).pending.find((p) => p.finding === id);
    approved = approvePending(approved, site, id, reason ?? item.entry?.reason ?? null);
  }
  if (all || headers) {
    const report = parseJsonText(readFileSync(reportPath, 'utf8'), reportPath);
    if (all) {
      const sites = [...new Set((report.proposals ?? []).map((p) => p.site))];
      for (const site of sites) approved = applyProposals(approved, site, report.proposals.filter((p) => p.site === site));
    }
    if (headers) {
      for (const [site, byPath] of Object.entries(report.headers ?? {})) approved = replaceHeaders(approved, site, headerBaseline(byPath));
    }
  }
  writeFileSync(approvedPath, serializeApproved(approved));
  return approved;
}
