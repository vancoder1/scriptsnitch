// A small schema checker shared by the config, the approved file and the snapshot. Errors carry a
// JSON pointer to the offending value and say how to fix it.

export class SchemaError extends Error {
  constructor(message, pointer) {
    super(pointer ? `${pointer || '/'}: ${message}` : message);
    this.name = 'SchemaError';
    this.pointer = pointer;
    this.detail = message;
  }
}

export const escapePointer = (key) => String(key).replace(/~/g, '~0').replace(/\//g, '~1');
export const join = (pointer, key) => `${pointer}/${escapePointer(key)}`;

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

// spec shapes:
//   { type: 'string', enum?, pattern?, check?(v) -> message|null }
//   { type: 'boolean' } | { type: 'integer', min?, max? } | { type: 'number', min? }
//   { type: 'array', items, minItems?, unique? }
//   { type: 'object', fields: { name: { spec, required?, default? } }, values?: spec, check? }
//   { type: 'any' } | { oneOf: [spec, ...], message }
// Returns the value with defaults filled in.
export function checkValue(value, spec, pointer = '') {
  if (spec.oneOf) {
    for (const option of spec.oneOf) {
      try { return checkValue(value, option, pointer); } catch { /* try the next */ }
    }
    throw new SchemaError(spec.message, pointer);
  }
  const actual = typeOf(value);
  const expected = spec.type;
  if (expected === 'any') return value;
  if (expected === 'integer') {
    if (!Number.isInteger(value)) throw new SchemaError(`expected a whole number, got ${actual}`, pointer);
    if (spec.min !== undefined && value < spec.min) throw new SchemaError(`must be at least ${spec.min}`, pointer);
    if (spec.max !== undefined && value > spec.max) throw new SchemaError(`must be at most ${spec.max}`, pointer);
  } else if (expected === 'number') {
    if (actual !== 'number' || !Number.isFinite(value)) throw new SchemaError(`expected a number, got ${actual}`, pointer);
    if (spec.min !== undefined && value < spec.min) throw new SchemaError(`must be at least ${spec.min}`, pointer);
  } else if (actual !== expected) {
    throw new SchemaError(`expected ${expected === 'object' ? 'an object' : `a ${expected}`}, got ${actual}`, pointer);
  }
  if (expected === 'string') {
    if (spec.enum && !spec.enum.includes(value)) throw new SchemaError(`must be one of ${spec.enum.join(', ')}`, pointer);
    if (spec.pattern && !spec.pattern.test(value)) throw new SchemaError(spec.patternMessage ?? `"${value}" is not valid here`, pointer);
  }
  let out = value;
  if (expected === 'array') {
    if (spec.minItems !== undefined && value.length < spec.minItems) throw new SchemaError(`needs at least ${spec.minItems} item${spec.minItems === 1 ? '' : 's'}`, pointer);
    out = value.map((item, i) => checkValue(item, spec.items, join(pointer, i)));
    if (spec.unique) {
      const seen = new Set();
      out.forEach((item, i) => {
        const key = JSON.stringify(item);
        if (seen.has(key)) throw new SchemaError(`duplicate value ${key}`, join(pointer, i));
        seen.add(key);
      });
    }
  }
  if (expected === 'object') {
    out = {};
    const fields = spec.fields ?? {};
    for (const key of Object.keys(value)) {
      if (!(key in fields) && !spec.values) throw new SchemaError(`unknown field "${key}"`, join(pointer, key));
    }
    for (const [key, field] of Object.entries(fields)) {
      if (value[key] === undefined) {
        if (field.required) throw new SchemaError(`missing required field "${key}"`, join(pointer, key));
        if (field.default !== undefined) out[key] = structuredClone(field.default);
        continue;
      }
      out[key] = checkValue(value[key], field.spec, join(pointer, key));
    }
    if (spec.values) {
      for (const [key, v] of Object.entries(value)) {
        if (!(key in fields)) out[key] = checkValue(v, spec.values, join(pointer, key));
      }
    }
  }
  if (spec.check) {
    const message = spec.check(out);
    if (message) throw new SchemaError(message, pointer);
  }
  return out;
}
