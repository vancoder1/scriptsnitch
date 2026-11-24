// Step secrets (design §13) are never logged and are redacted, by value, from the snapshot and the
// evidence: a typed password can come back in a request URL, a final URL or a script that echoes it.

const MIN_LENGTH = 6;
const IDENTITY = /^(?:[0-9a-f]{64}|sha384-[A-Za-z0-9+/=]+)$/;
const steps = (list) => (Array.isArray(list) ? list : []);

// The values of every environment variable a page's steps or consent steps name (secret or TOTP
// seed), longest first. Values shorter than six characters are left alone: they would redact
// ordinary text such as dates.
export function secretValues(config, env) {
  const names = new Set();
  for (const s of [...steps(config.consent), ...config.pages.flatMap((p) => [...steps(p.steps), ...steps(p.consent)])]) {
    if (s.secret) names.add(s.secret);
    if (s.totp) names.add(s.totp);
  }
  const values = [...names].map((n) => env[n]).filter((v) => typeof v === 'string' && v.length >= MIN_LENGTH);
  return [...new Set(values)].sort((a, b) => b.length - a.length || a.localeCompare(b));
}

export function redactText(text, values) {
  let out = String(text);
  for (const v of values) {
    for (const form of new Set([v, encodeURIComponent(v), JSON.stringify(v).slice(1, -1)])) {
      if (form) out = out.split(form).join('[redacted]');
    }
  }
  return out;
}

export function redactDeep(value, values) {
  if (!values.length) return value;
  if (typeof value === 'string') return IDENTITY.test(value) ? value : redactText(value, values);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v, values)]));
  return value;
}
