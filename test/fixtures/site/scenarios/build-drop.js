// Attack: a skimmer file dropped into the build folder, loaded by the tag manager, with no deploy.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'tags.test' && ctx.path === '/gtm.js') {
    return { body: `(function(){var s=document.createElement('script');s.text='window.dataLayer=window.dataLayer||[];window.dataLayer.push({event:"pageview"});';document.head.appendChild(s);var d=document.createElement('script');d.src='${ctx.origin('shop.test')}/assets/evil-Zz9Yy8Xx.js';document.head.appendChild(d);})();` };
  }
  if (ctx.host === 'shop.test' && ctx.path === '/assets/evil-Zz9Yy8Xx.js') return { body: 'window.dropped = 1;' };
  return baseline.respond(ctx);
}
