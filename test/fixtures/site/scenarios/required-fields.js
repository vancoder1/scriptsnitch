// A sign-in form that also requires a phone, a postcode and a ticked terms box before it submits.
import { scenario } from './probe-kit.js';

export const respond = scenario(() => `document.getElementById('login').addEventListener('submit', function (e) {
  e.preventDefault();
  fetch('/login', { method: 'POST', body: new FormData(e.target) });
});`, { extraForm: '<input name="phone" id="phone" type="tel" required><input name="postcode" id="postcode" required><input type="checkbox" name="terms" id="terms" required>' });
