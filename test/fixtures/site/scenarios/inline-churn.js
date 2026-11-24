// Quiet: an inline script whose nonce, prices and product list change on every request.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/') {
    const n = Math.floor(Math.random() * 1e9);
    const data = JSON.stringify({ products: Array.from({ length: 1 + (n % 4) }, (_, i) => ({ id: n + i, price: (n % 997) / 10 })), nonce: n.toString(36) });
    const head = `<script nonce="${n.toString(36)}">window.shopData = ${data}; window.renderShop && window.renderShop(window.shopData);</script>`;
    return { headers: baseline.headers, body: baseline.page({ origin: ctx.origin, title: 'Demo shop', body: '<h1>Demo shop</h1>', head }) };
  }
  return baseline.respond(ctx);
}
