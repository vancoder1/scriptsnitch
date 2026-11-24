// The sign-in page with a container on the real tag-manager host name (mapped to the demo server),
// where scriptsnitch knows the account key sits in ?id=.
import * as baseline from './baseline.js';

export function withContainers(ctx, ids) {
  if (ctx.host === 'shop.test' && ctx.path === '/login') {
    const tags = ids.map((id) => `<script src="${ctx.origin('www.googletagmanager.com')}/gtm.js?id=${id}"></script>`).join('');
    return { headers: baseline.headers, body: baseline.pages['/login'](ctx).replace('</main>', `${tags}</main>`) };
  }
  if (ctx.host === 'www.googletagmanager.com' && ctx.path === '/gtm.js') return { body: `window['gtm-${ctx.query.get('id')}'] = 1;` };
  return baseline.respond(ctx);
}

export const respond = (ctx) => withContainers(ctx, ['GTM-MINE1']);
