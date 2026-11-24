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

// Parses JSON written by a person: tolerates a BOM and CRLF, and names the line of an error.
export function parseJsonText(text, label) {
  const clean = String(text).replace(/^﻿/, '');
  try {
    return JSON.parse(clean);
  } catch (err) {
    const pos = /position (\d+)/.exec(err.message);
    const lc = /line (\d+) column (\d+)/.exec(err.message);
    const where = lc ? { line: Number(lc[1]), column: Number(lc[2]) } : positionOf(clean, pos ? Number(pos[1]) : clean.length);
    const message = err.message.replace(/ in JSON at position \d+.*$/, '').replace(/ \(line \d+ column \d+\)$/, '');
    throw new JsonSyntaxError(message, { label, ...where });
  }
}
