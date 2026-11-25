// The identity of an inline script: its code structure (design §8 "Inline scripts"). Literal values
// are masked, data blobs collapse, so prices, nonces and product lists never change it; added code,
// a swapped endpoint or a swapped eval payload do.
import { readFileSync } from 'node:fs';
import { tokenize, stringValue, isLiteral } from './tokenize.js';
import { sha256Hex } from '../util/hash.js';

const GLOBALS = new Set(JSON.parse(readFileSync(new URL('../../data/framework-globals.json', import.meta.url), 'utf8')));
const CODE_RUNNERS = new Set(['eval', 'Function', 'setTimeout', 'setInterval', 'write', 'writeln', 'insertAdjacentHTML', 'execScript']);
const HTML_PROPERTIES = new Set(['innerHTML', 'outerHTML', 'srcdoc']);
const DATA_WORDS = new Set(['true', 'false', 'null', 'undefined']);
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:)?\/\/\S+$/i;
// A host name has a letter in its last label (a price such as "19.99" is not one), or is an IPv4 address.
const HOST_LIKE = /^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z0-9-]*[a-z][a-z0-9-]*|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/i;

export const isUrlOrHost = (value) => URL_LIKE.test(value) || HOST_LIKE.test(value);

function hostOf(value) {
  try { return new URL(value.startsWith('//') ? `https:${value}` : value).hostname; } catch { return value.toLowerCase(); }
}

// A framework data script is exactly one of the shapes frameworks write, holding nothing but data:
//   var X = DATA / window.X = DATA / self.X = DATA                  (WooCommerce, Next.js, Redux state)
//   X.push(DATA) / (self.X = self.X || []).push(DATA, ...)            (Next.js flight data)
//   window.X = (function (a, b) { return DATA(a, b) }(DATA, ...))     (Nuxt: data from its parameters)
// where DATA is literals, arrays and objects. A call, a function with more than a return, or a second
// statement anywhere makes it ordinary code: everything in a data script is ignored but its hosts.
function dataGlobalOf(sig) {
  let i = 0;
  const peek = (k = 0) => sig[i + k];
  const is = (v, k = 0) => peek(k)?.value === v && (peek(k).type === 'punct' || peek(k).type === 'ident');
  const eat = (v) => { if (!is(v)) throw new Error(v); i++; };
  const ident = () => { const t = peek(); if (t?.type !== 'ident') throw new Error('ident'); i++; return t.value; };
  // window.X, self.X, globalThis.X or X; with `var`, `let` or `const` only X.
  const target = () => {
    if (is('var') || is('let') || is('const')) { i++; return ident(); }
    const first = ident();
    if (['window', 'self', 'globalThis'].includes(first) && is('.')) { i++; return ident(); }
    return first;
  };
  const data = (params) => {
    const t = peek();
    if (!t) throw new Error('end');
    if (isLiteral(t) && t.type !== 'regex') { i++; return; }
    if (t.type === 'ident' && (DATA_WORDS.has(t.value) || params.has(t.value))) { i++; return; }
    if (is('-') || is('!')) { i++; if (peek()?.type !== 'number') throw new Error('number'); i++; return; }
    if (is('void') && peek(1)?.type === 'number') { i += 2; return; }
    if (is('[')) {
      i++;
      while (!is(']')) { if (is(',')) { i++; continue; } data(params); if (!is(']')) eat(','); }
      i++;
      return;
    }
    if (is('{')) {
      i++;
      while (!is('}')) {
        const key = peek();
        if (!key || !(key.type === 'string' || key.type === 'number' || key.type === 'ident')) throw new Error('key');
        i++;
        eat(':');
        data(params);
        if (!is('}')) eat(',');
      }
      i++;
      return;
    }
    throw new Error('not data');
  };
  // (function (a, b) { return DATA }(ARGS)) or (function (a, b) { return DATA })(ARGS)
  const value = () => {
    if (!(is('(') && is('function', 1))) return data(new Set());
    eat('(');
    eat('function');
    eat('(');
    const params = new Set();
    while (!is(')')) { params.add(ident()); if (!is(')')) eat(','); }
    eat(')');
    eat('{');
    eat('return');
    data(params);
    if (is(';')) i++;
    eat('}');
    const args = () => { eat('('); while (!is(')')) { data(new Set()); if (!is(')')) eat(','); } eat(')'); };
    if (is(')')) { eat(')'); args(); } else { args(); eat(')'); }
  };
  const pushArgs = () => { eat('push'); eat('('); while (!is(')')) { value(); if (!is(')')) eat(','); } eat(')'); };
  try {
    let name;
    if (is('(')) {
      // (self.X = self.X || []).push(...)
      eat('(');
      name = target();
      eat('=');
      if (target() !== name) return null;
      eat('||');
      eat('[');
      eat(']');
      eat(')');
      eat('.');
      pushArgs();
    } else {
      name = target();
      if (is('=')) { i++; value(); } else { eat('.'); pushArgs(); }
    }
    if (is(';')) i++;
    return i === sig.length && GLOBALS.has(name) ? name : null;
  } catch {
    return null;
  }
}

