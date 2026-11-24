// Chrome gets only the variables it needs, never the action's own: no input, token or secret
// reaches the process that runs third-party code.
const UNIX = ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG'];
const WINDOWS = ['Path', 'PATH', 'TMP', 'TEMP', 'SystemRoot', 'SYSTEMROOT'];

export function chromeEnv(env, platform = process.platform) {
  const out = {};
  for (const key of platform === 'win32' ? WINDOWS : UNIX) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  return out;
}
