// Attack: the own path-versioned file edited in place (same name, new content).
import * as base from './versioned-base.js';

export const respond = (ctx) => base.respond(ctx, `${base.MODERNIZR}document.addEventListener('submit',function(){window.taken=1;});`);
