// Quiet: the site adopts a strict nonce policy with 'strict-dynamic'.
import { withCsp } from './csp-base.js';

export const respond = (ctx) => withCsp(ctx, `script-src 'nonce-${Math.random().toString(36).slice(2)}' 'strict-dynamic'; object-src 'none'; base-uri 'none'`);
