// A bot challenge instead of the page.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/') {
    return { status: 403, headers: { 'cf-mitigated': 'challenge' }, body: '<!doctype html><title>Just a moment...</title><p>Checking your browser</p>' };
  }
  return baseline.respond(ctx);
}
