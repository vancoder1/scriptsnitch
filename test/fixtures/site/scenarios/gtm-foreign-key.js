// Attack: an attacker's own container on the approved tag-manager host (a new account key).
import { withContainers } from './gtm-real-base.js';

export const respond = (ctx) => withContainers(ctx, ['GTM-MINE1', 'GTM-EVIL9']);
