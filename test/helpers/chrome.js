// Test helper: the local Chrome, or a skip (a failure when SCRIPTSNITCH_REQUIRE_CHROME=1, as in CI).
import { findChrome } from '../../src/chrome/find.js';

export function requireChrome(t) {
  const exe = findChrome({});
  if (exe) return exe;
  if (process.env.SCRIPTSNITCH_REQUIRE_CHROME === '1') throw new Error('Chrome is required for this test but was not found');
  t.skip('Chrome not installed');
  return null;
}
