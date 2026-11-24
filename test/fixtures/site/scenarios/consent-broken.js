// A OneTrust banner whose accept button is missing, so consent cannot be given.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/') {
    return { headers: baseline.headers, body: baseline.page({ origin: ctx.origin, title: 'Demo shop', body: '<h1>Demo shop</h1><div id="onetrust-banner-sdk"><p>We use cookies.</p></div>' }) };
  }
  return baseline.respond(ctx);
}
