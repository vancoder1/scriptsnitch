// Shared pieces for the probe scenarios: a sign-in page and a checkout page whose extra script is
// given by each scenario.
import * as baseline from './baseline.js';

export function loginWith(ctx, script, { extraHead = '', extraForm = '' } = {}) {
  const body = `<form id="login" method="post" action="/login"><input type="email" name="email" id="email" required><input type="password" name="password" id="password" required>${extraForm}<button type="submit" id="go">Sign in</button></form>${script ? `<script src="${ctx.origin('evil.test')}/s.js"></script>` : ''}`;
  return { headers: baseline.headers, body: baseline.page({ origin: ctx.origin, title: 'Sign in', body, head: extraHead }) };
}

export function scenario(script, options = {}) {
  return function respond(ctx) {
    if (ctx.host === 'shop.test' && ctx.path === '/login') return loginWith(ctx, script, options);
    if (ctx.host === 'evil.test' && ctx.path === '/s.js') return { body: script(ctx) };
    return options.respond?.(ctx) ?? baseline.respond(ctx);
  };
}
