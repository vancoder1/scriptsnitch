// The demo shop with a Content-Security-Policy listing its script hosts.
import * as baseline from './baseline.js';

export function withCsp(ctx, csp) {
  const answer = baseline.respond(ctx);
  if (ctx.host === 'shop.test' && baseline.pages[ctx.path]) return { ...answer, headers: { ...answer.headers, 'content-security-policy': csp } };
  return answer;
}

export const respond = (ctx) => withCsp(ctx, `script-src 'self' ${ctx.origin('cdn.test')} ${ctx.origin('tags.test')} 'unsafe-inline'; object-src 'none'`);
