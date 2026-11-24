// The command line (design §14): `node bin/scriptsnitch.js <command>`, from a clone. Stateless: it
// reads no GitHub state and never writes to GitHub. Exit codes: 0 nothing unapproved, 1 High or
// Medium findings, 2 no findings but some page inconclusive, 3 error.
import { resolve, join } from 'node:path';
import { loadConfig, ConfigError } from './config/config.js';
import { loadApproved, emptyApproved, ApprovedError, UnknownPendingError } from './config/approved.js';
import { findChrome, ChromeNotFoundError } from './chrome/find.js';
import { SandboxError } from './chrome/launch.js';
import { collect } from './modes/collect.js';
import { check } from './modes/check.js';
import { validateMode } from './modes/validate.js';
import { approveMode } from './modes/approve.js';
import { scan, init, formatInventory, InitError } from './modes/scan.js';
import { formatSummary } from './report/summary.js';
import { VERSION } from './version.js';

export const USAGE = `Usage: scriptsnitch <command> [options]

Commands:
  scan <url> [--probe] [--json]   One-off inventory of one page, no setup needed
  init <url...> [--force]         Write a starter config and a first approved file
  check                           Collect and judge now; exit 1 on unapproved findings
  collect [--drill]               Collect a snapshot into the out directory
  validate                        Check the config and the approved file
  approve --id <key> [--reason <text>] | --all | --headers
                                  Edit the approved file: move one pending item, add every
                                  routine proposal of the last check, or adopt current headers

Options:
  --config <path>      Config file (default scriptsnitch/config.json)
  --out <dir>          Output directory (default scriptsnitch-out)
  --chrome <path>      Chrome or Chromium executable (default: found automatically)
  --allow-no-sandbox   Run Chrome without its sandbox, only where the sandbox cannot work
  --version            Print the version

Exit codes: 0 nothing unapproved, 1 High or Medium findings, 2 some page inconclusive, 3 error.
`;

const VALUE_FLAGS = new Set(['config', 'out', 'chrome', 'id', 'reason']);
const BOOL_FLAGS = new Set(['probe', 'json', 'all', 'headers', 'force', 'drill', 'allow-no-sandbox', 'help', 'version']);

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      flags[name] = value;
    } else if (BOOL_FLAGS.has(name)) flags[name] = true;
    else throw new UsageError(`unknown option --${name}`);
  }
  return { command: positional[0], args: positional.slice(1), flags };
}

const EXPECTED = [ConfigError, ApprovedError, UnknownPendingError, ChromeNotFoundError, SandboxError, InitError, UsageError];

export async function runCli(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env, cwd = process.cwd(), extraArgs = [] } = {}) {
  const print = (s) => stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  try {
    const { command, args, flags } = parseArgs(argv);
    if (flags.version) { print(VERSION); return 0; }
    if (!command || flags.help) { (command || flags.help ? stdout : stderr).write(USAGE); return command || flags.help ? 0 : 3; }
    const configPath = resolve(cwd, flags.config ?? 'scriptsnitch/config.json');
    const outDir = resolve(cwd, flags.out ?? 'scriptsnitch-out');
    const browserOptions = () => ({ executable: findChrome({ chromePath: flags.chrome }), allowNoSandbox: Boolean(flags['allow-no-sandbox']), extraArgs, env });
    const loaded = () => {
      const config = loadConfig(configPath);
      const approvedPath = resolve(cwd, config.approved);
      return { config, approvedPath, approved: loadApproved(approvedPath) ?? emptyApproved() };
    };

    switch (command) {
      case 'scan': {
        if (args.length !== 1) throw new UsageError('scan takes one URL');
        const inventory = await scan(args[0], { ...browserOptions(), probe: Boolean(flags.probe) });
        print(flags.json ? JSON.stringify(inventory, null, 2) : formatInventory(inventory));
        return inventory.conclusive ? 0 : 2;
      }
      case 'init': {
        if (!args.length) throw new UsageError('init takes one or more URLs');
        const r = await init(args, { ...browserOptions(), cwd, force: Boolean(flags.force) });
        print(`Wrote ${r.configPath} (${r.pages.length} pages: ${r.pages.map((p) => `${p.name}${p.sensitive ? ' [sensitive]' : ''}`).join(', ')})`);
        print(`Wrote ${r.approvedPath}: everything seen today, ${r.pending} item${r.pending === 1 ? '' : 's'} pending your review. It is only as clean as the site is today; read it before you commit it.`);
        return 0;
      }
      case 'check': {
        const { config, approved } = loaded();
        const r = await check({ config, approved, outDir, ...browserOptions() });
        print(formatSummary(r.report));
        return r.exitCode;
      }
      case 'collect': {
        const { config, approved } = loaded();
        await collect({ config, approved, outDir, drill: Boolean(flags.drill), ...browserOptions() });
        print(`Wrote ${join(outDir, 'snapshot.json')}`);
        return 0;
      }
      case 'validate': {
        const r = validateMode({ configPath, cwd });
        for (const i of r.issues) print(`${i.level}: ${i.message}`);
        if (r.ok) print('scriptsnitch: config and approved file are valid');
        return r.ok ? 0 : r.issues.some((i) => i.fatal) ? 3 : 1;
      }
      case 'approve': {
        if (!flags.id && !flags.all && !flags.headers) throw new UsageError('approve needs --id <key>, --all or --headers');
        const { approvedPath } = loaded();
        approveMode({ approvedPath, reportPath: join(outDir, 'report.json'), id: flags.id ?? null, all: Boolean(flags.all), headers: Boolean(flags.headers), reason: flags.reason ?? null });
        print(`Updated ${approvedPath}`);
        return 0;
      }
      default:
        throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    if (EXPECTED.some((E) => err instanceof E)) {
      stderr.write(`scriptsnitch: ${err.message}\n`);
      if (err instanceof UsageError) stderr.write(`\n${USAGE}`);
      return 3;
    }
    stderr.write(`scriptsnitch: unexpected error: ${err.stack ?? err}\n`);
    return 3;
  }
}
