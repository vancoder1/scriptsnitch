// A OneTrust-style cookie banner; the marketing tag loads only after "Accept all".
import * as baseline from './baseline.js';

const banner = `<div id="onetrust-banner-sdk" style="position:fixed;bottom:0;left:0;right:0;height:80px;background:#eee">
<p>We use cookies.</p><button id="onetrust-accept-btn-handler">Accept all</button></div>
<script>document.getElementById('onetrust-accept-btn-handler').addEventListener('click', function () {
  document.getElementById('onetrust-banner-sdk').remove();
  var s = document.createElement('script'); s.src = '__CDN__/marketing.js'; document.head.appendChild(s);
});</script>`;

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/') {
    return { headers: baseline.headers, body: baseline.page({ origin: ctx.origin, title: 'Demo shop', body: `<h1>Demo shop</h1>${banner.replace('__CDN__', ctx.origin('cdn.test'))}` }) };
  }
  if (ctx.host === 'cdn.test' && ctx.path === '/marketing.js') return { body: 'window.marketing = true;' };
  return baseline.respond(ctx);
}
