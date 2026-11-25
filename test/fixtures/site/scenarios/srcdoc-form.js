// Attack: a fake payment form drawn in an iframe with no address of its own (srcdoc and about:blank),
// which takes the page's origin; and one in a sandboxed srcdoc iframe, which Chrome may run in a
// process of its own.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'shop.test' && ctx.path === '/checkout') {
    const fake = "<form method='post' action='/pay'><input autocomplete='cc-number' name='ccnum'><input name='cvc'></form>";
    const sandboxed = "<form><input autocomplete='cc-number' name='boxnum'></form>";
    const frames = `<iframe srcdoc="${fake}"></iframe><iframe sandbox="allow-forms allow-scripts" srcdoc="${sandboxed}"></iframe><iframe id="blank"></iframe><script>document.getElementById('blank').contentDocument.body.innerHTML = "<input type='password' name='pin'>";</script>`;
    return { headers: baseline.headers, body: baseline.pages['/checkout'](ctx).replace('</main>', `${frames}</main>`) };
  }
  return baseline.respond(ctx);
}
