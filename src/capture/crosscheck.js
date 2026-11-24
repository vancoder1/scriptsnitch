// The cloaking cross-check (design §7): a versioned or hashed file fetched directly from Node, sent
// with the referer Chrome used, compared with what Chrome received. Only a 200 JavaScript answer is
// compared; anything else is a note, never a finding.
import { sha256Hex } from '../util/hash.js';
import { VERSION } from '../version.js';

export async function crossCheck(items, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const out = [];
  for (const { url, chromeHash, referer } of items) {
    const base = { url, chromeHash, directHash: null, note: null };
    try {
      const res = await fetchImpl(url, {
        headers: { referer: referer ?? '', accept: '*/*', 'user-agent': `scriptsnitch/${VERSION} (cross-check)` },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 200) { out.push({ ...base, note: `direct fetch answered ${res.status}` }); continue; }
      const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
      if (!/javascript|ecmascript/.test(type)) { out.push({ ...base, note: `direct fetch returned ${type || 'no content type'}, not JavaScript` }); continue; }
      out.push({ ...base, directHash: sha256Hex(Buffer.from(await res.arrayBuffer())) });
    } catch (err) {
      out.push({ ...base, note: `direct fetch failed: ${err.message}` });
    }
  }
  return out;
}
