// Copies of new or changed scripts, kept with the run so people can read them even if an attacker
// later removes them (design §7 "Evidence"): up to 2 MB each and 100 MB in total, once per identity.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MB = 1024 * 1024;

export function createEvidenceStore(outDir, { perScript = 2 * MB, total = 100 * MB } = {}) {
  const entries = new Map();
  let used = 0;
  mkdirSync(join(outDir, 'evidence'), { recursive: true });
  return {
    entries,
    add(hash, source, url) {
      if (entries.has(hash)) return entries.get(hash);
      const bytes = Buffer.from(source, 'utf8').subarray(0, perScript);
      if (used + bytes.length > total) return null;
      const file = `evidence/${hash}.js`;
      writeFileSync(join(outDir, file), bytes);
      used += bytes.length;
      const entry = { file, url: url ?? null, bytes: bytes.length };
      entries.set(hash, entry);
      return entry;
    },
  };
}
