// The form probe's values and how they are found again (design §11): fresh, realistic fake values
// every run, searched for in every common encoding; and the growth test that catches encrypted
// payloads by comparing two probes with values of very different lengths.

const FIRST = ['Olivia', 'Liam', 'Emma', 'Noah', 'Ava', 'Lucas', 'Mia', 'Ethan', 'Chloe', 'Mason', 'Sofia', 'Logan', 'Amelia', 'Jacob', 'Harper', 'Leo'];
const LAST = ['Martin', 'Tremblay', 'Roy', 'Gagnon', 'Wilson', 'Taylor', 'Brown', 'Smith', 'Lee', 'Johnson', 'Morin', 'Lavoie', 'Clark', 'Walker', 'Young', 'King'];
const DOMAINS = ['gmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'hotmail.com', 'proton.me'];
const STREETS = ['Maple', 'Oak', 'Cedar', 'Elm', 'Pine', 'Birch', 'Willow', 'Spruce'];
const KIND_OF = { card: 'card', expiry: 'card', cvc: 'card', email: 'email', name: 'name', password: 'password', iban: 'iban' };
const MIN_SEARCH_LENGTH = 6;

function luhnDigit(body) {
  let sum = 0;
  for (let i = 0; i < body.length; i++) {
    let d = Number(body[body.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}

export function luhnValid(digits) {
  return /^\d{12,19}$/.test(digits) && luhnDigit(digits.slice(0, -1)) === digits.at(-1);
}

const ibanNumber = (s) => s.toUpperCase().replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
export function ibanValid(iban) {
  const s = iban.replace(/\s/g, '');
  return /^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(s) && BigInt(ibanNumber(s.slice(4) + s.slice(0, 4))) % 97n === 1n;
}

export function probeValues(random = Math.random, { lengthBoost = 0, now = Date.now() } = {}) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const digits = (n) => Array.from({ length: n }, () => Math.floor(random() * 10)).join('');
  const letters = (n) => Array.from({ length: n }, () => String.fromCharCode(97 + Math.floor(random() * 26))).join('');
  const prefix = pick(['4', '51', '52', '53', '54', '55', String(2221 + Math.floor(random() * 500))]);
  const body = prefix + digits(15 - prefix.length);
  const year = (new Date(now).getUTCFullYear() % 100) + 2 + Math.floor(random() * 4);
  const first = pick(FIRST);
  const last = pick(LAST);
  const boost = lengthBoost ? letters(lengthBoost) : '';
  const bban = digits(18);
  const check = String(98n - (BigInt(ibanNumber(`${bban}DE00`)) % 97n)).padStart(2, '0');
  const pass = Array.from({ length: 14 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#%*'[Math.floor(random() * 61)]).join('');
  return {
    card: body + luhnDigit(body),
    expiry: `${String(1 + Math.floor(random() * 12)).padStart(2, '0')}/${String(year).padStart(2, '0')}`,
    cvc: String(100 + Math.floor(random() * 900)),
    name: `${first} ${last}${boost ? ` ${boost}` : ''}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}${digits(3)}${boost}@${pick(DOMAINS)}`,
    password: `${pass}${boost}`,
    iban: `DE${check}${bban}`,
    phone: `+1 613 555 ${digits(4)}`,
    postcode: `${letters(1).toUpperCase()}${digits(1)}${letters(1).toUpperCase()} ${digits(1)}${letters(1).toUpperCase()}${digits(1)}`,
    address: `${10 + Math.floor(random() * 890)} ${pick(STREETS)} Street${boost ? ` ${boost}` : ''}`,
    other: `${pick(STREETS)}${boost}`,
  };
}

// The base64 characters that depend only on the value, when it sits at byte offset k mod 3 of a
// larger encoded payload.
function base64Middles(bytes) {
  const out = [];
  for (const k of [0, 1, 2]) {
    const b64 = Buffer.concat([Buffer.alloc(k), bytes]).toString('base64');
    const start = k === 0 ? 0 : k === 1 ? 2 : 3;
    const end = Math.floor((k + bytes.length) / 3) * 4;
    if (end - start >= 8) out.push(b64.slice(start, end));
  }
  return out;
}

export function encodings(value) {
  const bytes = Buffer.from(value, 'utf8');
  const list = [['raw', value]];
  const once = encodeURIComponent(value);
  if (once !== value) list.push(['url-encoded', once]);
  const twice = encodeURIComponent(once);
  if (twice !== once) list.push(['url-encoded twice', twice]);
  list.push(['json-escaped', [...value].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')]);
  const hex = bytes.toString('hex');
  list.push(['hex', hex], ['hex', hex.toUpperCase()]);
  for (const m of base64Middles(bytes)) list.push(['base64', m]);
  for (const m of base64Middles(bytes)) list.push(['base64url', m.replace(/\+/g, '-').replace(/\//g, '_')]);
  if (/^\d{16}$/.test(value)) {
    list.push(['spaced', value.replace(/(\d{4})(?=\d)/g, '$1 ')], ['dashed', value.replace(/(\d{4})(?=\d)/g, '$1-')]);
  }
  return list;
}

// Each probe value found in text, once, with the first encoding that matched.
export function findValues(text, values) {
  const found = [];
  for (const [name, value] of Object.entries(values)) {
    const kind = KIND_OF[name];
    if (!kind || !value || value.length < MIN_SEARCH_LENGTH) continue;
    const hit = encodings(value).find(([, encoded]) => text.includes(encoded));
    if (hit) found.push({ kind, encoding: hit[0] });
  }
  return found;
}

function fieldsOf(request) {
  const out = new Map();
  let url;
  try { url = new URL(request.url); } catch { return out; }
  for (const [k, v] of url.searchParams) out.set(`query:${k}`, v.length);
  const body = request.body ?? '';
  try {
    const json = JSON.parse(body);
    if (json && typeof json === 'object') {
      for (const [k, v] of Object.entries(json)) out.set(k, JSON.stringify(v).length);
      return out;
    }
  } catch { /* not JSON */ }
  if (body.includes('=')) for (const [k, v] of new URLSearchParams(body)) out.set(k, v.length);
  else if (body) out.set('', body.length);
  return out;
}

const endpoint = (r) => { try { const u = new URL(r.url); return `${r.method} ${u.origin}${u.pathname}`; } catch { return `${r.method} ${r.url}`; } };

// Request fields whose size grew by at least three quarters of the extra input between two probes.
export function growthFields(before, after, lengthDelta) {
  const out = [];
  const seen = new Set();
  const earlier = new Map(before.map((r) => [endpoint(r), fieldsOf(r)]));
  for (const r of after) {
    const key = endpoint(r);
    const old = earlier.get(key);
    if (!old) continue;
    for (const [field, size] of fieldsOf(r)) {
      const was = old.get(field);
      if (was === undefined || size - was < 0.75 * lengthDelta) continue;
      const url = key.slice(key.indexOf(' ') + 1);
      const id = `${url}|${field}`;
      if (!seen.has(id)) { seen.add(id); out.push({ url, field }); }
    }
  }
  return out;
}
