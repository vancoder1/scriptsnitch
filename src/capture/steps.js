// Replays a page's steps (design §13): goto, click, type (a value, a secret or a one-time code) and
// wait. Clicks and keys are real input events, so pages react as they would to a person.
import { totp } from '../util/totp.js';

export class StepError extends Error {
  constructor(index, step, detail) {
    super(`step ${index + 1} (${Object.keys(step).find((k) => ['goto', 'click', 'type', 'wait'].includes(k))}): ${detail}`);
    this.name = 'StepError';
    this.index = index;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function waitForEvent(ctx, method, sessionId, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve(false); }, ms);
    const off = ctx.on(method, (_p, sid) => {
      if (sid !== sessionId) return;
      clearTimeout(timer);
      off();
      resolve(true);
    });
  });
}

export async function navigate(ctx, sessionId, url, capMs = 15000) {
  const loaded = waitForEvent(ctx, 'Page.loadEventFired', sessionId, capMs);
  const result = await ctx.send('Page.navigate', { url }, sessionId).catch((e) => ({ errorText: e.message }));
  if (result.errorText) return { ok: false, reason: `could not load ${url}: ${result.errorText}` };
  if (!(await loaded)) return { ok: false, reason: 'timed out' };
  return { ok: true };
}

export async function querySelector(ctx, sessionId, selector) {
  const { root } = await ctx.send('DOM.getDocument', { depth: 0 }, sessionId);
  const { nodeId } = await ctx.send('DOM.querySelector', { nodeId: root.nodeId, selector }, sessionId).catch(() => ({ nodeId: 0 }));
  return nodeId || null;
}

export async function clickNode(ctx, sessionId, nodeId, { touch = false } = {}) {
  await ctx.send('DOM.scrollIntoViewIfNeeded', { nodeId }, sessionId).catch(() => {});
  const { quads } = await ctx.send('DOM.getContentQuads', { nodeId }, sessionId);
  if (!quads?.length) throw new Error('the element is not visible');
  const q = quads[0];
  const x = (q[0] + q[2] + q[4] + q[6]) / 4;
  const y = (q[1] + q[3] + q[5] + q[7]) / 4;
  if (touch) {
    await ctx.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }, sessionId);
    await ctx.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
    return;
  }
  await ctx.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
  await ctx.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 }, sessionId);
  await ctx.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 }, sessionId);
}

export async function typeText(ctx, sessionId, nodeId, text) {
  await ctx.send('DOM.focus', { nodeId }, sessionId);
  for (const ch of text) {
    await ctx.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch }, sessionId);
    await ctx.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch }, sessionId);
  }
}

// Runs an action and, if it starts a navigation, waits for the new page to load.
async function withNavigation(ctx, sessionId, action) {
  let started = false;
  const off = ctx.on('Page.frameStartedLoading', (_p, sid) => { if (sid === sessionId) started = true; });
  try {
    await action();
    await sleep(500);
    if (started) await waitForEvent(ctx, 'Page.loadEventFired', sessionId, 15000);
  } finally {
    off();
  }
  await sleep(300);
}

export async function runSteps(ctx, sessionId, steps, { env = process.env, now = Date.now } = {}) {
  for (const [index, step] of steps.entries()) {
    const fail = (detail) => { throw new StepError(index, step, detail); };
    if (step.goto) {
      const r = await navigate(ctx, sessionId, step.goto);
      if (!r.ok) fail(r.reason);
      await sleep(500);
    } else if (step.click) {
      const nodeId = await querySelector(ctx, sessionId, step.click);
      if (!nodeId) fail(`no element matches ${step.click}`);
      await withNavigation(ctx, sessionId, () => clickNode(ctx, sessionId, nodeId).catch((e) => fail(e.message)));
    } else if (step.type) {
      const nodeId = await querySelector(ctx, sessionId, step.type);
      if (!nodeId) fail(`no element matches ${step.type}`);
      let value = step.value;
      if (step.secret !== undefined) value = env[step.secret] ?? fail(`environment variable ${step.secret} is not set`);
      if (step.totp !== undefined) value = totp(env[step.totp] ?? fail(`environment variable ${step.totp} is not set`), now());
      await typeText(ctx, sessionId, nodeId, value);
    } else if (step.wait !== undefined) {
      if (typeof step.wait === 'number') await sleep(step.wait);
      else {
        const until = Date.now() + 15000;
        while (!(await querySelector(ctx, sessionId, step.wait))) {
          if (Date.now() > until) fail(`${step.wait} did not appear within 15 s`);
          await sleep(200);
        }
      }
    }
  }
}
