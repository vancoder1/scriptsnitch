// A checkout where a card field appears in the top page twice, next to the payment iframe.
import * as baseline from './baseline.js';

export function respond(ctx) {
  const { host, path, origin } = ctx;
  if (host === 'shop.test' && path === '/checkout') {
    const body = `<h1>Checkout</h1><div id="payment"><iframe id="card-frame" src="${origin('pay.test')}/card"></iframe></div><form id="pay" method="post" action="/pay"><input autocomplete="cc-number" name="cardnumber"><input autocomplete="cc-number" name="cardnumber"><input name="cvv" id="cvv"></form>`;
    return { headers: baseline.headers, body: baseline.page({ origin, title: 'Checkout', body }) };
  }
  return baseline.respond(ctx);
}
