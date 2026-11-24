// Expected Medium: the policy names one more script host.
import { withCsp } from './csp-base.js';

export const respond = (ctx) => withCsp(ctx, `script-src 'self' ${ctx.origin('cdn.test')} ${ctx.origin('tags.test')} https://widgets.example 'unsafe-inline'; object-src 'none'`);
