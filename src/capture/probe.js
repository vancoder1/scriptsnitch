// The form probe (design §11): fill forms with fake values like a person, submit, and record where
// the page tries to send them, while Fetch answers every request locally and offline emulation stops
// WebSocket frames. Nothing reaches any server.
import { clickNode, typeText } from './steps.js';
import { countPeers } from './peers.js';
import { attrs } from './dom.js';
import { findValues } from '../analyze/probe-match.js';
import { internal } from './internal.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OFFLINE = { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 };

// From here on, every request in the context is recorded and answered locally.
export async function holdNetwork(ctx) {
  const held = [];
  ctx.on('Fetch.requestPaused', (p, sessionId) => {
    const headers = Object.fromEntries(Object.entries(p.request.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    // Answer CORS preflights permissively, so the real request follows and is held too.
    if (p.request.method === 'OPTIONS' && headers['access-control-request-method']) {
      const cors = [
        { name: 'access-control-allow-origin', value: headers.origin ?? '*' },
        { name: 'access-control-allow-methods', value: headers['access-control-request-method'] },
        { name: 'access-control-allow-headers', value: headers['access-control-request-headers'] ?? '*' },
        { name: 'access-control-allow-credentials', value: 'true' },
      ];
      ctx.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 204, responseHeaders: cors }, sessionId).catch(() => {});
      return;
    }
    held.push({ url: p.request.url, method: p.request.method, body: p.request.postData ?? '', type: p.resourceType, sessionId, networkId: p.networkId ?? null, headers: p.request.headers ?? {} });
    const document = p.resourceType === 'Document';
    ctx.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: document ? 204 : 200, responseHeaders: [{ name: 'content-type', value: 'text/plain' }], body: '' }, sessionId).catch(() => {});
  });
  // A page or frame that cannot be held must stop the probe before anything is typed: failing open
  // would let the fake values reach real servers. A dedicated worker's requests go through its page,
  // which is held, and workers do not take these commands, so for them the hold is best effort.
  const hold = async (session) => {
    try {
      await ctx.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, session.id);
      await ctx.send('Network.emulateNetworkConditions', OFFLINE, session.id);
    } catch (e) {
      // A frame that was removed or navigated away has no session any more: nothing to hold there.
      const gone = !ctx.sessions.has(session.id) || /session with given id not found|no session|target closed|detached/i.test(e.message);
      if ((session.type === 'page' || session.type === 'iframe') && !gone) throw new Error(`the probe could not hold the network (${e.message})`);
    }
  };
  for (const s of ctx.sessions.values()) await hold(s);
  // A frame that appears later and cannot be held makes the visit inconclusive afterwards.
  Object.defineProperty(held, 'failure', { value: null, writable: true, enumerable: false });
  ctx.onSession((s) => hold(s).catch((e) => { held.failure ??= e.message; }));
  return held;
}

function cardPart(a) {
  const tokens = (a.autocomplete ?? '').toLowerCase();
  const text = [a.name, a.id, a.placeholder, a['aria-label']].filter(Boolean).join(' ').toLowerCase();
  if (/cc-csc/.test(tokens) || /\b(?:cvc|cvv|cvv2|csc|cid)\b|security[-_\s]?code/.test(text)) return 'cvc';
  if (/cc-exp/.test(tokens) || /\bexp|mm[-_\s/]?yy|valid/.test(text)) return 'expiry';
  return 'card';
}

function valueFor(kind, a, values) {
  if (kind === 'card') return values[cardPart(a)];
  if (kind in values) return values[kind];
  const text = [a.name, a.id, a.autocomplete, a.placeholder].filter(Boolean).join(' ').toLowerCase();
  const type = (a.type ?? 'text').toLowerCase();
  if (type === 'tel' || /phone|tel\b|mobile/.test(text)) return values.phone;
  if (/post|zip/.test(text)) return values.postcode;
  if (/address|street|line1/.test(text)) return values.address;
  if (type === 'email') return values.email;
  return values.other;
}

async function pressKey(ctx, sessionId, key, code, keyCode) {
  await ctx.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }, sessionId);
  await ctx.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode }, sessionId);
}

async function fill(ctx, sessionId, nodeId, value) {
  await typeText(ctx, sessionId, nodeId, value);
  await pressKey(ctx, sessionId, 'Tab', 'Tab', 9);
}

// The required controls of a form that are not sensitive fields: text-like inputs, selects, boxes.
async function requiredControls(ctx, sessionId, formNodeId, skip) {
  const { nodeIds = [] } = await ctx.send('DOM.querySelectorAll', { nodeId: formNodeId, selector: 'input[required], select[required], textarea[required]' }, sessionId).catch(() => ({}));
  const out = [];
  for (const nodeId of nodeIds) {
    if (skip.has(nodeId)) continue;
    const { node } = await ctx.send('DOM.describeNode', { nodeId }, sessionId).catch(() => ({}));
    if (node) out.push({ nodeId, node, a: attrs(node) });
  }
  return out;
}

