// The first run's split (design §10 "First run"): with nothing approved yet, every proposal is
// routine except those risky in themselves, which are pending.
import { originOf } from './approval.js';

const FIELD_ROLES = new Set(['field', 'form', 'submit', '*']);
const patternOrigin = (pattern) => originOf(String(pattern).replace(/\{token\}|\{version\}|\*\*?/g, 'x'));

function risky(p, own) {
  const e = p.entry ?? {};
  const add = p.add ?? {};
  switch (p.section) {
    case 'destinations': return Boolean(e.receives?.length || add.receives?.length);
    case 'fields': return true;
    case 'frames': return Boolean(e.fields?.length || add.fields?.length);
    case 'allow': return (e.what ?? add.what) === 'peer-connection';
    case 'scripts': {
      const thirdParty = e.match !== 'inline' && !own.has(patternOrigin(e.match));
      if (!thirdParty) return false;
      const listens = [...(e.behavior?.listens ?? []), ...(add.listens ?? [])];
      return listens.some((l) => FIELD_ROLES.has(l.split(':')[1])) || Boolean(e.behavior?.input || add.input);
    }
    default: return false;
  }
}

export function firstRunSplit(proposals, own = new Set()) {
  return proposals.map((p) => ({ ...p, mode: risky(p, own) ? 'pending' : 'routine' }));
}
