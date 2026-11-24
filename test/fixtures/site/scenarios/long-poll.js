// The demo shop with a request the server never answers, like a long-polling chat widget.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/') {
    return { headers: baseline.headers, body: baseline.page({ origin: ctx.origin, title: 'Demo shop', body: '<h1>Demo shop</h1>', head: '<script>fetch("/poll");</script>' }) };
  }
  if (ctx.host === 'shop.test' && ctx.path === '/poll') return { hold: true };
  return baseline.respond(ctx);
}
