// Inline scripts that name themselves with `//# sourceURL=`: one after the shop's own library (which
// the page also loads for real), one with a bundler-style name. The page also changes its address
// with history.replaceState between its inline scripts.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/') {
    const lib = `${ctx.origin('cdn.test')}/lib@1.2.3/lib.min.js`;
    const extra = [
      `<script>window.spoofed = 1;\n//# sourceURL=${lib}</script>`,
      '<script>window.named = 1;\n//# sourceURL=webpack://shop/src/named.js</script>',
      "<script>history.replaceState(null, '', '/?step=2');</script>",
      '<script>window.afterReplace = 1;</script>',
    ].join('');
    return { headers: baseline.headers, body: baseline.pages['/'](ctx).replace('</body>', `${extra}</body>`) };
  }
  return baseline.respond(ctx);
}
