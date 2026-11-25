// Deploy evidence and build folders (design §8): ordinary deploys renumber and add chunks; a file
// dropped into the build folder must not ride along.
import { classifyUrl, slotOf } from './urls.js';

const originOf = (url) => { try { return new URL(url).origin; } catch { return null; } };

// Own scripts the HTML loads directly (no creator) that carry a build token or a version: slot -> token.
export function entrySlotsOf(visits, own) {
  const slots = {};
  for (const v of visits) {
    if (!v.conclusive || v.role === 'drill') continue;
    for (const s of v.scripts) {
      if (s.kind !== 'external' || s.creator || !s.ref.url || !own.has(originOf(s.ref.url))) continue;
      const c = classifyUrl(s.ref.url);
      const token = c.token ?? c.version ?? c.queryVersion;
      if (token) slots[slotOf(s.ref.url, c)] = token;
    }
  }
  return slots;
}

// A deploy is evident when an entry slot that existed last run now has another token or version
// (a replacement, never an addition), or when the deploy marker changed. The first run has none.
// With a marker set up, only the marker counts: anyone who can edit the HTML can change an entry
// token, while the marker is what the deploy itself sets.
export function deployEvident({ previousEntrySlots, currentEntrySlots, previousMarker = null, currentMarker = null }) {
  if (previousMarker !== null || currentMarker !== null) return previousMarker !== null && currentMarker !== null && previousMarker !== currentMarker;
  if (!previousEntrySlots) return false;
  return Object.entries(currentEntrySlots).some(([slot, token]) => slot in previousEntrySlots && previousEntrySlots[slot] !== token);
}

// A new hashed file in an approved build folder is accepted when the build's chunk map names it,
// when a deploy is evident, or when it came with the last deploy.
export function buildFileAccepted({ token, referenced, evident, deployTokens }) {
  return Boolean(referenced) || evident || deployTokens.includes(token);
}
