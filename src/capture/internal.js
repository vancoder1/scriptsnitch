// Code scriptsnitch itself runs in a page through the protocol (reading window, counting peer
// connections, requestSubmit) is compiled as a script without a URL, just like a page's eval'd code.
// Each such snippet carries a comment unique to this process, and capture skips scripts that carry
// it. The page cannot read the snippets, so it cannot copy the mark to hide its own code; a
// sourceURL would instead show up in the page's stack traces.
import { randomBytes } from 'node:crypto';

const MARK = `/*${randomBytes(12).toString('hex')}*/`;

export const internal = (code) => `${code}\n${MARK}`;
export const isInternal = (source) => typeof source === 'string' && source.includes(MARK);
