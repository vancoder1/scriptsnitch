// The action's inputs (design §14). The runner passes each input as INPUT_<NAME>, upper-cased with
// hyphens kept. Relative paths resolve against the workspace (the checked-out repository). Modes
// that never talk to GitHub drop the token from the environment before anything else runs.
import { isAbsolute, resolve } from 'node:path';

export const MODES = ['collect', 'report', 'validate', 'command', 'evidence', 'check'];
const TOKEN_MODES = new Set(['report', 'command', 'evidence', 'check']);

export class OptionsError extends Error {
  constructor(message) { super(message); this.name = 'OptionsError'; }
}

export function readOptions(env = process.env) {
  const input = (name) => env[`INPUT_${name.toUpperCase()}`]?.trim() || undefined;
  const mode = input('mode');
  if (!mode) throw new OptionsError(`the mode input is required: one of ${MODES.join(', ')}`);
  if (!MODES.includes(mode)) throw new OptionsError(`unknown mode "${mode}"; use one of ${MODES.join(', ')}`);
  let token = null;
  if (TOKEN_MODES.has(mode)) token = input('github-token') ?? env.GITHUB_TOKEN ?? null;
  else {
    delete env['INPUT_GITHUB-TOKEN'];
    delete env.GITHUB_TOKEN;
  }
  const bool = (name) => {
    const v = input(name);
    if (v === undefined || /^false$/i.test(v)) return false;
    if (/^true$/i.test(v)) return true;
    throw new OptionsError(`the input ${name} must be true or false, not "${v}"`);
  };
  const choice = (name, allowed) => {
    const v = input(name) ?? allowed[0];
    if (!allowed.includes(v)) throw new OptionsError(`the input ${name} must be one of ${allowed.join(', ')}, not "${v}"`);
    return v;
  };
  const jitterText = input('jitter') ?? '0';
  const jitter = Number(jitterText);
  if (!/^\d+$/.test(jitterText) || jitter > 60) throw new OptionsError(`the input jitter is a number of minutes from 0 to 60, not "${jitterText}"`);
  const workspace = env.GITHUB_WORKSPACE || process.cwd();
  const at = (p) => (isAbsolute(p) ? p : resolve(workspace, p));
  return {
    mode,
    token,
    repo: env.GITHUB_REPOSITORY ?? null,
    workspace,
    configPath: at(input('config') ?? 'scriptsnitch/config.json'),
    outDir: at(input('out') ?? 'scriptsnitch-out'),
    drill: bool('drill'),
    dryRun: bool('dry-run'),
    allowNoSandbox: bool('allow-no-sandbox'),
    propose: choice('propose', ['pr', 'issue']),
    failOn: choice('fail-on', ['never', 'medium', 'high']),
    chromePath: input('chrome-path') ?? null,
    jitter,
  };
}

// Step secrets arrive as one JSON object (the reusable workflow's `step-secrets` secret) and become
// environment variables for the collect step's page steps only.
export function stepSecrets(env = process.env) {
  const text = env.SCRIPTSNITCH_STEP_SECRETS;
  if (!text) return {};
  let value;
  try { value = JSON.parse(text); } catch { value = null; }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((v) => typeof v !== 'string')) {
    throw new OptionsError('SCRIPTSNITCH_STEP_SECRETS must be a JSON object of strings, such as {"SHOP_PASSWORD": "…"}');
  }
  return value;
}
