// Who listens to sensitive fields (design §7 "Listeners"): the field, every ancestor up to the
// document (crossing shadow-root hosts), the form's submit buttons, and the window. Chrome answers
// through DOMDebugger.getEventListeners, which the page cannot observe.

export const FIELD_EVENTS = new Set([
  'keydown', 'keyup', 'keypress', 'input', 'beforeinput', 'change', 'focus', 'blur', 'focusin', 'focusout',
  'paste', 'submit', 'click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend',
]);
export const WINDOW_EVENTS = new Set([...FIELD_EVENTS, 'beforeunload', 'pagehide', 'visibilitychange']);
const GROUP = 'scriptsnitch';

const isSubmitControl = (node, attrs) => {
  const type = (attrs.type ?? '').toLowerCase();
  return (node.localName === 'button' && (type === '' || type === 'submit')) || (node.localName === 'input' && (type === 'submit' || type === 'image'));
};

// fields: [{ nodeId, kind }] in one session; tree: { parents: Map<nodeId,node>, nodes: Map<nodeId,node>, attrs(node) }.
export async function collectListeners(ctx, sessionId, fields, tree, refOf) {
  const cache = new Map();
  const found = new Map();
  const listenersOf = async (key, resolve) => {
    if (cache.has(key)) return cache.get(key);
    const result = await resolve()
      .then((objectId) => ctx.send('DOMDebugger.getEventListeners', { objectId, depth: 0 }, sessionId))
      .then((r) => r.listeners ?? [], () => []);
    cache.set(key, result);
    return result;
  };
  const byNode = (nodeId) => listenersOf(nodeId, () => ctx.send('DOM.resolveNode', { nodeId, objectGroup: GROUP }, sessionId).then((r) => r.object.objectId));
  const add = (kind, role, events, listeners) => {
    for (const l of listeners) {
      if (!events.has(l.type)) continue;
      const script = l.scriptId && l.scriptId !== '0' ? refOf(sessionId, l.scriptId) : null;
      const key = `${kind}|${role}|${l.type}|${JSON.stringify(script)}`;
      if (!found.has(key)) found.set(key, { kind, role, event: l.type, script });
    }
  };

  for (const field of fields) {
    add(field.kind, 'field', FIELD_EVENTS, await byNode(field.nodeId));
    let form = null;
    for (let node = tree.parents.get(field.nodeId); node; node = tree.parents.get(node.nodeId)) {
      const role = node.localName === 'form' ? 'form' : node.nodeType === 9 ? 'document' : 'ancestor';
      if (role === 'form') form = node;
      add(field.kind, role, FIELD_EVENTS, await byNode(node.nodeId));
      if (node.nodeType === 9) break;
    }
    if (form) {
      const stack = [...(form.children ?? [])];
      while (stack.length) {
        const node = stack.pop();
        if (isSubmitControl(node, tree.attrs(node))) add(field.kind, 'submit', FIELD_EVENTS, await byNode(node.nodeId));
        stack.push(...(node.children ?? []), ...(node.shadowRoots ?? []));
      }
    }
    const win = await listenersOf('window', () => ctx.send('Runtime.evaluate', { expression: 'window', objectGroup: GROUP }, sessionId).then((r) => r.result.objectId));
    add(field.kind, 'window', WINDOW_EVENTS, win);
  }
  await ctx.send('Runtime.releaseObjectGroup', { objectGroup: GROUP }, sessionId).catch(() => {});
  return [...found.values()];
}
