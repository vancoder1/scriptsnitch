// Expected Medium: the page upgrades the approved library to a new version.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && baseline.pages[ctx.path]) {
    return { headers: baseline.headers, body: baseline.pages[ctx.path](ctx).replace('/lib@1.2.3/', '/lib@1.3.0/') };
  }
  if (ctx.host === 'cdn.test' && ctx.path === '/lib@1.3.0/lib.min.js') return { body: 'window.lib={version:"1.3.0",ready:!0};' };
  return baseline.respond(ctx);
}
