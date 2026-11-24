// `scriptsnitch validate` (design §9 "Validation", §14): the config and the approved file are
// checked strictly; a live entry with a TODO reason fails when requireReasons is on, so a required
// check can enforce the PCI DSS 6.4.3 justification. Pending entries never fail it.
import { resolve } from 'node:path';
import { loadConfig, ConfigError } from '../config/config.js';
import { loadApproved, emptyApproved, validateApproved, todoReasons, siteSection, ApprovedError } from '../config/approved.js';
import { approvedOwnEntries } from '../analyze/approval.js';
import { ownOrigins } from '../analyze/hosts.js';

export function validateMode({ configPath, approvedPath = null, cwd = process.cwd() }) {
  let config;
  try { config = loadConfig(configPath); } catch (e) {
    if (e instanceof ConfigError) return { ok: false, issues: [{ level: 'error', message: e.message }] };
    throw e;
  }
  const path = approvedPath ?? resolve(cwd, config.approved);
  let approved;
  try { approved = loadApproved(path) ?? emptyApproved(); } catch (e) {
    if (e instanceof ApprovedError) return { ok: false, issues: [{ level: 'error', message: e.message }] };
    throw e;
  }
  const issues = validateApproved(approved).map((i) => ({ level: i.level, message: `${path} ${i.pointer || '/'}: ${i.message}` }));
  if (config.requireReasons) {
    for (const t of todoReasons(approved)) {
      issues.push({ level: 'error', message: `${t.site}: the ${t.section} entry "${t.id}" still has a TODO reason. Write why the page needs it (PCI DSS 6.4.3), or set requireReasons to false.` });
    }
  }
  for (const page of config.pages) {
    if (page.expect) continue;
    const section = siteSection(approved, page.site);
    if (approvedOwnEntries(section, ownOrigins(page.site, section), page.path, page.sensitive).length) continue;
    issues.push({ level: 'warning', message: `${page.site}${page.path} has no "expect" and no approved own script, so nothing tells its error page apart from the real one. Add "expect": {"selector": "…"} to the page.` });
  }
  return { ok: !issues.some((i) => i.level === 'error'), issues };
}
