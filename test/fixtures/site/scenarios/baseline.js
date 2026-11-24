// The demo shop as it normally is. Other scenarios import page() and assets and change one thing.
export const ENTRY = 'index-B7kQ0aRz.js';
export const CHUNK = 'chunk-Dq9Wn3Lp.js';

export const headers = { 'x-frame-options': 'DENY', 'strict-transport-security': 'max-age=31536000' };

export function page({ origin, title, body, head = '' }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<script src="/assets/${ENTRY}"></script>
<script src="${origin('cdn.test')}/lib@1.2.3/lib.min.js"></script>
<script src="${origin('tags.test')}/gtm.js?id=GTM-DEMO"></script>
<script>window.siteConfig = {"theme":"light","currency":"CAD"};</script>
${head}</head><body><main id="main">${body}</main></body></html>`;
}

export const pages = {
  '/': ({ origin }) => page({ origin, title: 'Demo shop', body: '<h1>Demo shop</h1><a href="/login">Sign in</a> <a href="/product/1">Shirt</a> <a href="/checkout">Checkout</a>' }),
  '/login': ({ origin }) => page({ origin, title: 'Sign in', body: '<form id="login" method="post" action="/login"><input type="email" name="email" id="email" required><input type="password" name="password" id="password" required><button type="submit" id="go">Sign in</button></form>' }),
  '/product/1': ({ origin }) => page({ origin, title: 'Shirt', body: '<h1>Shirt</h1><script>window.productPageOnly = true;</script><button id="add-to-cart" onclick="document.cookie=\'cart=1;path=/\'">Add to cart</button>' }),
  '/checkout': ({ origin }) => page({ origin, title: 'Checkout', body: `<h1>Checkout</h1><div id="payment"><iframe id="card-frame" src="${origin('pay.test')}/card"></iframe></div>` }),
};

export const assets = {
  'shop.test': {
    [`/assets/${ENTRY}`]: () => `var __chunks = {"${CHUNK.replace('chunk-', '').replace('.js', '')}": "chunk"};
fetch('/api/ping');
setTimeout(function () { var s = document.createElement('script'); s.src = '/assets/${CHUNK}'; document.head.appendChild(s); }, 20);`,
    [`/assets/${CHUNK}`]: () => 'window.chunkLoaded = true;',
    '/api/ping': () => ({ type: 'application/json', body: '{"ok":true}' }),
  },
  'cdn.test': { '/lib@1.2.3/lib.min.js': () => 'window.lib={version:"1.2.3",ready:!0};' },
  'tags.test': {
    '/gtm.js': () => "(function(){var s=document.createElement('script');s.text='window.dataLayer=window.dataLayer||[];window.dataLayer.push({event:\"pageview\"});';document.head.appendChild(s);})();",
  },
  'pay.test': {
    '/card': () => '<!doctype html><html><body><form><input autocomplete="cc-number" name="cardnumber" id="cardnumber"><input autocomplete="cc-exp" name="exp"></form><script>window.payReady = true;</script></body></html>',
  },
};

export function respond(ctx) {
  const { host, path } = ctx;
  if (host === 'shop.test' && pages[path]) return { headers, body: pages[path](ctx) };
  const asset = assets[host]?.[path];
  if (!asset) return null;
  const out = asset(ctx);
  return typeof out === 'string' ? { body: out } : out;
}