function collapsible(token, next) {
  if (token === 'L' || token === 'D' || token.startsWith('S:')) return true;
  if (token === ',' || token === ':' || token === '-' || token === '!' || DATA_WORDS.has(token)) return true;
  return /^[\p{ID_Start}$_][\p{ID_Continue}$]*$/u.test(token) && next === ':';
}

// Replaces every [...] or {...} region holding only literals, keys and punctuation by "D".
function collapseData(out) {
  const result = [];
  const opens = [];
  for (const token of out) {
    if (token === '[' || token === '{') {
      opens.push(result.length);
      result.push(token);
    } else if ((token === ']' || token === '}') && opens.length) {
      const start = opens.pop();
      const inner = result.slice(start + 1);
      if (inner.every((t, i) => collapsible(t, inner[i + 1]))) result.splice(start, result.length - start, 'D');
      else result.push(token);
    } else result.push(token);
  }
  return result;
}

export function templateOf(source) {
  const sig = tokenize(source).filter((t) => t.type !== 'comment');
  const dataGlobal = dataGlobalOf(sig);
  if (dataGlobal) {
    const hosts = new Set();
    for (const t of sig) {
      if (t.type === 'string' || (t.type === 'template' && !t.value.includes('${'))) {
        const v = stringValue(t);
        if (isUrlOrHost(v)) hosts.add(hostOf(v));
      }
    }
    return { hash: sha256Hex(['DATA', dataGlobal, ...[...hosts].sort()].join('\u0001')), dataGlobal };
  }
  const out = [];
  const callStack = [];
  sig.forEach((t, i) => {
    if (t.type === 'punct' && t.value === '(') {
      callStack.push(runsCode(sig, i));
      out.push('(');
      return;
    }
    if (t.type === 'punct' && t.value === ')') {
      callStack.pop();
      out.push(')');
      return;
    }
    if (t.type === 'template' && t.value.includes('${')) {
      out.push(t.value);
      return;
    }
    if (isLiteral(t)) {
      const value = t.type === 'string' || t.type === 'template' ? stringValue(t) : null;
      if (value !== null && isUrlOrHost(value)) out.push(`S:${value}`);
      else if (callStack.at(-1) === true || assignsHtml(sig, i) || /^\s*javascript:/i.test(value ?? '')) out.push(`K:${t.value}`);
      else out.push('L');
      return;
    }
    out.push(t.value);
  });
  return { hash: sha256Hex(collapseData(out).join('\u0001')), dataGlobal: null };
}

// Whether the call opening at sig[i] runs code from its string arguments: eval and friends, also as
// window['eval'](...) and (0, eval)(...), and setAttribute for an event handler or an address.
const CODE_ATTRIBUTES = /^(?:on\w+|src|href|srcdoc|action|formaction)$/i;
function runsCode(sig, i) {
  const before = sig[i - 1];
  if (before?.type === 'ident') {
    if (CODE_RUNNERS.has(before.value)) return true;
    const first = sig[i + 1];
    return before.value === 'setAttribute' && (first?.type === 'string' || first?.type === 'template') && CODE_ATTRIBUTES.test(stringValue(first));
  }
  if (before?.value === ']' || before?.value === ')') {
    const named = sig[i - 2];
    const name = named?.type === 'ident' ? named.value : named?.type === 'string' ? stringValue(named) : null;
    return CODE_RUNNERS.has(name);
  }
  return false;
}

function assignsHtml(sig, i) {
  const eq = sig[i - 1];
  const prop = sig[i - 2];
  return eq?.value === '=' && prop?.type === 'ident' && HTML_PROPERTIES.has(prop.value);
}
