// Starts Chrome with its debugging pipe on fds 3 and 4, sandbox on, an allowlisted environment
// and a throwaway profile directory.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from './cdp.js';
import { chromeEnv } from './env.js';

export class SandboxError extends Error {
  constructor(details) {
    super(`Chrome could not start its sandbox. On Linux this usually means unprivileged user namespaces are restricted; set the allow-no-sandbox input only if you accept running pages without it.\n${details}`);
    this.name = 'SandboxError';
  }
}

export const CHROME_FLAGS = [
  '--headless',
  '--remote-debugging-pipe',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-sync',
  '--disable-extensions',
  '--disable-component-extensions-with-background-pages',
  '--disable-blink-features=AutomationControlled',
  '--mute-audio',
];

function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
  }
}

function removeDir(dir) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { /* Chrome may still hold files briefly */ }
  }
}

export async function launchChrome({ executable, allowNoSandbox = false, extraArgs = [], timeoutMs = 30000 }) {
  const userDataDir = mkdtempSync(join(tmpdir(), 'scriptsnitch-'));
  const args = [...CHROME_FLAGS, `--user-data-dir=${userDataDir}`, ...(allowNoSandbox ? ['--no-sandbox'] : []), ...extraArgs, 'about:blank'];
  const child = spawn(executable, args, {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    env: chromeEnv(process.env),
    detached: process.platform !== 'win32',
  });
  let stderr = '';
  child.stdio[2].on('data', (d) => { if (stderr.length < 20000) stderr += d; });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const conn = createConnection({ input: child.stdio[4], output: child.stdio[3], timeoutMs });

  let version;
  try {
    version = await Promise.race([
      conn.send('Browser.getVersion').then((v) => v.product),
      exited.then(() => { throw new Error(`Chrome exited during start-up:\n${stderr.slice(0, 4000)}`); }),
    ]);
  } catch (err) {
    killTree(child);
    removeDir(userDataDir);
    if (/No usable sandbox/i.test(stderr)) throw new SandboxError(stderr.slice(0, 4000));
    throw err;
  }

  let closing;
  const close = () => {
    closing ??= (async () => {
      await Promise.race([conn.send('Browser.close').catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
      killTree(child);
      // The exit event can lag behind a killed tree on a busy machine; close means closed.
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
      conn.close();
      removeDir(userDataDir);
    })();
    return closing;
  };

  return { conn, version, process: child, close, stderr: () => stderr };
}
