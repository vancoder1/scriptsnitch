// Approving by comment (design §12): `/scriptsnitch approve <finding key> because <reason>` on a site
// issue approves exactly one finding without a local clone, and `/scriptsnitch mute <finding key>`
// mutes one. The approval lands on the site's approval branch; merging that pull request remains the
// approval of record, so branch protection still applies. Comment text is untrusted input and is
// only ever shown back through the escaping helpers.
import { readMarker, writeMarker } from '../report/markers.js';
import { md, code } from '../report/text.js';
import { parseApproved, emptyApproved, serializeApproved, approvePending, siteSection } from '../config/approved.js';
import { startBranch, prTitle, findApprovalPull, keyDigest, ENABLE_PULL_REQUESTS } from '../report/pr.js';
import { LABEL } from '../report/status-issue.js';
import { HttpError } from '../report/github.js';

const WRITE = new Set(['admin', 'maintain', 'write']);
const USAGE = 'I understand `/scriptsnitch approve <finding key> because <reason>` and `/scriptsnitch mute <finding key>`, one finding per comment. The finding keys are listed in this issue.';
const APPROVE = /^\/scriptsnitch[ \t]+approve[ \t]+(\S+)(?:[ \t]+because\b([\s\S]*))?$/;
const MUTE = /^\/scriptsnitch[ \t]+mute[ \t]+(\S+)[ \t]*$/;
const NOT_PERMITTED = /not permitted to create or approve pull requests/i;

export async function handleComment({ event, github, approvedPath, botLogin = 'github-actions[bot]', base = 'main' }) {
  const { action, comment, issue } = event ?? {};
  if (action !== 'created' || !comment || !issue || issue.pull_request) return { action: 'ignored' };
  const user = comment.user ?? {};
  if (user.type === 'Bot' || /\[bot\]$/.test(user.login ?? '') || user.login === botLogin) return { action: 'ignored' };
  const body = String(comment.body ?? '').trim();
  if (!/^\/scriptsnitch\b/.test(body)) return { action: 'ignored' };
  if (!(issue.labels ?? []).some((l) => (l?.name ?? l) === LABEL)) return { action: 'ignored' };
  const current = await github.getIssue(issue.number);
  const state = readMarker(current.body, 'site');
  if (!state?.site) return { action: 'ignored' };
  const site = state.site;
  const respond = async (text, result) => {
    await github.createComment(issue.number, text);
    return { action: result, reply: text };
  };

  if (!WRITE.has(await github.getPermission(user.login))) return respond('Only people with write access to this repository can approve or mute findings.', 'refused');
  const approve = APPROVE.exec(body);
  const mute = MUTE.exec(body);
  if (!approve && !mute) return respond(USAGE, 'refused');
  const key = (approve ?? mute)[1];
  const tracked = state.findings?.[key];
  if (!tracked || tracked.droppedAt) return respond(`${code(key)} is not an open finding in this issue. ${USAGE}`, 'refused');

  if (mute) {
    tracked.muted = true;
    await github.updateIssue(issue.number, { body: writeMarker(current.body, 'site', state) });
    return respond(`Muted ${code(key)}. It stays listed under Muted and raises nothing until something new appears.`, 'muted');
  }

  const reason = String(approve[2] ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!reason || /^TODO\b/i.test(reason)) return respond(`Say why the page needs it: ${code('/scriptsnitch approve <finding key> because <reason>')}. The reason is the record PCI DSS 6.4.3 asks for.`, 'refused');

  // The pending item lives in the open approval pull request's file, or on main once that merged.
  const open = findApprovalPull(await github.listPulls({ state: 'open' }), site);
  const file = await github.getContent(approvedPath, open?.head.ref ?? base);
  const approved = file ? parseApproved(file.text, approvedPath) : emptyApproved();
  if (!siteSection(approved, site).pending.some((p) => p.finding === key)) {
    if (open && (readMarker(open.body, 'pr').keys ?? []).includes(keyDigest(key))) return respond(`${code(key)} is a routine proposal in #${open.number}: merging that pull request approves it. Write its reason there in place of the TODO.`, 'refused');
    return respond(`There is no pending proposal for ${code(key)} yet; the next scheduled run proposes it. Try again after that run.`, 'refused');
  }

  const target = open?.head.ref ?? (await startBranch(github, { site, base }));
  try {
    await github.putContent(approvedPath, { text: serializeApproved(approvePending(approved, site, key, reason)), sha: file?.sha, branch: target, message: `scriptsnitch: approve ${key} (requested by ${user.login})` });
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) return respond(`The approval branch changed while this was being written. Comment again to retry.`, 'refused');
    throw e;
  }
  let number = open?.number;
  if (!number) {
    try {
      number = (await github.createPull({ title: prTitle(site), head: target, base, body: writeMarker(`Approves ${code(key)}, as requested in #${issue.number} with the reason: ${md(reason)}.\n\nMerging this pull request is the approval of record.`, 'pr', { v: 1, site, keys: [keyDigest(key)], deferred: [] }) })).number;
    } catch (e) {
      if (e instanceof HttpError && e.status === 403 && NOT_PERMITTED.test(`${e.body} ${e.message}`)) return respond(`Approved ${code(key)} on the branch ${code(target)}, but no pull request could be opened. ${ENABLE_PULL_REQUESTS} Or open one from that branch by hand.`, 'approved');
      throw e;
    }
  }
  return respond(`Approved ${code(key)} in #${number} with the reason: ${md(reason)}. Merging that pull request is the approval of record.`, 'approved');
}
