// `check` (design §14): collect and judge in one go. Stateless: no deploy evidence except a
// deployMarker and the chunk map, and Medium findings are confirmed only within the run. Never
// writes to GitHub. Exit code: 1 findings, 2 none but some page inconclusive, 0 otherwise.
import { collect } from './collect.js';
import { judge } from '../analyze/judge.js';
import { proposalsFor } from '../analyze/proposals.js';
import { emptyStatusState } from '../state.js';
import { reportOf, writeReport } from '../report/summary.js';

export async function check({ config, approved, outDir, executable, allowNoSandbox = false, env = process.env, now = Date.now, extraArgs = [], fetchImpl = fetch, state = emptyStatusState() }) {
  const snapshot = await collect({ config, approved, outDir, executable, allowNoSandbox, env, now, extraArgs, fetchImpl });
  const result = judge({ snapshot, approved, state, now: now() });
  // On a site's first run the whole inventory is proposed, Medium findings seen once included.
  const proposals = proposalsFor([...result.findings, ...result.held.filter((f) => f.firstRun)], approved, { now: now(), headers: result.headers });
  const report = reportOf(result, proposals);
  writeReport(outDir, report);
  const exitCode = result.findings.length ? 1 : result.inconclusive.length ? 2 : 0;
  return { exitCode, report, state: result.state };
}
