// A page whose renderer stops answering after it loads: a busy loop that never yields.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/') {
    return { headers: baseline.headers, body: baseline.pages['/'](ctx).replace('</body>', '<script>setTimeout(function () { for (;;) {} }, 300);</script></body>') };
  }
  return baseline.respond(ctx);
}
