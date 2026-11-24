// A cheap obfuscation score mapped to bands (design §10 "Scores"): plain, minified, packed.
// Minification alone never reaches packed; embedded images, fonts and WebAssembly are left out.
import { tokenize, stringValue } from './tokenize.js';

const DATA_URL = /data:[a-z]+\/[a-z0-9.+-]+(?:;[a-z0-9-]+=[^;,"')]+)*;base64,[A-Za-z0-9+/=]+/gi;
const BINARY_MAGIC = [[0x89, 0x50, 0x4e, 0x47], [0xff, 0xd8, 0xff], [0x47, 0x49, 0x46, 0x38], [0x77, 0x4f, 0x46, 0x46], [0x77, 0x4f, 0x46, 0x32], [0x00, 0x61, 0x73, 0x6d], [0x25, 0x50, 0x44, 0x46]];

function entropy(s) {
  const counts = new Map();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function isEmbeddedBinary(value) {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) return false;
  const head = Buffer.from(value.slice(0, 16), 'base64');
  return BINARY_MAGIC.some((magic) => magic.every((b, i) => head[i] === b));
}

export function obfuscationBand(source) {
  const src = source.replace(DATA_URL, 'D');
  const kb = Math.max(src.length / 1024, 0.25);
  const hexIdentifiers = (src.match(/\b_0x[0-9a-f]{4,}\b/g) ?? []).length;
  const escapes = (src.match(/\\x[0-9a-fA-F]{2}|\\u[0-9a-fA-F]{4}/g) ?? []).length;
  const runners = (src.match(/\b(?:eval|atob|fromCharCode|unescape|Function)\s*\(/g) ?? []).length;
  let highEntropy = 0;
  let highEntropyChars = 0;
  for (const t of tokenize(src)) {
    if (t.type !== 'string' || t.value.length < 100) continue;
    const value = stringValue(t);
    if (isEmbeddedBinary(value)) continue;
    if (entropy(value) > 4.5) {
      highEntropy++;
      highEntropyChars += value.length;
    }
  }
  if (hexIdentifiers / kb > 2 || escapes / kb > 20 || (highEntropy >= 2 && highEntropyChars / src.length > 0.3) || (runners / kb > 3 && highEntropy >= 1)) {
    return 'packed';
  }
  const lines = src.split('\n').length;
  const whitespace = (src.match(/\s/g) ?? []).length / Math.max(src.length, 1);
  if (src.length / lines > 300 || whitespace < 0.08) return 'minified';
  return 'plain';
}

export const BAND_ORDER = { plain: 0, minified: 1, packed: 2 };
