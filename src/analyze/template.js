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
const HOST_LIKE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?$/i;

export const isUrlOrHost = (value) => URL_LIKE.test(value) || HOST_LIKE.test(value);

function hostOf(value) {
  try { return new URL(value.startsWith('//') ? `https:${value}` : value).hostname; } catch { return value.toLowerCase(); }
}

// One top-level statement that assigns to, or pushes onto, a known framework data global.
function dataGlobalOf(sig) {
  let depth = 0;
  let statements = 0;
  for (let i = 0; i < sig.length; i++) {
    const v = sig[i].value;
    if (sig[i].type === 'punct') {
      if (v === '(' || v === '[' || v === '{') depth++;
      else if (v === ')' || v === ']' || v === '}') depth--;
      else if (v === ';' && depth === 0 && i < sig.length - 1) statements++;
    }
  }
  if (statements > 0) return null;
  for (const t of sig.slice(0, 12)) {
    if (t.type === 'ident' && GLOBALS.has(t.value)) return t.value;
  }
  return null;
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
    const kept = sig.filter((t, i) => isLiteral(t) && insideCodeRunner(sig, i)).map((t) => t.value);
    return { hash: sha256Hex(['DATA', dataGlobal, ...[...hosts].sort(), ...kept].join('\u0001')), dataGlobal };
  }
  const out = [];
  const callStack = [];
  sig.forEach((t, i) => {
    if (t.type === 'punct' && t.value === '(') {
      const before = sig[i - 1];
      callStack.push(before?.type === 'ident' && CODE_RUNNERS.has(before.value));
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
      else if (callStack.at(-1) === true || assignsHtml(sig, i)) out.push(`K:${t.value}`);
      else out.push('L');
      return;
    }
    out.push(t.value);
  });
  return { hash: sha256Hex(collapseData(out).join('\u0001')), dataGlobal: null };
}

function insideCodeRunner(sig, index) {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const v = sig[i].value;
    if (sig[i].type !== 'punct') continue;
    if (v === ')') depth++;
    else if (v === '(') {
      if (depth === 0) return sig[i - 1]?.type === 'ident' && CODE_RUNNERS.has(sig[i - 1].value);
      depth--;
    }
  }
  return false;
}

function assignsHtml(sig, i) {
  const eq = sig[i - 1];
  const prop = sig[i - 2];
  return eq?.value === '=' && prop?.type === 'ident' && HTML_PROPERTIES.has(prop.value);
}
