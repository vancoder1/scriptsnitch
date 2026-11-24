// Quiet: a Vite-style deploy, the entry bundle renamed and a chunk renamed, both named by the build.
import * as baseline from './baseline.js';

export const ENTRY = 'index-C9xR1bTp.js';
export const CHUNKS = ['chunk-Hh7Jk2Lm.js'];
// Named in the build's chunk map from the deploy on, but loaded only on some later visit.
export const LAZY = 'chunk-Lz9Kp2Mn.js';

export function deployed(ctx, { lazyLoaded = false } = {}) {
  const chunks = CHUNKS;
  const { host, path } = ctx;
  if (host === 'shop.test' && baseline.pages[path]) {
    const body = baseline.pages[path](ctx).replace(`/assets/${baseline.ENTRY}`, `/assets/${ENTRY}`);
    return { headers: baseline.headers, body };
  }
  if (host === 'shop.test' && path === `/assets/${ENTRY}`) {
    const map = Object.fromEntries([...chunks, LAZY].map((c) => [c.replace(/^chunk-|\.js$/g, ''), 'chunk']));
    const load = chunks.map((c) => `var s=document.createElement('script');s.src='/assets/${c}';document.head.appendChild(s);`).join('');
    // The same bundle on both days: it asks the server whether to load the lazy chunk.
    const later = `fetch('/api/flags').then(function(r){return r.json();}).then(function(f){if(f.lazy){var l=document.createElement('script');l.src='/assets/${LAZY}';document.head.appendChild(l);}});`;
    return { body: `var __chunks = ${JSON.stringify(map)};\nfetch('/api/ping');\nsetTimeout(function () { ${load} }, 20);${later}` };
  }
  if (host === 'shop.test' && /^\/assets\/chunk-[A-Za-z0-9]+\.js$/.test(path)) return { body: `window['${path}'] = true;` };
  if (host === 'shop.test' && path === '/api/flags') return { type: 'application/json', body: JSON.stringify({ lazy: lazyLoaded }) };
  return baseline.respond(ctx);
}

export const respond = (ctx) => deployed(ctx);
