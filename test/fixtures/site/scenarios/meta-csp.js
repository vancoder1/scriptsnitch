// A strict Content-Security-Policy set in a <meta> tag rather than a header: the fire drill's test
// skimmer must still run, inside the drill visit only.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/login') {
    const meta = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' ${ctx.origin('cdn.test')} ${ctx.origin('tags.test')} 'unsafe-inline'">`;
    return { headers: baseline.headers, body: baseline.pages['/login'](ctx).replace('<head>', `<head>${meta}`) };
  }
  return baseline.respond(ctx);
}
