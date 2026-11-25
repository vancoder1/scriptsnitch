// Text that reaches GitHub. Everything scriptsnitch shows in an issue, comment or pull request body
// about a site (script URLs, code, header values, page titles) is untrusted: an attacker controls
// it. It is escaped, so it renders as plain text, and neutralized, so it never mentions anyone,
// links anywhere or references other issues.

const ZWJ = '‍';

// Stops @mentions (not e-mail addresses), autolinked URLs and #123 references.
export function neutralize(text) {
  return String(text)
    .replace(/(^|[^\w@.])@(?=[A-Za-z0-9])/g, `$1@${ZWJ}`)
    .replace(/\b(https?|ftp|wss?):\/\//gi, '$1[:]//')
    .replace(/\bwww\./gi, 'www[.]')
    .replace(/(^|[^\w&])#(?=\d)/g, `$1#${ZWJ}`);
}

// Plain inline text, safe in a paragraph or a table cell: one line, no HTML, no Markdown syntax.
export function md(text) {
  const escaped = String(text)
    .replace(/[\r\n]+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]|~!])/g, '\\$1');
  return neutralize(escaped);
}

const longestRun = (text) => Math.max(0, ...(String(text).match(/`+/g) ?? []).map((r) => r.length));

// A code block whose fence is longer than any run of backticks inside, so the code cannot end it.
export function fence(codeText, lang = '') {
  const ticks = '`'.repeat(Math.max(3, longestRun(codeText) + 1));
  return `${ticks}${lang}\n${codeText}\n${ticks}`;
}

// An inline code span that backticks inside cannot close. Code spans are never autolinked.
export function code(text) {
  const s = String(text).replace(/[\r\n]+/g, ' ');
  const run = longestRun(s);
  if (!run) return `\`${s}\``;
  const ticks = '`'.repeat(run + 1);
  return `${ticks} ${s} ${ticks}`;
}

// An inline code span for a table cell. GitHub splits a cell at every pipe, even inside a code span,
// unless a backslash comes before it (it then shows a plain pipe). Script URLs may hold pipes, and
// without this the rest of a URL would leave its cell as live Markdown.
export const cellCode = (text) => code(text).replace(/\|/g, '\\|');
