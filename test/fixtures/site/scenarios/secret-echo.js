// A sign-in step stores the typed user name, and the home page sends it in a request URL.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/login') {
    return { headers: baseline.headers, body: baseline.page({ origin: ctx.origin, title: 'Sign in', body: '<input id="user"><button id="go" onclick="localStorage.setItem(\'u\', document.getElementById(\'user\').value)">Sign in</button>' }) };
  }
  if (ctx.host === 'shop.test' && ctx.path === '/') {
    const head = '<script>fetch("/api/me?u=" + encodeURIComponent(localStorage.getItem("u") || ""));</script>';
    return { headers: baseline.headers, body: baseline.page({ origin: ctx.origin, title: 'Demo shop', body: '<h1>Demo shop</h1>', head }) };
  }
  if (ctx.host === 'shop.test' && ctx.path === '/api/me') return { type: 'application/json', body: '{}' };
  return baseline.respond(ctx);
}
