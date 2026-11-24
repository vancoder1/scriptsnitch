// Test helpers for real-Chrome tests against the demo site.
import { DEMO_HOSTS } from '../fixtures/site/server.js';

// Chrome flags that send *.test (and the real tag-manager host, whose account keys scriptsnitch
// knows) to the demo server and treat its origins as secure contexts.
export function demoChromeArgs(port) {
  const origins = DEMO_HOSTS.map((h) => `http://${h}:${port}`).join(',');
  return ['--host-resolver-rules=MAP *.test 127.0.0.1, MAP www.googletagmanager.com 127.0.0.1', `--unsafely-treat-insecure-origin-as-secure=${origins}`];
}
