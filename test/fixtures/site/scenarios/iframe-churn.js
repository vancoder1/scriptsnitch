// A sign-in page that adds a cross-origin iframe and removes it again before the probe types: the
// probe must still run.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/login') {
    const churn = `<script>var f = document.createElement('iframe'); f.src = '${ctx.origin('pay.test')}/card'; document.body.appendChild(f); setTimeout(function () { f.remove(); }, 400);</script>`;
    return { headers: baseline.headers, body: baseline.pages['/login'](ctx).replace('</main>', `${churn}</main>`) };
  }
  return baseline.respond(ctx);
}
