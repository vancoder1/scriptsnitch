// Quiet: a versioned file served in two approved variants (an A/B test), alternating per request.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'cdn.test' && ctx.path === '/lib@1.2.3/lib.min.js') {
    return { body: ctx.hits % 2 ? 'window.lib={version:"1.2.3",ready:!0,variant:"a"};' : 'window.lib={version:"1.2.3",ready:!0,variant:"b"};' };
  }
  return baseline.respond(ctx);
}
