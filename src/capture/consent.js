// Cookie-consent banners (design §7 "Consent banners"): most marketing tags load only after
// "Accept all", so a visitor who never accepts never sees them. Known managers are recognised and
// accepted with a trusted click; `consent` can also be "ignore" or steps of the site's own.
import { readFileSync } from 'node:fs';
import { clickNode, runSteps } from './steps.js';

const MANAGERS = JSON.parse(readFileSync(new URL('../../data/consent-managers.json', import.meta.url), 'utf8'));

// The first element matching a selector, in the light DOM or, failing that, in open shadow roots.
async function findElement(ctx, sessionId, selector) {
  const { root } = await ctx.send('DOM.getDocument', { depth: 0 }, sessionId);
  const { nodeId } = await ctx.send('DOM.querySelector', { nodeId: root.nodeId, selector }, sessionId).catch(() => ({ nodeId: 0 }));
  if (nodeId) return nodeId;
  const search = await ctx.send('DOM.performSearch', { query: selector }, sessionId).catch(() => null);
  if (!search?.resultCount) return null;
  try {
    const { nodeIds } = await ctx.send('DOM.getSearchResults', { searchId: search.searchId, fromIndex: 0, toIndex: Math.min(search.resultCount, 20) }, sessionId);
    for (const id of nodeIds) {
      const { node } = await ctx.send('DOM.describeNode', { nodeId: id }, sessionId).catch(() => ({}));
      if (node?.nodeType === 1) return id;
    }
    return null;
  } finally {
    await ctx.send('DOM.discardSearchResults', { searchId: search.searchId }, sessionId).catch(() => {});
  }
}

export async function acceptConsent(ctx, sessionId, mode = 'accept', { touch = false, env = process.env } = {}) {
  if (mode === 'ignore') return { found: null, accepted: false };
  if (Array.isArray(mode)) {
    try {
      await runSteps(ctx, sessionId, mode, { env });
      return { found: 'custom steps', accepted: true };
    } catch {
      return { found: 'custom steps', accepted: false };
    }
  }
  for (const manager of MANAGERS) {
    if (!(await findElement(ctx, sessionId, manager.detect))) continue;
    const button = await findElement(ctx, sessionId, manager.accept);
    if (!button) return { found: manager.name, accepted: false };
    const accepted = await clickNode(ctx, sessionId, button, { touch }).then(() => true, () => false);
    return { found: manager.name, accepted };
  }
  return { found: null, accepted: false };
}
