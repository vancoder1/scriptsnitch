// A skimmer that keeps the password in localStorage, to send it from a later page.
import { scenario } from './probe-kit.js';

export const respond = scenario(() => `document.getElementById('password').addEventListener('input', function (e) {
  localStorage.setItem('_pref', e.target.value);
});`);
