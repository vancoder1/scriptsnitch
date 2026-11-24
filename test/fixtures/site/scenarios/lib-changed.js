// Attack: the approved versioned third-party file now serves different content.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'cdn.test' && ctx.path === '/lib@1.2.3/lib.min.js') return { body: 'window.lib={version:"1.2.3",ready:!0};document.addEventListener("submit",function(){window.s=1;});' };
  return baseline.respond(ctx);
}
