// A script loaded with a random cache-busting parameter on every visit.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/') {
    const head = `<script src="${ctx.origin('cdn.test')}/widget.js?cb=${Math.random().toString(36).slice(2)}&id=W1"></script>`;
    return { headers: baseline.headers, body: baseline.page({ origin: ctx.origin, title: 'Demo shop', body: '<h1>Demo shop</h1>', head }) };
  }
  if (ctx.host === 'cdn.test' && ctx.path === '/widget.js') return { body: 'window.widget = 1;' };
  return baseline.respond(ctx);
}
