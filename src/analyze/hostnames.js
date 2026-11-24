// Hostnames a script's code mentions (design §10 "Scores"): found in decoded string values only,
// never in property names or other code.
import { readFileSync } from 'node:fs';
import { tokenize, stringValue } from './tokenize.js';

const readData = (name) => readFileSync(new URL(`../../data/${name}`, import.meta.url), 'utf8');
const IGNORED = new Set(JSON.parse(readData('namespace-hosts.json')));
const TLDS = readData('tlds.txt').split('\n').filter(Boolean);

// TLDs that make a bare string a hostname: the classic and commonly abused ones, and every two-letter
// country code except those that are mostly file extensions in code. Word-like new TLDs (.page,
// .name, .click, .style) do not count unless the string is a URL.
const FILE_EXTENSION_TLDS = new Set(['md', 'py', 'sh', 'pl', 'ps', 'rs', 'ai', 'mk', 'pm', 'gs', 'tf', 'ms']);
const BARE_TLDS = new Set([
  'com', 'net', 'org', 'info', 'biz', 'xyz', 'top', 'online', 'site', 'club', 'shop', 'store', 'pro', 'cloud',
  'icu', 'cyou', 'buzz', 'rest', 'bar', 'monster', 'sbs', 'cfd', 'live', 'app', 'dev',
  ...TLDS.filter((t) => t.length === 2 && !FILE_EXTENSION_TLDS.has(t)),
]);

const URL_HOST = /(?:\b[a-z][a-z0-9+.-]*:)?\/\/(\[[0-9a-f:.]+\]|[a-z0-9-]+(?:\.[a-z0-9-]+)+)(?::\d+)?/gi;
const BARE_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const BASE64 = /^[A-Za-z0-9+/_-]{8,}={0,2}$/;

export const isIgnoredHost = (host) => IGNORED.has(String(host).toLowerCase());

const validLabels = (host) => host.split('.').every((l) => l.length > 0 && l.length <= 63 && !l.startsWith('-') && !l.endsWith('-'));

function isIpv4(value) {
  const m = IPV4.exec(value);
  return Boolean(m) && m.slice(1).every((n) => Number(n) <= 255);
}

function decodeBase64(value) {
  if (!BASE64.test(value) || value.length % 4 === 1) return null;
  const text = Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('latin1');
  const printable = [...text].filter((c) => c >= ' ' && c <= '~').length;
  return text.length && printable / text.length > 0.9 ? text : null;
}

// String values, with chains joined by "+": 'ba' + 'ways.com' reads as 'baways.com'.
function stringValues(source) {
  const sig = tokenize(source).filter((t) => t.type !== 'comment');
  const values = [];
  const isString = (t) => t && (t.type === 'string' || (t.type === 'template' && !t.value.includes('${')));
  for (let i = 0; i < sig.length; i++) {
    if (!isString(sig[i])) continue;
    let value = stringValue(sig[i]);
    while (sig[i + 1]?.value === '+' && isString(sig[i + 2])) {
      value += stringValue(sig[i + 2]);
      i += 2;
    }
    values.push(value);
  }
  return values;
}

function hostsIn(value, out) {
  if (value.startsWith('data:')) return;
  for (const m of value.matchAll(URL_HOST)) {
    const host = m[1].toLowerCase().replace(/^\[|\]$/g, '');
    if (host.includes(':') || isIpv4(host) || validLabels(host)) out.add(host);
  }
  if (isIpv4(value)) out.add(value);
  else if (BARE_HOST.test(value) && validLabels(value)) {
    const labels = value.toLowerCase().split('.');
    if (BARE_TLDS.has(labels.at(-1)) && labels.at(-2).length >= 2 && !/^\d+$/.test(labels.at(-2))) out.add(value.toLowerCase());
  }
}

export function extractHostnames(source) {
  const hosts = new Set();
  for (const value of stringValues(source)) {
    hostsIn(value, hosts);
    const decoded = decodeBase64(value);
    if (decoded) hostsIn(decoded, hosts);
  }
  return [...hosts].filter((h) => !isIgnoredHost(h)).sort();
}
