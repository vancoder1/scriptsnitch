// A small JavaScript tokenizer: enough to tell strings, numbers, regular expressions, templates,
// identifiers, punctuation and comments apart in real-world (often minified) code. It never throws:
// an unterminated token runs to the end of the source.

const PUNCTUATORS = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '>>>', '&&=', '||=', '??=',
  '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
];
const REGEX_AFTER_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'instanceof', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'of']);
const LINE_END = /[\n\r\u2028\u2029]/g;
const IDENT_START = /[\p{ID_Start}$_\\]/u;
const IDENT_PART = /[\p{ID_Continue}$‌‍\\]/u;

function regexAllowed(prev) {
  if (!prev) return true;
  if (prev.type === 'ident') return REGEX_AFTER_WORDS.has(prev.value);
  if (prev.type === 'punct') return !(prev.value === ')' || prev.value === ']' || prev.value === '}' || prev.value === '++' || prev.value === '--');
  return false;
}

function readQuoted(src, i, quote) {
  let j = i + 1;
  while (j < src.length && src[j] !== quote) {
    if (src[j] === '\\') j++;
    else if (src[j] === '\n') break;
    j++;
  }
  return Math.min(j + 1, src.length);
}

function readTemplate(src, i) {
  let j = i + 1;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '`') return j + 1;
    if (ch === '$' && src[j + 1] === '{') {
      let depth = 1;
      j += 2;
      while (j < src.length && depth > 0) {
        const c = src[j];
        if (c === '"' || c === "'") { j = readQuoted(src, j, c); continue; }
        if (c === '`') { j = readTemplate(src, j); continue; }
        if (c === '{') depth++;
        else if (c === '}') depth--;
        j++;
      }
      continue;
    }
    j++;
  }
  return src.length;
}

function readRegex(src, i) {
  let j = i + 1;
  let inClass = false;
  while (j < src.length) {
    const ch = src[j];
    if (ch === '\\') { j += 2; continue; }
    if (ch === '\n') return null;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      j++;
      while (j < src.length && /[a-z]/i.test(src[j])) j++;
      return j;
    }
    j++;
  }
  return null;
}

function readNumber(src, i) {
  const m = /^(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/.exec(src.slice(i, i + 400));
  return i + (m ? m[0].length : 1);
}

export function tokenize(src) {
  const tokens = [];
  let prev = null;
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    let end;
    let type;
    if (ch === '/' && src[i + 1] === '/') {
      // A line comment ends at any line terminator JavaScript knows, not only \n: code after a
      // \r, U+2028 or U+2029 runs, so it must not be read as part of the comment.
      LINE_END.lastIndex = i;
      end = LINE_END.exec(src)?.index ?? src.length;
      type = 'comment';
    } else if (ch === '/' && src[i + 1] === '*') {
      end = src.indexOf('*/', i + 2);
      end = end === -1 ? src.length : end + 2;
      type = 'comment';
    } else if (ch === '"' || ch === "'") {
      end = readQuoted(src, i, ch);
      type = 'string';
    } else if (ch === '`') {
      end = readTemplate(src, i);
      type = 'template';
    } else if (/\d/.test(ch) || (ch === '.' && /\d/.test(src[i + 1] ?? ''))) {
      end = readNumber(src, i);
      type = 'number';
    } else if (IDENT_START.test(ch)) {
      end = i + 1;
      while (end < src.length && IDENT_PART.test(src[end])) end++;
      type = 'ident';
    } else if (ch === '/' && regexAllowed(prev) && (end = readRegex(src, i)) !== null) {
      type = 'regex';
    } else {
      const op = PUNCTUATORS.find((p) => src.startsWith(p, i));
      end = i + (op ? op.length : 1);
      type = 'punct';
    }
    const token = { type, value: src.slice(i, end), start: i };
    tokens.push(token);
    if (type !== 'comment') prev = token;
    i = end;
  }
  return tokens;
}

const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

// The value a string literal (or an expression-free template) stands for, escapes decoded.
export function stringValue(token) {
  const body = token.value.slice(1, token.value.endsWith(token.value[0]) && token.value.length > 1 ? -1 : undefined);
  return body.replace(/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|(\r\n|\n)|(.))/g, (m, x, ub, u, nl, c) => {
    if (x) return String.fromCharCode(parseInt(x, 16));
    if (ub) return String.fromCodePoint(Math.min(parseInt(ub, 16), 0x10ffff));
    if (u) return String.fromCharCode(parseInt(u, 16));
    if (nl) return '';
    return SIMPLE_ESCAPES[c] ?? c;
  });
}

export const isLiteral = (t) => t.type === 'string' || t.type === 'number' || t.type === 'regex' || (t.type === 'template' && !t.value.includes('${'));
