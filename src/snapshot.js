// The snapshot the collect job writes and the report job reads (design §6). The report job validates
// it strictly: a malformed snapshot is a failed run, never a clean one.
import { checkValue, SchemaError } from './config/schema.js';

export const SNAPSHOT_FORMAT = 1;

export class SnapshotError extends Error {
  constructor(message, pointer = null) {
    super(`snapshot${pointer !== null ? ` ${pointer || '/'}` : ''}: ${message}`);
    this.name = 'SnapshotError';
    this.pointer = pointer;
  }
}

const str = { type: 'string' };
const nullable = (spec) => ({ oneOf: [{ type: 'null' }, spec], message: `expected ${spec.type ?? 'a value'} or null` });
const hex64 = { type: 'string', pattern: /^[0-9a-f]{64}$/, patternMessage: 'expected a 64-character lowercase SHA-256' };
const int = (min = 0) => ({ type: 'integer', min });
const bool = { type: 'boolean' };
const req = (spec) => ({ spec, required: true });
const opt = (spec, def) => (def === undefined ? { spec } : { spec, default: def });

const scriptRef = { type: 'object', fields: { url: req(nullable(str)), contentHash: req(nullable(hex64)), template: req(nullable(hex64)) } };
const kind = { type: 'string', enum: ['password', 'card', 'iban', 'email', 'name'] };

const visit = {
  type: 'object',
  fields: {
    role: req({ type: 'string', enum: ['A', 'B', 'replacement', 'confirm', 'probe', 'probe2', 'drill'] }),
    conclusive: req(bool),
    reason: req(nullable(str)),
    document: req({ type: 'object', fields: { status: req(int()), finalUrl: req(str), headers: req({ type: 'object', values: str }), metaCsp: req({ type: 'array', items: str }), title: opt(str, '') } }),
    consent: req({ type: 'object', fields: { found: req(nullable(str)), accepted: req(bool) } }),
    scripts: req({ type: 'array', items: { type: 'object', fields: {
      ref: req(scriptRef), kind: req({ type: 'string', enum: ['external', 'inline', 'code'] }), frame: req(str),
      creator: req(nullable(scriptRef)), hosts: req({ type: 'array', items: str }), band: req({ type: 'string', enum: ['plain', 'minified', 'packed'] }),
      createsCode: req(bool), size: req(int()), sri: opt(nullable(str), null), referencedBy: opt({ type: 'array', items: str }, []),
    } } }),
    destinations: req({ type: 'array', items: { type: 'object', fields: {
      url: req(str), method: req(str), type: req(str), frame: req(str), initiator: req(nullable(scriptRef)), viaCode: opt(bool, false), phase: req({ type: 'string', enum: ['load', 'probe'] }),
    } } }),
    frames: req({ type: 'array', items: { type: 'object', fields: { origin: req(str), tracked: req(bool), fieldKinds: req({ type: 'array', items: kind }) } } }),
    fields: req({ type: 'array', items: { type: 'object', fields: { frame: req(str), form: req(str), field: req(str), kind: req(kind), count: req(int(1)) } } }),
    listeners: req({ type: 'array', items: { type: 'object', fields: { kind: req(kind), role: req({ type: 'string', enum: ['field', 'form', 'submit', 'ancestor', 'document', 'window'] }), event: req(str), script: req(nullable(scriptRef)) } } }),
    inputCode: req({ type: 'array', items: scriptRef }),
    peers: req(int()),
    linkHosts: req({ type: 'array', items: str }),
    probe: req(nullable({ type: 'object', fields: {
      values: req({ type: 'object', values: str }),
      submitted: req(bool),
      hits: req({ type: 'array', items: { type: 'object', fields: { kind: req(kind), encoding: req(str), url: req(str), frame: req(str), initiator: opt(nullable(scriptRef), null) } } }),
      growth: req({ type: 'array', items: { type: 'object', fields: { url: req(str), field: req(str) } } }),
      storage: req({ type: 'array', items: { type: 'object', fields: { kind: req(kind), where: req(str) } } }),
    } })),
  },
};

const profile = {
  type: 'object',
  fields: { conclusive: req(bool), reason: req(nullable(str)), viewport: req({ type: 'object', fields: { width: req(int(1)), height: req(int(1)) } }), visits: req({ type: 'array', items: visit }) },
};

const spec = {
  type: 'object',
  fields: {
    format: req(int(1)),
    tool: req(str),
    run: req({ type: 'object', fields: { startedAt: req(str), finishedAt: req(str), chrome: req(str), drill: req(bool) } }),
    sites: opt({ type: 'object', values: { type: 'object', fields: { deployMarker: req(nullable(str)) } } }, {}),
    pages: req({ type: 'array', items: { type: 'object', fields: {
      name: req(str), site: req(str), path: req(str), url: req(str), sensitive: req(bool),
      profiles: req({ type: 'object', fields: { desktop: opt(profile), mobile: opt(profile) } }),
    } } }),
    crossCheck: req({ type: 'array', items: { type: 'object', fields: { url: req(str), chromeHash: req(hex64), directHash: req(nullable(hex64)), sri: opt(nullable(str), null), note: req(nullable(str)) } } }),
    evidence: req({ type: 'object', values: { type: 'object', fields: { file: req(str), url: req(nullable(str)), bytes: req(int()) } } }),
  },
};

export function validateSnapshot(obj) {
  if (obj?.format !== undefined && obj.format !== SNAPSHOT_FORMAT) {
    throw new SnapshotError(`this snapshot is format ${obj.format}; this version reads format ${SNAPSHOT_FORMAT}. Use the same scriptsnitch version for collect and report.`);
  }
  let snapshot;
  try {
    snapshot = checkValue(obj, spec, '');
  } catch (e) {
    if (e instanceof SchemaError) throw new SnapshotError(e.detail, e.pointer);
    throw e;
  }
  // The report job reads each evidence file and may quote it in an issue. The snapshot comes from the
  // job that ran Chrome on the watched site, so the path is fixed by the hash and nothing else.
  for (const [hash, e] of Object.entries(snapshot.evidence)) {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new SnapshotError('an evidence key must be a 64-character lowercase SHA-256', `/evidence/${hash}`);
    if (e.file !== `evidence/${hash}.js`) throw new SnapshotError(`an evidence file must be evidence/${hash}.js`, `/evidence/${hash}/file`);
  }
  return snapshot;
}
