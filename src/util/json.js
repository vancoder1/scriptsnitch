// Deterministic JSON output and JSON input that names where a syntax error is.

export class JsonSyntaxError extends Error {
  constructor(message, { label, line, column }) {
    super(`${label}: ${message} (line ${line}, column ${column})`);
    this.name = 'JsonSyntaxError';
    this.label = label;
    this.line = line;
    this.column = column;
  }
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortValue(value[key]);
    }
    return out;
  }
  return value;
}

// Object keys sorted at every depth, arrays in order, two-space indent, trailing newline.
export function stableStringify(value, indent = 2) {
  return `${JSON.stringify(sortValue(value), null, indent)}\n`;
}

function positionOf(text, index) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === '\n') { line++; column = 1; } else column++;
  }
  return { line, column };
}

// The first key given twice in one object, with where it is; null when there is none. Runs on text
// JSON.parse accepted, so the structure is known to be valid.
function duplicateKey(text) {
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') stack.push({ keys: new Set(), expectKey: true });
    else if (c === '[') stack.push(null);
    else if (c === '}' || c === ']') stack.pop();
    else if (c === ',' && stack.at(-1)) stack.at(-1).expectKey = true;
    else if (c === ':' && stack.at(-1)) stack.at(-1).expectKey = false;
    else if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top?.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1));
        if (top.keys.has(key)) return { key, index: i };
        top.keys.add(key);
      }
      i = j;
    }
  }
  return null;
}

// Parses JSON written by a person: tolerates a BOM and CRLF, names the line of an error, and refuses
// a key given twice in one object, where the second would silently replace the first.
export function parseJsonText(text, label) {
  const clean = String(text).replace(/^﻿/, '');
  let value;
  try {
    value = JSON.parse(clean);
  } catch (err) {
    const pos = /position (\d+)/.exec(err.message);
    const lc = /line (\d+) column (\d+)/.exec(err.message);
    const where = lc ? { line: Number(lc[1]), column: Number(lc[2]) } : positionOf(clean, pos ? Number(pos[1]) : clean.length);
    const message = err.message.replace(/ in JSON at position \d+.*$/, '').replace(/ \(line \d+ column \d+\)$/, '');
    throw new JsonSyntaxError(message, { label, ...where });
  }
  const dup = duplicateKey(clean);
  if (dup) throw new JsonSyntaxError(`"${dup.key}" appears twice in one object; the second would replace the first`, { label, ...positionOf(clean, dup.index) });
  return value;
}
