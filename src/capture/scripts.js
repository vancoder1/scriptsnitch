// Records every script a visit's sessions parse, and turns them into identities (design §7, §8):
// external scripts by the SHA-256 of their response bytes, inline scripts by their template, code
// without a URL by its source, attributed to the script that created it.
import { sha256Hex, sha384Base64 } from '../util/hash.js';
import { templateOf } from '../analyze/template.js';
import { extractHostnames } from '../analyze/hostnames.js';
import { obfuscationBand } from '../analyze/obfuscation.js';

const INTERNAL = /^(chrome|chrome-extension|chrome-untrusted|devtools|extensions)(:|::)/i;

export function createScriptLog(ctx) {
  const parsed = [];
  let lastParsedAt = Date.now();
  ctx.on('Debugger.scriptParsed', (p, sessionId) => {
    if (INTERNAL.test(p.url ?? '')) return;
    lastParsedAt = Date.now();
    parsed.push({
      sessionId,
      scriptId: p.scriptId,
      url: p.url ?? '',
      v8Hash: p.hash,
      length: p.length ?? 0,
      stack: p.stackTrace ?? null,
      frameId: p.executionContextAuxData?.frameId ?? null,
      wasm: p.scriptLanguage === 'WebAssembly',
      module: Boolean(p.isModule),
    });
  });
  return { parsed, lastParsedAt: () => lastParsedAt };
}

const firstScriptId = (stack) => {
  for (let s = stack; s; s = s.parent) {
    const frame = s.callFrames?.find((f) => f.scriptId && f.scriptId !== '0');
    if (frame) return frame.scriptId;
  }
  return null;
};

// Builds the visit's script entries. `docUrls` maps sessionId -> set of document URLs in that session
// (inline scripts carry their document's URL). `isTracked(entry)` filters third-party frames.
export async function buildScripts(ctx, scriptLog, netLog, { frameOf, docUrls, isTracked, cache }) {
  const byId = new Map();
  const entries = [];
  for (const p of scriptLog.parsed) {
    const frame = frameOf(p);
    if (!isTracked(p, frame)) continue;
    const cacheKey = `${p.v8Hash}:${p.length}`;
    let source = cache.sources.get(cacheKey);
    if (source === undefined) {
      source = await ctx.send('Debugger.getScriptSource', { scriptId: p.scriptId }, p.sessionId).then((r) => r.scriptSource ?? '', () => null);
      if (source !== null) cache.sources.set(cacheKey, source);
    }
    if (source === null) continue;
    const creatorId = firstScriptId(p.stack);
    let kind;
    if (p.wasm || /^(blob|data):/i.test(p.url)) kind = 'code';
    else if (creatorId) kind = 'code';
    else if (!p.url) kind = 'code';
    else if (docUrls.get(p.sessionId)?.has(p.url)) kind = 'inline';
    else kind = 'external';

    const entry = { p, kind, source, frame, creatorId, request: null };
    if (kind === 'external') {
      const req = netLog.scriptRequest(p.url, p.sessionId);
      entry.request = req;
      if (req?.initiator?.stack) entry.creatorId = firstScriptId(req.initiator.stack);
      let bytes = null;
      if (req) {
        const cached = cache.bodies.get(req.requestId);
        bytes = cached ?? (await ctx.send('Network.getResponseBody', { requestId: req.requestId }, req.sessionId).then((b) => Buffer.from(b.body, b.base64Encoded ? 'base64' : 'utf8'), () => null));
        if (bytes) cache.bodies.set(req.requestId, bytes);
      }
      bytes ??= Buffer.from(source, 'utf8');
      entry.ref = { url: p.url, contentHash: sha256Hex(bytes), template: null };
      entry.sri = `sha384-${sha384Base64(bytes)}`;
    } else if (kind === 'inline') {
      entry.ref = { url: null, contentHash: null, template: templateOf(source).hash };
    } else {
      entry.ref = { url: null, contentHash: sha256Hex(Buffer.from(source, 'utf8')), template: null };
    }
    byId.set(`${p.sessionId}:${p.scriptId}`, entry);
    entries.push(entry);
  }

  // Attribute code without a URL to the nearest script that has an identity of its own.
  const rootOf = (entry, seen = new Set()) => {
    let current = entry;
    while (current && current.kind === 'code' && current.creatorId && !seen.has(current)) {
      seen.add(current);
      current = byId.get(`${current.p.sessionId}:${current.creatorId}`) ?? null;
    }
    return current && current !== entry ? current : null;
  };

  const out = [];
  for (const entry of entries) {
    const creatorEntry = entry.creatorId ? byId.get(`${entry.p.sessionId}:${entry.creatorId}`) ?? null : null;
    const creator = entry.kind === 'code' ? rootOf(entry) ?? creatorEntry : creatorEntry;
    entry.creator = creator;
    const analysisKey = entry.ref.contentHash ?? entry.ref.template;
    let analysis = cache.analysis.get(analysisKey);
    if (!analysis) {
      analysis = { hosts: extractHostnames(entry.source), band: obfuscationBand(entry.source) };
      cache.analysis.set(analysisKey, analysis);
    }
    out.push({
      ref: entry.ref,
      kind: entry.kind,
      frame: entry.frame,
      creator: creator ? creator.ref : null,
      hosts: analysis.hosts,
      band: analysis.band,
      createsCode: false,
      size: entry.p.length,
      sri: entry.sri ?? null,
      _entry: entry,
    });
  }
  const byEntry = new Map(out.map((s) => [s._entry, s]));
  for (const s of out) {
    if (s.kind === 'code' && s._entry.creator) {
      const parent = byEntry.get(s._entry.creator);
      if (parent) parent.createsCode = true;
    }
  }
  const sources = new Map();
  for (const s of out) {
    sources.set(s.ref.contentHash ?? s.ref.template, { source: s._entry.source, url: s.ref.url });
    delete s._entry;
  }
  return { scripts: out, sources, refOf: (sessionId, scriptId) => byId.get(`${sessionId}:${scriptId}`)?.ref ?? null, rootRefOf: (sessionId, scriptId) => { const e = byId.get(`${sessionId}:${scriptId}`); if (!e) return null; return (e.kind === 'code' ? rootOf(e)?.ref : null) ?? e.ref; } };
}
