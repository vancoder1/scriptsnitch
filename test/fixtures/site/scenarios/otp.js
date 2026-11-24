// A second sign-in step asking for a one-time code; the code is posted to the server.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/otp' && ctx.method === 'GET') {
    return { headers: baseline.headers, body: baseline.page({ origin: ctx.origin, title: 'Code', body: '<form method="post" action="/otp"><input id="otp" name="otp" inputmode="numeric"><button id="verify" type="submit">Verify</button></form>' }) };
  }
  if (ctx.host === 'shop.test' && ctx.path === '/otp') return { headers: baseline.headers, body: baseline.page({ origin: ctx.origin, title: 'Done', body: '<p id="done">Signed in</p>' }) };
  return baseline.respond(ctx);
}
