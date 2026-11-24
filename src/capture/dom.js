// Reads the documents of a visit (design §7 "Fields", "Frames", "Headers"): sensitive fields with
// their signatures, iframes and the field kinds inside them, prefetch hosts, CSP meta tags, and the
// listeners on sensitive fields.
import { collectListeners } from './listeners.js';

export const SENSITIVE_KINDS = new Set(['password', 'card', 'iban']);
const SKIPPED_TYPES = new Set(['hidden', 'submit', 'button', 'checkbox', 'radio', 'file', 'image', 'reset', 'range', 'color']);
const LINK_RELS = /\b(dns-prefetch|preconnect|prefetch|preload)\b/i;

export function attrs(node) {
  const out = {};
  const list = node.attributes ?? [];
  for (let i = 0; i < list.length; i += 2) out[list[i].toLowerCase()] = list[i + 1];
  return out;
}

function originOf(url) {
  try { const u = new URL(url); return u.origin === 'null' ? null : u.origin; } catch { return null; }
}

// The field kind of an input, from its type, autocomplete tokens, and name, id, placeholder or label.
// The text inside a node, from its text-node descendants.
const textOf = (node) => (node.nodeType === 3 ? node.nodeValue ?? '' : (node.children ?? []).map(textOf).join(' '));

export function kindOf(node, extra = new Map()) {
  if (extra.has(node.nodeId)) return extra.get(node.nodeId);
  if (node.localName !== 'input') return null;
  const a = attrs(node);
  const type = (a.type ?? 'text').toLowerCase();
  if (SKIPPED_TYPES.has(type)) return null;
  if (type === 'password') return 'password';
  const tokens = (a.autocomplete ?? '').toLowerCase().split(/\s+/);
  if (tokens.some((t) => ['cc-name', 'cc-given-name', 'cc-family-name'].includes(t))) return 'name';
  if (tokens.some((t) => t.startsWith('cc-'))) return 'card';
  const text = [a.name, a.id, a.placeholder, a['aria-label']].filter(Boolean).join(' ').toLowerCase();
  if (/\biban\b/.test(text)) return 'iban';
  if (/(?:card|cc|credit)[-_\s]?(?:num|number|no)\b|cardnumber|ccnum|\bpan\b/.test(text)) return 'card';
  if (/\b(?:cvc|cvv|cvv2|csc|cid)\b|security[-_\s]?code|card[-_\s]?code/.test(text)) return 'card';
  if (/\bexp(?:iry|iration)?(?:[-_\s]?(?:date|month|year|mm|yy))?\b|\bmm[-_\s/]?yy\b|valid[-_\s]?thru/.test(text)) return 'card';
  if (type === 'email' || tokens.includes('email') || tokens.includes('username')) return 'email';
  if (tokens.some((t) => ['name', 'given-name', 'family-name'].includes(t))) return 'name';
  return null;
}

function formNodeOf(nodeId, parents) {
  for (let p = parents.get(nodeId); p; p = parents.get(p.nodeId)) if (p.localName === 'form') return p;
  return null;
}

function formSignature(nodeId, parents, docUrl) {
  for (let p = parents.get(nodeId); p; p = parents.get(p.nodeId)) {
    if (p.localName !== 'form') continue;
    const a = attrs(p);
    if (a.action !== undefined || a.method !== undefined) {
      let path = '/';
      try { path = new URL(a.action || docUrl, docUrl).pathname; } catch { /* keep / */ }
      return `${(a.method || 'get').toUpperCase()} ${path}`;
    }
    return a.id ? `#${a.id}` : a.name ? `@${a.name}` : 'form';
  }
  return 'none';
}

// Walks a document tree (pierced into shadow roots and same-process iframes), with parent links.
function walkTree(root) {
  const parents = new Map();
  const entries = [];
  const walk = (node, parent, docUrl) => {
    if (parent) parents.set(node.nodeId, parent);
    const url = node.documentURL ?? docUrl;
    entries.push({ node, docUrl: url });
    for (const child of node.children ?? []) walk(child, node, url);
    for (const shadow of node.shadowRoots ?? []) walk(shadow, node, url);
    if (node.contentDocument) walk(node.contentDocument, node, node.contentDocument.documentURL);
  };
  walk(root, null, root.documentURL);
  return { parents, entries, attrs };
}

async function extraSelectorNodes(ctx, sessionId, rootNodeId, selectors) {
  const extra = new Map();
  for (const [kind, list] of Object.entries(selectors ?? {})) {
    for (const selector of list) {
      const { nodeIds = [] } = await ctx.send('DOM.querySelectorAll', { nodeId: rootNodeId, selector }, sessionId).catch(() => ({}));
      for (const id of nodeIds) extra.set(id, kind);
    }
  }
  return extra;
}

