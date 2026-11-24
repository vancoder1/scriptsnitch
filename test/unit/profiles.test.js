import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profileFor, VIEWPORTS } from '../../src/capture/profiles.js';

const fixed = (n) => () => n;

test('the desktop profile hides HeadlessChrome and keeps the real version', () => {
  const p = profileFor('desktop', { chromeVersion: 'HeadlessChrome/157.0.8103.79', platform: 'linux', random: fixed(0) });
  assert.match(p.userAgent, /Chrome\/157\.0\.0\.0/);
  assert.doesNotMatch(p.userAgent, /HeadlessChrome/);
  assert.match(p.userAgent, /X11; Linux x86_64/);
  assert.equal(p.platform, 'Linux x86_64');
  assert.equal(p.mobile, false);
  assert.equal(p.userAgentMetadata.platform, 'Linux');
  assert.deepEqual(p.userAgentMetadata.brands.map((b) => b.brand), ['Google Chrome', 'Chromium', 'Not-A.Brand']);
  assert.equal(p.userAgentMetadata.brands[0].version, '157');
  assert.equal(p.userAgentMetadata.fullVersionList[0].version, '157.0.8103.79');
});

test('the desktop profile follows the host operating system', () => {
  assert.equal(profileFor('desktop', { chromeVersion: 'Chrome/157.0.8103.79', platform: 'win32', random: fixed(0) }).platform, 'Win32');
  assert.equal(profileFor('desktop', { chromeVersion: 'Chrome/157.0.8103.79', platform: 'darwin', random: fixed(0) }).userAgentMetadata.platform, 'macOS');
});

test('the mobile profile agrees with itself', () => {
  const p = profileFor('mobile', { chromeVersion: 'HeadlessChrome/157.0.8103.79', platform: 'linux', random: fixed(0) });
  assert.match(p.userAgent, /Android 14/);
  assert.match(p.userAgent, /Mobile Safari/);
  assert.equal(p.platform, 'Linux armv81');
  assert.equal(p.mobile, true);
  assert.equal(p.hasTouch, true);
  assert.equal(p.maxTouchPoints, 5);
  assert.equal(p.userAgentMetadata.mobile, true);
  assert.equal(p.userAgentMetadata.platform, 'Android');
});

test('viewports come from the lists of common sizes', () => {
  const sizes = new Set();
  for (let i = 0; i < 4; i++) {
    const p = profileFor('mobile', { chromeVersion: 'Chrome/157.0.1.2', platform: 'linux', random: fixed(i / 4) });
    sizes.add(`${p.viewport.width}x${p.viewport.height}`);
    assert.ok(VIEWPORTS.mobile.some(([w, h]) => w === p.viewport.width && h === p.viewport.height));
  }
  assert.equal(sizes.size, 4);
});
