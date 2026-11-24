// Test helpers for real-Chrome tests against the demo site.
import { DEMO_HOSTS } from '../fixtures/site/server.js';

// Chrome flags that send *.test to the demo server and treat its origins as secure contexts.
export function demoChromeArgs(port) {
  const origins = DEMO_HOSTS.map((h) => `http://${h}:${port}`).join(',');
  return ['--host-resolver-rules=MAP *.test 127.0.0.1', `--unsafely-treat-insecure-origin-as-secure=${origins}`];
}
