// Quiet: the approved library is loaded on some requests only.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/login' && ctx.hits % 2 === 0) {
    const body = baseline.pages['/login'](ctx).replace(/<script src="[^"]*lib\.min\.js"><\/script>/, '');
    return { headers: baseline.headers, body };
  }
  return baseline.respond(ctx);
}
