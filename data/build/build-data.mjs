// Regenerates data/tlds.txt and data/vendor-families.json from their upstream sources.
// Download the inputs first (see data/README.md), then run: node data/build/build-data.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import vm from 'node:vm';

const here = (p) => new URL(p, import.meta.url);

// IANA root zone list: one TLD per line after a comment line.
const tlds = readFileSync(here('tlds-alpha-by-domain.txt'), 'utf8')
  .split('\n')
  .map((l) => l.trim().toLowerCase())
  .filter((l) => l && !l.startsWith('#'));
writeFileSync(here('../tlds.txt'), `${tlds.join('\n')}\n`);

// third-party-web entities (MIT). The file is a CommonJS module of object literals; evaluate it in
// an empty context with nothing but a module object, never with require or process.
const sandbox = { module: { exports: null } };
vm.runInNewContext(readFileSync(here('entities.js'), 'utf8'), sandbox, { timeout: 5000 });
const families = {};
for (const entity of sandbox.module.exports) {
  const vendor = entity.company || entity.name;
  for (const domain of entity.domains || []) families[domain.toLowerCase()] = vendor;
}
const sorted = Object.fromEntries(Object.entries(families).sort(([a], [b]) => (a < b ? -1 : 1)));
writeFileSync(here('../vendor-families.json'), `${JSON.stringify(sorted, null, 0).replace(/,"/g, ',\n"')}\n`);
console.log(`${tlds.length} TLDs, ${Object.keys(sorted).length} vendor domains`);
