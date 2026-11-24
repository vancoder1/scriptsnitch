// A script that sends a beacon from code it creates at runtime (code without a URL), and a pixel
// after a timer, whose request has no initiator stack without async stacks.
import { scenario } from './probe-kit.js';

export const respond = scenario((ctx) => `new Function("fetch('${ctx.origin('evil.test')}/b?x=1');")();
setTimeout(function () { new Image().src = '${ctx.origin('evil.test')}/px?x=1'; }, 50);`);
