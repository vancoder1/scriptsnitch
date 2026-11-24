import { test } from 'node:test';
import assert from 'node:assert/strict';
import { launchChrome } from '../../src/chrome/launch.js';
import { requireChrome } from '../helpers/chrome.js';

test('launches Chrome over a pipe, reports its version and closes it', async (t) => {
  const executable = requireChrome(t);
  if (!executable) return;
  const chrome = await launchChrome({ executable });
  assert.match(chrome.version, /^(Headless)?Chrome\/\d+/);
  const { product } = await chrome.conn.send('Browser.getVersion');
  assert.equal(product.split('/')[1].split('.')[0], chrome.version.split('/')[1].split('.')[0]);
  await chrome.close();
  assert.equal(chrome.process.exitCode !== null || chrome.process.signalCode !== null, true);
});
