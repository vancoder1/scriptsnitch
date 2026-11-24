// An unapproved script that appears on the first load of the home page only.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/') {
    const head = ctx.hits === 1 ? `<script src="${ctx.origin('evil.test')}/once.js"></script>` : '';
    return { headers: baseline.headers, body: baseline.page({ origin: ctx.origin, title: 'Demo shop', body: '<h1>Demo shop</h1>', head }) };
  }
  if (ctx.host === 'evil.test' && ctx.path === '/once.js') return { body: 'window.once = 1;' };
  return baseline.respond(ctx);
}
