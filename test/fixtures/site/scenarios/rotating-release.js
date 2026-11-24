// Quiet: an approved loader that injects a release file whose path changes on every request.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/') {
    const head = `<script src="${ctx.origin('tags.test')}/captcha/api.js"></script>`;
    return { headers: baseline.headers, body: baseline.page({ origin: ctx.origin, title: 'Demo shop', body: '<h1>Demo shop</h1>', head }) };
  }
  if (ctx.host === 'tags.test' && ctx.path === '/captcha/api.js') {
    const release = Math.random().toString(36).slice(2, 10);
    return { body: `(function(){var s=document.createElement('script');s.src='${ctx.origin('tags.test')}/captcha/releases/${release}/captcha.js';document.head.appendChild(s);})();` };
  }
  if (ctx.host === 'tags.test' && ctx.path.startsWith('/captcha/releases/')) return { body: `window.captcha = '${ctx.path}';` };
  return baseline.respond(ctx);
}
