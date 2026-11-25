// A cross-origin iframe that sends a request of its own and is removed right after, long before the
// visit looks at what it recorded: its request is the frame's, never the top page's.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/login') {
    const add = `<script>var f = document.createElement('iframe'); f.src = '${ctx.origin('pay.test')}/beacon'; document.body.appendChild(f); window.addEventListener('message', function (e) { if (e.data === 'sent') f.remove(); });</script>`;
    return { headers: baseline.headers, body: baseline.pages['/login'](ctx).replace('</main>', `${add}</main>`) };
  }
  if (ctx.host === 'pay.test' && ctx.path === '/beacon') {
    return { body: "<!doctype html><script>fetch('/collect?from=frame').then(function () { parent.postMessage('sent', '*'); });</script>" };
  }
  if (ctx.host === 'pay.test' && ctx.path === '/collect') return { status: 204, body: '' };
  return baseline.respond(ctx);
}
