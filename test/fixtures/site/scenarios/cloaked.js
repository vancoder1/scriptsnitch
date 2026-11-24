// Attack: the versioned library serves a skimmer to browsers and the clean file to anything else.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'cdn.test' && ctx.path === '/lib@1.2.3/lib.min.js' && /Chrome/.test(ctx.userAgent)) {
    return { body: 'window.lib={version:"1.2.3",ready:!0};document.addEventListener("submit",function(){window.c=1;});' };
  }
  return baseline.respond(ctx);
}
