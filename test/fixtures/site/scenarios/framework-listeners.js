// Quiet: a framework root listener and an analytics document listener, approved on the first run.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/login') {
    const body = baseline.pages['/login'](ctx).replace('</main>', `<script src="${ctx.origin('cdn.test')}/framework@4.0.0/framework.min.js"></script></main>`);
    return { headers: baseline.headers, body };
  }
  if (ctx.host === 'cdn.test' && ctx.path === '/framework@4.0.0/framework.min.js') {
    return { body: "document.getElementById('main').addEventListener('input', function root() {});document.addEventListener('click', function track() {});" };
  }
  return baseline.respond(ctx);
}
