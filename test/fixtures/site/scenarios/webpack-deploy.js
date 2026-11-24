// Quiet: a webpack-style deploy that renames the main bundle and a chunk and adds a chunk.
import { webpack } from './webpack-base.js';

export const respond = (ctx) => webpack(ctx, 'main.9b8c7d6e.js', ['787.1a2b3c4d.chunk.js', '900.aa11bb22.chunk.js']);
