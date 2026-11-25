// Entry point of the GitHub Action (action.yml): reads the inputs and runs one mode. Step outputs
// `high`, `medium`, `inconclusive` and `snapshot` go to GITHUB_OUTPUT. Exit codes: 0 fine, 1 findings
// open per fail-on (or a failed validation), 3 an error such as an invalid config or no Chrome.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readOptions, stepSecrets, OptionsError } from './options.js';
import { loadConfig, ConfigError } from './config/config.js';
import { loadApproved, emptyApproved, ApprovedError } from './config/approved.js';
import { findChrome, ChromeNotFoundError } from './chrome/find.js';
import { SandboxError } from './chrome/launch.js';
import { collect } from './modes/collect.js';
import { report } from './modes/report.js';
import { check } from './modes/check.js';
import { validateMode } from './modes/validate.js';
import { handleComment } from './modes/command.js';
import { evidencePack, approvalHistoryFromGit } from './modes/evidence.js';
import { createGitHub, HttpError } from './report/github.js';
import { readStatus } from './report/status-issue.js';
import { formatSummary } from './report/summary.js';
import { emptyStatusState } from './state.js';
import { isoDate } from './util/time.js';

const EXPECTED = [OptionsError, ConfigError, ApprovedError, ChromeNotFoundError, SandboxError];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readEvent(env) {
  try { return env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {}; } catch { return {}; }
}

// Step secrets for the page steps, masked in the job log first. GitHub masks one line per
// ::add-mask::, so a multi-line value is masked line by line.
function maskedStepSecrets(env, log) {
  const secrets = stepSecrets(env);
  for (const value of Object.values(secrets)) {
    for (const line of value.split(/\r?\n/)) if (line.trim()) log.log(`::add-mask::${line}`);
  }
  return secrets;
}

export async function main(env = process.env, { githubFactory = createGitHub, log = console } = {}) {
  const output = (name, value) => { if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`); };
  try {
    const o = readOptions(env);
    const event = readEvent(env);
    const base = event.repository?.default_branch ?? 'main';
    const repoUrl = `${env.GITHUB_SERVER_URL ?? 'https://github.com'}/${o.repo ?? 'OWNER/REPO'}`;
    const runUrl = env.GITHUB_RUN_ID ? `${repoUrl}/actions/runs/${env.GITHUB_RUN_ID}` : null;
    const workflowFile = /\/([^/@]+)@/.exec(env.GITHUB_WORKFLOW_REF ?? '')?.[1] ?? null;
    const github = () => {
      if (!o.token || !o.repo) throw new OptionsError(`mode ${o.mode} needs the github-token input and GITHUB_REPOSITORY`);
      return githubFactory({ token: o.token, repo: o.repo });
    };
    if (o.mode === 'validate') {
      const r = validateMode({ configPath: o.configPath, cwd: o.workspace });
      for (const i of r.issues) log.log(`::${i.level === 'error' ? 'error' : 'warning'}::${i.message}`);
      if (r.ok) log.log('scriptsnitch: the config and the approved file are valid');
      return r.ok ? 0 : r.issues.some((i) => i.fatal) ? 3 : 1;
    }
    const config = loadConfig(o.configPath);
    const approvedPath = config.approved.replace(/\\/g, '/');
    const approved = loadApproved(resolve(o.workspace, approvedPath)) ?? emptyApproved();

    switch (o.mode) {
      case 'collect': {
        const secrets = maskedStepSecrets(env, log);
        if (o.jitter) await sleep(Math.floor(Math.random() * o.jitter * 60000));
        const snapshot = await collect({ config, approved, outDir: o.outDir, executable: findChrome({ chromePath: o.chromePath }), allowNoSandbox: o.allowNoSandbox, drill: o.drill, env: { ...env, ...secrets } });
        const results = snapshot.pages.flatMap((p) => Object.values(p.profiles).filter(Boolean));
        log.log(`scriptsnitch: collected ${snapshot.pages.length} page${snapshot.pages.length === 1 ? '' : 's'}, ${results.filter((r) => !r.conclusive).length} inconclusive`);
        output('snapshot', join(o.outDir, 'snapshot.json'));
        return 0;
      }
      case 'report': {
        const r = await report({ snapshotPath: join(o.outDir, 'snapshot.json'), outDir: o.outDir, config, approved, approvedPath, github: github(), dryRun: o.dryRun, propose: o.propose, failOn: o.failOn, workflowFile, runId: Number(env.GITHUB_RUN_ID) || null, runUrl, repoUrl, base, summaryPath: env.GITHUB_STEP_SUMMARY });
        output('high', r.high);
        output('medium', r.medium);
        output('inconclusive', r.inconclusive);
        log.log(`scriptsnitch: ${r.high} High and ${r.medium} Medium open, ${r.inconclusive} inconclusive${o.dryRun ? ' (dry run: nothing was changed on GitHub)' : ''}`);
        return r.exitCode;
      }
      case 'check': {
        const secrets = maskedStepSecrets(env, log);
        const state = o.token && o.repo ? (await readStatus(github())).state : emptyStatusState();
        const r = await check({ config, approved, outDir: o.outDir, executable: findChrome({ chromePath: o.chromePath }), allowNoSandbox: o.allowNoSandbox, env: { ...env, ...secrets }, state });
        const high = r.report.findings.filter((f) => f.severity === 'high').length;
        const medium = r.report.findings.filter((f) => f.severity === 'medium').length;
        output('high', high);
        output('medium', medium);
        output('inconclusive', r.report.inconclusive.length);
        output('snapshot', join(o.outDir, 'snapshot.json'));
        log.log(formatSummary(r.report));
        return (o.failOn === 'high' && high) || (o.failOn === 'medium' && high + medium) ? 1 : 0;
      }
      case 'command': {
        const r = await handleComment({ event, github: github(), approvedPath, base });
        log.log(`scriptsnitch: comment ${r.action}`);
        return 0;
      }
      case 'evidence': {
        const until = isoDate(Date.now());
        const state = o.token && o.repo ? (await readStatus(github())).state : emptyStatusState();
        let history = [];
        try { history = await approvalHistoryFromGit(approvedPath, { cwd: o.workspace }); } catch (e) { log.log(`::warning::no git history for ${approvedPath}, so approvals are not listed; check out with fetch-depth: 0 (${String(e.message).split('\n')[0]})`); }
        mkdirSync(o.outDir, { recursive: true });
        const file = join(o.outDir, `evidence-${until}.md`);
        writeFileSync(file, evidencePack({ approved, approvalHistory: history, statusState: state, since: isoDate(Date.now() - 365 * 86400000), until, generatedAt: until }));
        log.log(`scriptsnitch: wrote ${file}`);
        return 0;
      }
      default:
        throw new OptionsError(`unknown mode ${o.mode}`);
    }
  } catch (err) {
    if (EXPECTED.some((E) => err instanceof E)) { log.error(`::error::scriptsnitch: ${err.message}`); return 3; }
    if (err instanceof HttpError) { log.error(`::error::scriptsnitch: GitHub answered ${err.message}`); return 3; }
    log.error(`::error::scriptsnitch: unexpected error: ${err.stack ?? err}`);
    return 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
