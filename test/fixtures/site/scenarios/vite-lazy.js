// Quiet: a day after the deploy, a lazily loaded chunk the build names is seen for the first time.
import { deployed } from './vite-deploy.js';

export const respond = (ctx) => deployed(ctx, { lazyLoaded: true });