async function submitForm(ctx, sessionId, formNodeId, lastField, touch) {
  if (formNodeId) {
    const { nodeId } = await ctx.send('DOM.querySelector', { nodeId: formNodeId, selector: 'button[type=submit], input[type=submit], input[type=image], button:not([type])' }, sessionId).catch(() => ({ nodeId: 0 }));
    if (nodeId) return clickNode(ctx, sessionId, nodeId, { touch }).then(() => true, () => false);
    const { object } = await ctx.send('DOM.resolveNode', { nodeId: formNodeId }, sessionId).catch(() => ({}));
    if (object) return ctx.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: internal('function () { this.requestSubmit(); }') }, sessionId).then(() => true, () => false);
  }
  if (lastField) {
    await ctx.send('DOM.focus', { nodeId: lastField }, sessionId).catch(() => {});
    await pressKey(ctx, sessionId, 'Enter', 'Enter', 13).catch(() => {});
    return true;
  }
  return false;
}

// Fills every form that holds a sensitive field, then submits the first of them.
export async function fillAndSubmit(ctx, fieldNodes, values, { touch = false } = {}) {
  const sensitive = fieldNodes.filter((f) => ['password', 'card', 'iban'].includes(f.kind));
  if (!sensitive.length) return { filled: 0, submitted: false };
  const forms = new Map();
  for (const f of fieldNodes) {
    const key = `${f.sessionId}|${f.formNodeId ?? `none:${f.nodeId}`}`;
    if (!forms.has(key)) forms.set(key, { sessionId: f.sessionId, formNodeId: f.formNodeId, fields: [] });
    forms.get(key).fields.push(f);
  }
  const target = [...forms.values()].find((g) => g.fields.some((f) => sensitive.includes(f))) ?? null;
  let filled = 0;
  let last = null;
  for (const group of forms.values()) {
    if (!group.fields.some((f) => sensitive.includes(f)) && group !== target) continue;
    for (const f of group.fields) {
      const value = valueFor(f.kind, f.attrs ?? {}, values);
      if (!value) continue;
      await fill(ctx, group.sessionId, f.nodeId, value).catch(() => {});
      filled++;
      last = f.nodeId;
    }
    if (group.formNodeId) {
      for (const c of await requiredControls(ctx, group.sessionId, group.formNodeId, new Set(group.fields.map((f) => f.nodeId)))) {
        const type = (c.a.type ?? 'text').toLowerCase();
        if (type === 'checkbox' || type === 'radio') await clickNode(ctx, group.sessionId, c.nodeId, { touch }).catch(() => {});
        else if (c.node.localName === 'select') {
          await ctx.send('DOM.focus', { nodeId: c.nodeId }, group.sessionId).catch(() => {});
          await pressKey(ctx, group.sessionId, 'ArrowDown', 'ArrowDown', 40).catch(() => {});
        } else await fill(ctx, group.sessionId, c.nodeId, valueFor(null, c.a, values)).catch(() => {});
      }
    }
  }
  const submitted = target ? await submitForm(ctx, target.sessionId, target.formNodeId, last, touch) : false;
  return { filled, submitted };
}

// Waits after submit, sampling peer connections several times (a closed one may be collected).
export async function waitAndSample(ctx, sessionId, ms) {
  let peers = 0;
  const step = Math.max(500, Math.floor(ms / 4));
  for (let waited = 0; waited < ms; waited += step) {
    await sleep(step);
    peers = Math.max(peers, await countPeers(ctx, sessionId));
  }
  return peers;
}

export async function startCoverage(ctx, sessionId) {
  await ctx.send('Profiler.enable', {}, sessionId).catch(() => {});
  await ctx.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true }, sessionId).catch(() => {});
  await ctx.send('Profiler.takePreciseCoverage', {}, sessionId).catch(() => {});
}

// Script ids whose code ran since coverage started.
export async function takeCoverage(ctx, sessionId) {
  const r = await ctx.send('Profiler.takePreciseCoverage', {}, sessionId).catch(() => ({ result: [] }));
  await ctx.send('Profiler.stopPreciseCoverage', {}, sessionId).catch(() => {});
  return (r.result ?? []).filter((s) => s.functions.some((f) => f.ranges.some((range) => range.count > 0))).map((s) => s.scriptId);
}

// Probe values kept in the origin's storage or cookies.
export async function readStorage(ctx, sessionId, origin, values) {
  const found = [];
  const wanted = { card: values.card, password: values.password, iban: values.iban };
  await ctx.send('DOMStorage.enable', {}, sessionId).catch(() => {});
  for (const isLocalStorage of [true, false]) {
    const { entries = [] } = await ctx.send('DOMStorage.getDOMStorageItems', { storageId: { securityOrigin: origin, isLocalStorage } }, sessionId).catch(() => ({}));
    for (const hit of findValues(entries.flat().join('\n'), wanted)) found.push({ kind: hit.kind, where: isLocalStorage ? 'localStorage' : 'sessionStorage' });
  }
  const { cookies = [] } = await ctx.send('Network.getCookies', { urls: [origin] }, sessionId).catch(() => ({}));
  for (const hit of findValues(cookies.map((c) => `${c.name}=${c.value}`).join('\n'), wanted)) found.push({ kind: hit.kind, where: 'cookie' });
  return found;
}
