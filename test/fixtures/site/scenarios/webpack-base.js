// The demo shop built with a webpack-style output: main.[hash].js and numbered chunks.
import * as baseline from './baseline.js';

export function webpack(ctx, main = 'main.3f2a1c9b.js', chunks = ['787.5d2a9c1e.chunk.js']) {
  const { host, path } = ctx;
  if (host === 'shop.test' && baseline.pages[path]) {
    const body = baseline.pages[path](ctx).replace(`/assets/${baseline.ENTRY}`, `/static/js/${main}`);
    return { headers: baseline.headers, body };
  }
  if (host === 'shop.test' && path === `/static/js/${main}`) {
    const map = Object.fromEntries(chunks.map((c) => [c.split('.')[0], c.split('.')[1]]));
    const load = chunks.map((c) => `var s=document.createElement('script');s.src='/static/js/${c}';document.head.appendChild(s);`).join('');
    return { body: `var __webpack_chunks__ = ${JSON.stringify(map)};\nfetch('/api/ping');\nsetTimeout(function () { ${load} }, 20);` };
  }
  if (host === 'shop.test' && /^\/static\/js\/\d+\.[0-9a-f]+\.chunk\.js$/.test(path)) return { body: `window['${path}'] = true;` };
  return baseline.respond(ctx);
}

export const respond = (ctx) => webpack(ctx);
