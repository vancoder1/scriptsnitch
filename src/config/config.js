// scriptsnitch/config.json: what to visit, how, and who to tell (design §13).
import { readFileSync } from 'node:fs';
import { parseJsonText, JsonSyntaxError } from '../util/json.js';
import { checkValue, SchemaError, join } from './schema.js';

export class ConfigError extends Error {
  constructor(message, { label, pointer = null }) {
    super(`${label}${pointer !== null ? ` ${pointer || '/'}` : ''}: ${message}`);
    this.name = 'ConfigError';
    this.label = label;
    this.pointer = pointer;
  }
}

const LOCAL_HTTP_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|[a-z0-9-]+(\.[a-z0-9-]+)*\.test)$/i;

function checkPageUrl(url) {
  let u;
  try { u = new URL(url); } catch { return `"${url}" is not a URL`; }
  if (u.protocol === 'https:') return null;
  if (u.protocol === 'http:' && LOCAL_HTTP_HOST.test(u.hostname)) return null;
  return `"${url}" must use https (plain http is only accepted for localhost and *.test hosts)`;
}

function checkOrigin(origin) {
  let u;
  try { u = new URL(origin); } catch { return `"${origin}" is not an origin`; }
  return u.origin === origin ? null : `"${origin}" is not an origin; write it as ${u.origin}`;
}

const string = { type: 'string' };
const selector = { type: 'string', pattern: /\S/, patternMessage: 'a selector cannot be empty' };

const step = {
  type: 'object',
  fields: {
    goto: { spec: { type: 'string', check: checkPageUrl } },
    click: { spec: selector },
    type: { spec: selector },
    value: { spec: string },
    secret: { spec: { type: 'string', pattern: /^[A-Za-z_][A-Za-z0-9_]*$/, patternMessage: 'secret names an environment variable' } },
    totp: { spec: { type: 'string', pattern: /^[A-Za-z_][A-Za-z0-9_]*$/, patternMessage: 'totp names an environment variable holding a base32 seed' } },
    wait: { spec: { oneOf: [selector, { type: 'integer', min: 0, max: 60000 }], message: 'wait is a selector or a number of milliseconds up to 60000' } },
  },
  check(s) {
    const actions = ['goto', 'click', 'type', 'wait'].filter((a) => s[a] !== undefined);
    if (actions.length !== 1) return 'a step does exactly one of goto, click, type or wait';
    const sources = ['value', 'secret', 'totp'].filter((k) => s[k] !== undefined);
    if (s.type !== undefined && sources.length !== 1) return 'a type step needs exactly one of value, secret or totp';
    if (s.type === undefined && sources.length) return `${sources[0]} belongs to a type step`;
    return null;
  },
};

const consent = { oneOf: [{ type: 'string', enum: ['accept', 'ignore'] }, { type: 'array', items: step }], message: 'consent is "accept", "ignore" or a list of steps' };

const settle = {
  type: 'object',
  fields: {
    quietMs: { spec: { type: 'integer', min: 100, max: 30000 }, default: 1000 },
    scriptQuietMs: { spec: { type: 'integer', min: 100, max: 30000 }, default: 1500 },
    capMs: { spec: { type: 'integer', min: 1000, max: 120000 }, default: 15000 },
  },
};

const expect = {
  type: 'object',
  fields: { selector: { spec: selector }, text: { spec: { type: 'string', pattern: /\S/, patternMessage: 'text cannot be empty' } } },
  check: (e) => (Object.keys(e).length === 1 ? null : 'expect is either {"selector": …} or {"text": …}'),
};

const page = {
  type: 'object',
  fields: {
    name: { spec: { type: 'string', pattern: /\S/, patternMessage: 'a page needs a name' }, required: true },
    url: { spec: { type: 'string', check: checkPageUrl }, required: true },
    site: { spec: { type: 'string', check: checkOrigin } },
    sensitive: { spec: { type: 'boolean' }, default: false },
    expect: { spec: expect },
    steps: { spec: { type: 'array', items: step }, default: [] },
    probe: { spec: { oneOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto'] }], message: 'probe is true, false or "auto"' }, default: 'auto' },
    consent: { spec: consent },
    settle: { spec: settle },
  },
};

const deployMarker = {
  oneOf: [
    { type: 'object', fields: { url: { spec: { type: 'string', check: checkPageUrl }, required: true } } },
    { type: 'object', fields: { page: { spec: { type: 'string', pattern: /^\//, patternMessage: 'page is a path' }, required: true }, selector: { spec: selector, required: true }, attribute: { spec: string, required: true } } },
  ],
  message: 'deployMarker is {"url": …} or {"page": …, "selector": …, "attribute": …}',
};

const FIELD_KINDS = ['password', 'card', 'iban', 'email', 'name'];

const config = {
  type: 'object',
  fields: {
    approved: { spec: string, default: 'scriptsnitch/approved.json' },
    notify: { spec: { type: 'array', items: { type: 'string', pattern: /^[A-Za-z0-9-]+$/, patternMessage: 'notify lists GitHub user names' }, unique: true }, default: [] },
    profiles: { spec: { type: 'array', items: { type: 'string', enum: ['desktop', 'mobile'] }, minItems: 1, unique: true }, default: ['desktop', 'mobile'] },
    block: { spec: { type: 'array', items: { type: 'string', enum: ['image', 'media', 'font'] }, unique: true }, default: ['image', 'media', 'font'] },
    concurrency: { spec: { type: 'integer', min: 1, max: 16 }, default: 4 },
    requireReasons: { spec: { type: 'boolean' }, default: true },
    frames: { spec: { type: 'string', enum: ['own', 'all'] }, default: 'own' },
    fields: { spec: { type: 'object', fields: Object.fromEntries(FIELD_KINDS.map((k) => [k, { spec: { type: 'array', items: selector } }])) }, default: {} },
    consent: { spec: consent, default: 'accept' },
    sites: { spec: { type: 'object', values: { type: 'object', fields: { deployMarker: { spec: deployMarker } } } }, default: {} },
    pages: { spec: { type: 'array', items: page, minItems: 1 }, required: true },
  },
};

export function parseConfig(text, label) {
  let raw;
  try {
    raw = parseJsonText(text, label);
  } catch (err) {
    if (err instanceof JsonSyntaxError) throw new ConfigError(`${err.message.replace(`${label}: `, '')}`, { label });
    throw err;
  }
  let c;
  try {
    c = checkValue(raw, config, '');
    for (const origin of Object.keys(c.sites)) {
      const message = checkOrigin(origin);
      if (message) throw new SchemaError(message, join('/sites', origin));
    }
    const names = new Set();
    c.pages.forEach((p, i) => {
      if (names.has(p.name)) throw new SchemaError(`another page is already named "${p.name}"`, `/pages/${i}/name`);
      names.add(p.name);
    });
  } catch (err) {
    if (err instanceof SchemaError) throw new ConfigError(err.detail, { label, pointer: err.pointer });
    throw err;
  }
  for (const p of c.pages) {
    const u = new URL(p.url);
    p.site ??= u.origin;
    p.path = u.pathname;
    p.expect ??= null;
    p.consent ??= c.consent;
    p.settle ??= { quietMs: 1000, scriptQuietMs: 1500, capMs: 15000 };
  }
  return c;
}

export function loadConfig(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (err) {
    throw new ConfigError(err.code === 'ENOENT' ? 'file not found; create it or set the config input' : err.message, { label: path });
  }
  return parseConfig(text, path);
}
