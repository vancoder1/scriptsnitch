// Code diffs (design §12): both versions of a changed script are formatted into lines (minified code
// is one long line), diffed, and the added lines that mention a host name, run code, send data or
// touch sensitive fields are marked. The issue shows up to 60 changed lines, marked hunks first.
import { tokenize } from '../analyze/tokenize.js';
import { extractHostnames } from '../analyze/hostnames.js';
import { fence } from './text.js';

const CONTEXT = 2;
const MAX_EDITS = 2000;
const NO_BREAK_AFTER_CLOSE = new Set([')', ',', ';', '.', ']', ':', '?', '?.']);

// Breaks code into lines after `;` (outside parentheses), after `{`, and around `}`; strings,
// templates, regular expressions and comments are never split. Indented by block depth.
export function formatJs(source) {
  const lines = [];
  let line = '';
  let depth = 0;
  let lineDepth = 0;
  let parens = 0;
  const flush = () => {
    const t = line.trim();
    if (t) lines.push(`${'  '.repeat(Math.max(0, lineDepth))}${t}`);
    line = '';
    lineDepth = depth;
  };
  const tokens = tokenize(source);
  let prevEnd = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    const gap = source.slice(prevEnd, tok.start);
    prevEnd = tok.start + tok.value.length;
    if (gap.includes('\n')) flush();
    else if (gap && line) line += ' ';
    if (tok.type === 'comment') {
      flush();
      for (const part of tok.value.split('\n')) { line = part; flush(); }
      continue;
    }
    if (tok.type === 'punct' && tok.value === '}') {
      flush();
      depth -= 1;
      lineDepth = depth;
      line = '}';
      const next = tokens[i + 1];
      if (!(next?.type === 'punct' && NO_BREAK_AFTER_CLOSE.has(next.value))) flush();
      continue;
    }
    line += tok.value;
    if (tok.type !== 'punct') continue;
    if (tok.value === '(') parens += 1;
    else if (tok.value === ')') parens = Math.max(0, parens - 1);
    else if (tok.value === '{') { depth += 1; flush(); }
    else if (tok.value === ';' && parens === 0) flush();
  }
  flush();
  return lines;
}

function backtrack(trace, a, b, d) {
  const out = [];
  let x = a.length;
  let y = b.length;
  for (let D = d; D > 0; D--) {
    const prev = trace[D - 1];
    const at = (k) => prev[k + D - 1];
    const k = x - y;
    const prevK = k === -D || (k !== D && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) { out.push({ op: ' ', line: a[--x] }); y--; }
    if (x === prevX) out.push({ op: '+', line: b[--y] });
    else out.push({ op: '-', line: a[--x] });
  }
  while (x > 0 && y > 0) { out.push({ op: ' ', line: a[--x] }); y--; }
  return out.reverse();
}

// Myers' O(ND) diff. Returns null when more than MAX_EDITS edits would be needed.
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((line) => ({ op: '+', line }));
  if (!m) return a.map((line) => ({ op: '-', line }));
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= Math.min(max, MAX_EDITS); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d);
    }
    trace.push(v.slice(off - d, off + d + 1));
  }
  return null;
}

export function diffLines(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const mid = myers(a.slice(start, endA), b.slice(start, endB));
  if (!mid) return null;
  const same = (lines) => lines.map((line) => ({ op: ' ', line }));
  return [...same(a.slice(0, start)), ...mid, ...same(a.slice(endA))];
}

const CODE_RUN = /\beval\s*\(|\bFunction\s*\(|\bset(?:Timeout|Interval)\s*\(\s*['"`]|document\.write|\b(?:inner|outer)HTML\s*=|insertAdjacentHTML|createElement\(\s*['"`]script|WebAssembly\./;
const NETWORK = /\bfetch\s*\(|sendBeacon|XMLHttpRequest|\bWebSocket\b|\bEventSource\b|new\s+Image\b|\.src\s*=|RTCPeerConnection/;
const SENSITIVE = /card.?num|cc-?(?:number|num|exp|csc|name)|\bcv[cv]2?\b|password|passwd|\biban\b|security.?code|expir/i;

export function markLine(line) {
  const marks = [];
  if (extractHostnames(line).length) marks.push('hostname');
  if (CODE_RUN.test(line)) marks.push('code-run');
  if (NETWORK.test(line)) marks.push('network');
  if (SENSITIVE.test(line)) marks.push('sensitive-field');
  return marks;
}

const show = (op, line) => {
  const marks = op === '+' ? markLine(line) : [];
  return `${op}${line}${marks.length ? `   ◀ ${marks.join(', ')}` : ''}`;
};

function hunks(ops) {
  const changed = ops.map((o, i) => (o.op === ' ' ? -1 : i)).filter((i) => i >= 0);
  const out = [];
  for (const i of changed) {
    const last = out.at(-1);
    if (last && i - CONTEXT <= last.end + CONTEXT) last.end = i;
    else out.push({ start: i, end: i });
  }
  return out.map(({ start, end }) => {
    const from = Math.max(0, start - CONTEXT);
    const to = Math.min(ops.length - 1, end + CONTEXT);
    const lines = ops.slice(from, to + 1);
    return { from, lines, changes: lines.filter((o) => o.op !== ' ').length, marked: lines.some((o) => o.op === '+' && markLine(o.line).length) };
  });
}

const renderHunk = (h, limit = Infinity) => {
  const out = [`@@ line ${h.from + 1} @@`];
  let changes = 0;
  for (const o of h.lines) {
    if (o.op !== ' ' && changes >= limit) break;
    if (o.op !== ' ') changes++;
    out.push(show(o.op, o.line));
  }
  return { text: out.join('\n'), changes };
};

function excerpt(lines, maxLines, why) {
  const marked = lines.map((l, i) => (markLine(l).length ? i : -1)).filter((i) => i >= 0);
  const keep = new Set();
  for (const i of marked) for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) keep.add(j);
  const picked = (keep.size ? [...keep].sort((a, b) => a - b) : lines.map((_, i) => i)).slice(0, maxLines);
  const text = picked.map((i) => { const marks = markLine(lines[i]); return `${lines[i]}${marks.length ? `   ◀ ${marks.join(', ')}` : ''}`; }).join('\n');
  return { issue: `${why}\n\n${fence(text, 'js')}`, full: fence(lines.slice(0, 5000).join('\n'), 'js') };
}

export function renderDiff(oldSource, newSource, { maxLines = 60 } = {}) {
  const next = formatJs(newSource);
  if (oldSource === null || oldSource === undefined) return excerpt(next, maxLines, 'No earlier copy of this script was available, so here is an excerpt of the new code with the lines that need a look marked.');
  const ops = diffLines(formatJs(oldSource), next);
  if (!ops) return excerpt(next, maxLines, 'The change is too large to show as a diff, so here is an excerpt of the new code with the lines that need a look marked.');
  const all = hunks(ops);
  const full = fence(all.map((h) => renderHunk(h).text).join('\n'), 'diff');
  const ordered = [...all.filter((h) => h.marked), ...all.filter((h) => !h.marked)];
  const parts = [];
  let budget = maxLines;
  for (const h of ordered) {
    if (budget <= 0) break;
    const r = renderHunk(h, budget);
    parts.push(r.text);
    budget -= r.changes;
  }
  const total = all.reduce((s, h) => s + h.changes, 0);
  const more = total - (maxLines - budget);
  return { issue: `${fence(parts.join('\n'), 'diff')}${more > 0 ? `\n\n…and ${more} more changed lines in the job summary and in \`scriptsnitch-out/diffs/\`.` : ''}`, full };
}
