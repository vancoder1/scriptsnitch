// Attack: a script from a new origin added to the page.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/login') {
    const body = baseline.pages['/login'](ctx).replace('</main>', `<script src="${ctx.origin('evil.test')}/x.js"></script></main>`);
    return { headers: baseline.headers, body };
  }
  if (ctx.host === 'evil.test' && ctx.path === '/x.js') return { body: 'window.x = 1;' };
  return baseline.respond(ctx);
}
