// The home page redirects to a locale prefix on the same origin.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/') return { status: 302, headers: { location: '/en/' }, body: '' };
  if (ctx.host === 'shop.test' && ctx.path === '/en/') return { headers: baseline.headers, body: baseline.page({ origin: ctx.origin, title: 'Demo shop', body: '<h1>Demo shop (en)</h1>' }) };
  return baseline.respond(ctx);
}
