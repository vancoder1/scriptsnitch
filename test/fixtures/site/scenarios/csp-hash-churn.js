// Quiet: a policy whose script hashes change on every request.
import { withCsp } from './csp-base.js';

export const respond = (ctx) => withCsp(ctx, `script-src 'self' ${ctx.origin('cdn.test')} ${ctx.origin('tags.test')} 'unsafe-inline' 'sha256-${Buffer.from(String(Math.random())).toString('base64')}'; object-src 'none'`);
