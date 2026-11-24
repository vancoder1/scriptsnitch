// A fake card form that appears only after the form is submitted.
import { scenario } from './probe-kit.js';

export const respond = scenario(() => `document.getElementById('login').addEventListener('submit', function (e) {
  e.preventDefault();
  var f = document.createElement('form'); f.id = 'verify'; f.method = 'post'; f.action = '/verify';
  f.innerHTML = '<input autocomplete="cc-number" name="cardnumber"><input autocomplete="cc-csc" name="cvc">';
  document.body.appendChild(f);
});`);
