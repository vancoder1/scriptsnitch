import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findChrome, ChromeNotFoundError } from '../../src/chrome/find.js';
import { chromeEnv } from '../../src/chrome/env.js';

const has = (...paths) => (p) => paths.includes(p);

test('chromePath wins over the known paths', () => {
  assert.equal(findChrome({ chromePath: '/opt/my/chrome', platform: 'linux', exists: has('/opt/my/chrome', '/usr/bin/google-chrome') }), '/opt/my/chrome');
});

test('a chromePath that does not exist is an error, not a fallback', () => {
  assert.throws(() => findChrome({ chromePath: '/nope', platform: 'linux', exists: has('/usr/bin/google-chrome') }), ChromeNotFoundError);
});

test('checks the known paths in order for each platform', () => {
  assert.equal(findChrome({ platform: 'linux', exists: has('/opt/google/chrome/chrome', '/usr/bin/chromium') }), '/opt/google/chrome/chrome');
  assert.equal(findChrome({ platform: 'linux', exists: has('/usr/bin/chromium-browser') }), '/usr/bin/chromium-browser');
  assert.equal(findChrome({ platform: 'darwin', exists: has('/Applications/Chromium.app/Contents/MacOS/Chromium') }), '/Applications/Chromium.app/Contents/MacOS/Chromium');
  assert.equal(findChrome({ platform: 'linux', exists: () => false }), null);
});

test('the Windows paths keep their separators', () => {
  // Hand-written literal: a path that lost its backslashes would never exist on disk.
  const seen = [];
  findChrome({ platform: 'win32', exists: (p) => { seen.push(p); return false; } });
  assert.deepEqual(seen, [String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`, String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`]);
});

test('chromeEnv keeps only the allowlist, so no token or secret reaches Chrome', () => {
  const env = { PATH: '/bin', HOME: '/home/r', TMPDIR: '/tmp', LANG: 'C.UTF-8', 'INPUT_GITHUB-TOKEN': 'ghs_x', ACTIONS_RUNTIME_TOKEN: 'rt', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'id', GITHUB_TOKEN: 'g', MY_SECRET: 's', SystemRoot: 'C:/Windows' };
  assert.deepEqual(chromeEnv(env, 'linux'), { PATH: '/bin', HOME: '/home/r', TMPDIR: '/tmp', LANG: 'C.UTF-8' });
  assert.deepEqual(chromeEnv({ Path: 'C:/bin', TEMP: 'C:/t', TMP: 'C:/t', SystemRoot: 'C:/Windows', GITHUB_TOKEN: 'g' }, 'win32'), { Path: 'C:/bin', TEMP: 'C:/t', TMP: 'C:/t', SystemRoot: 'C:/Windows' });
});
