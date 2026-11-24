// Quiet: a Next.js-style flight payload that differs on every request.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/') {
    const payload = JSON.stringify(`1:["$","div",null,{"children":"${Math.random().toString(36).slice(2)}"}]`);
    const head = `<script>(self.__next_f=self.__next_f||[]).push([0])</script><script>self.__next_f.push([1,${payload}])</script>`;
    return { headers: baseline.headers, body: baseline.page({ origin: ctx.origin, title: 'Demo shop', body: '<h1>Demo shop</h1>', head }) };
  }
  return baseline.respond(ctx);
}
