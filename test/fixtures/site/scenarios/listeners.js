// The sign-in page with a third-party script listening on the password field, on the page body
// (a delegated keylogger) and on the submit button, plus prefetch hints to outside hosts.
import * as baseline from './baseline.js';

export function respond(ctx) {
  const { host, path, origin } = ctx;
  if (host === 'shop.test' && path === '/login') {
    const head = `<link rel="dns-prefetch" href="//prefetch.evil.test"><link rel="preconnect" href="${origin('pre.evil.test')}">`;
    const body = `<form id="login" method="post" action="/login"><input type="email" name="email" id="email" required><input type="password" name="password" id="password" required><button type="submit" id="go">Sign in</button></form><script src="${origin('evil.test')}/skim.js"></script>`;
    return { headers: baseline.headers, body: baseline.page({ origin, title: 'Sign in', body, head }) };
  }
  if (host === 'evil.test' && path === '/skim.js') {
    return { body: "document.getElementById('password').addEventListener('keydown', function grab(e) { window.k = e.key; });\ndocument.body.addEventListener('input', function watch(e) { window.v = e.target.value; }, true);\ndocument.getElementById('go').addEventListener('mouseup', function send() { window.sent = true; });" };
  }
  return baseline.respond(ctx);
}
