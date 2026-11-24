// Attack: a new script tag in the page's HTML, named like a build file.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/login') {
    const body = baseline.pages['/login'](ctx).replace('</head>', '<script src="/assets/pay-Qx7Lm2Np.js"></script></head>');
    return { headers: baseline.headers, body };
  }
  if (ctx.host === 'shop.test' && ctx.path === '/assets/pay-Qx7Lm2Np.js') return { body: 'window.pay = 1;' };
  return baseline.respond(ctx);
}