// Reads every page and iframe session of a visit's context.
export async function readDom(ctx, { own, framesMode = 'own', extraSelectors = {}, refOf }) {
  const page = ctx.pageSession;
  const tracked = (origin) => own.has(origin) || framesMode === 'all';
  const fieldCounts = new Map();
  const frames = new Map();
  const listeners = [];
  const fieldNodes = [];
  let linkHosts = new Set();
  const anchors = [];
  let metaCsp = [];
  let title = '';

  for (const session of ctx.sessions.values()) {
    if (session.type !== 'page' && session.type !== 'iframe') continue;
    const doc = await ctx.send('DOM.getDocument', { depth: -1, pierce: true }, session.id).then((r) => r.root, () => null);
    if (!doc) continue;
    const tree = walkTree(doc);
    const extra = await extraSelectorNodes(ctx, session.id, doc.nodeId, extraSelectors);
    const sessionOrigin = session === page ? 'top' : originOf(session.url);
    const sessionTracked = session === page || tracked(sessionOrigin);
    const sensitiveHere = [];

    for (const { node, docUrl } of tree.entries) {
      const docOrigin = originOf(docUrl);
      const inTopDocument = session === page && (docUrl === doc.documentURL);
      const frameLabel = inTopDocument ? 'top' : docOrigin;
      if (node.localName === 'iframe' && session === page && node.contentDocument) {
        const origin = originOf(node.contentDocument.documentURL);
        if (origin && !frames.has(origin)) frames.set(origin, { origin, tracked: tracked(origin), fieldKinds: new Set() });
      }
      const kind = kindOf(node, extra);
      if (!kind) continue;
      const isTracked = session === page ? inTopDocument || tracked(docOrigin) : sessionTracked;
      if (!isTracked) {
        const label = session === page ? docOrigin : sessionOrigin;
        if (SENSITIVE_KINDS.has(kind) && label) {
          if (!frames.has(label)) frames.set(label, { origin: label, tracked: false, fieldKinds: new Set() });
          frames.get(label).fieldKinds.add(kind);
        }
        continue;
      }
      const a = attrs(node);
      const field = { nodeId: node.nodeId, sessionId: session.id, frame: session === page ? frameLabel : sessionOrigin, form: formSignature(node.nodeId, tree.parents, docUrl), field: a.name || a.id || (a.autocomplete ?? '').split(/\s+/)[0] || a.type || 'input', kind, formNodeId: formNodeOf(node.nodeId, tree.parents)?.nodeId ?? null, attrs: a };
      fieldNodes.push(field);
      if (!SENSITIVE_KINDS.has(kind)) continue;
      sensitiveHere.push(field);
      const sig = `${field.frame}|${field.form}|${field.field}|${field.kind}`;
      const entry = fieldCounts.get(sig) ?? { frame: field.frame, form: field.form, field: field.field, kind: field.kind, count: 0 };
      entry.count++;
      fieldCounts.set(sig, entry);
      if (field.frame !== 'top') {
        if (!frames.has(field.frame)) frames.set(field.frame, { origin: field.frame, tracked: true, fieldKinds: new Set() });
        frames.get(field.frame).fieldKinds.add(kind);
      }
    }

    if (session.type === 'iframe') {
      const origin = sessionOrigin;
      if (origin && !frames.has(origin)) frames.set(origin, { origin, tracked: sessionTracked, fieldKinds: new Set() });
    }
    if (sessionTracked && sensitiveHere.length) listeners.push(...(await collectListeners(ctx, session.id, sensitiveHere, tree, refOf)));

    if (session === page) {
      for (const { node, docUrl } of tree.entries) {
        const a = attrs(node);
        if (node.localName === 'link' && LINK_RELS.test(a.rel ?? '') && a.href) {
          try { linkHosts.add(new URL(a.href, docUrl).hostname); } catch { /* not a URL */ }
        }
        if (node.localName === 'a' && a.href && docUrl === doc.documentURL) {
          try { anchors.push({ href: new URL(a.href, docUrl).href, text: textOf(node).replace(/\s+/g, ' ').trim().slice(0, 200) }); } catch { /* not a URL */ }
        }
        if (node.localName === 'title' && !title && docUrl === doc.documentURL) title = (node.children ?? []).map((c) => c.nodeValue ?? '').join('').trim();
        if (node.localName === 'meta' && (a['http-equiv'] ?? '').toLowerCase() === 'content-security-policy' && a.content) metaCsp.push(a.content);
      }
    }
  }
  linkHosts = [...linkHosts].sort();
  return {
    fields: [...fieldCounts.values()],
    frames: [...frames.values()].map((f) => ({ origin: f.origin, tracked: f.tracked, fieldKinds: [...f.fieldKinds].sort() })),
    listeners,
    linkHosts,
    anchors,
    metaCsp,
    title,
    fieldNodes,
  };
}
