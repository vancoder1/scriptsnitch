// The cloaking cross-check (design §7): a versioned or hashed file fetched directly from Node, sent
// with the referer Chrome used, compared with what Chrome received. Only a 200 JavaScript answer is
// compared; anything else is a note, never a finding.
import { sha256Hex, sha384Base64 } from '../util/hash.js';
import { VERSION } from '../version.js';

const LARGEST = 10 * 1024 * 1024;

// The body, up to `limit` bytes; null when it is longer.
async function readLimited(res, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.length;
    if (size > limit) { await res.body.cancel().catch(() => {}); return null; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Chrome hands over a text response decoded (the byte-order mark dropped, the charset applied), and
// its content hash is of that text in UTF-8. The direct download is decoded the same way, so a file
// with a BOM or another charset is not taken for a cloaked one.
function asChromeSees(bytes, contentType) {
  const charset = /charset=["']?([^;"'\s]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  let decoder;
  try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder('utf-8'); }
  return Buffer.from(decoder.decode(bytes), 'utf8');
}

export async function crossCheck(items, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const out = [];
  for (const { url, chromeHash, referer } of items) {
    const base = { url, chromeHash, directHash: null, sri: null, note: null };
    try {
      const res = await fetchImpl(url, {
        headers: { referer: referer ?? '', accept: '*/*', 'user-agent': `scriptsnitch/${VERSION} (cross-check)` },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) { out.push({ ...base, note: `direct fetch answered ${res.status}` }); continue; }
      const contentType = res.headers.get('content-type') ?? '';
      const type = contentType.split(';')[0].trim().toLowerCase();
      if (!/javascript|ecmascript/.test(type)) { out.push({ ...base, note: `direct fetch returned ${type || 'no content type'}, not JavaScript` }); continue; }
      const bytes = await readLimited(res, LARGEST);
      if (!bytes) { out.push({ ...base, note: `direct fetch was too large to compare (over ${LARGEST / 1024 / 1024} MB)` }); continue; }
      // The integrity value a page needs is of the bytes as served, not as decoded.
      out.push({ ...base, directHash: sha256Hex(asChromeSees(bytes, contentType)), sri: `sha384-${sha384Base64(bytes)}` });
    } catch (err) {
      out.push({ ...base, note: `direct fetch failed: ${err.message}` });
    }
  }
  return out;
}
