// Attack: the site's own hashed bundle changed in place (same build token, new content).
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === `/assets/${baseline.ENTRY}`) {
    const original = baseline.assets['shop.test'][`/assets/${baseline.ENTRY}`]();
    return { body: `${original}\nwindow.extra = 1;` };
  }
  return baseline.respond(ctx);
}
