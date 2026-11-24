// The demo shop with an own path-versioned file, as many older sites have.
import * as baseline from './baseline.js';

export const MODERNIZR = 'window.Modernizr={version:"2.6.2"};';

export function respond(ctx, source = MODERNIZR) {
  if (ctx.host === 'shop.test' && ctx.path === '/login') {
    const body = baseline.pages['/login'](ctx).replace('</head>', '<script src="/js/modernizr-2.6.2.min.js"></script></head>');
    return { headers: baseline.headers, body };
  }
  if (ctx.host === 'shop.test' && ctx.path === '/js/modernizr-2.6.2.min.js') return { body: source };
  return baseline.respond(ctx);
}
