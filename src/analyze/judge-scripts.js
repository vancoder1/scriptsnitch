// Script identity and content findings (design §10): new-origin, new-slot, scope, new-version,
// content-mismatch, in-place-change, own-change, new-own-script, build-file, new-inline, cloaking.
import { classifyUrl, slotOf, fileIdentity } from './urls.js';
import { accountKey, accountKeyParams, sharedHostKind, vendorOf, vendorOwnHosts } from './hosts.js';
import { coveringScripts, originOf } from './approval.js';
import { buildFileAccepted } from './deploy.js';
import { matchUrl, coversPage } from '../config/patterns.js';
import { short } from '../util/hash.js';
import { ownKey } from '../state.js';

const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
const patternOrigin = (pattern) => originOf(pattern.replace(/\{token\}|\{version\}|\*\*?/g, 'x'));
const inlineRef = (template) => ({ url: null, contentHash: null, template });

function judgeInline(ctx, page, profile, template, visits) {
  const { section, st } = ctx;
  const base = { site: ctx.site, profile, path: page.path, visits, attributedTo: inlineRef(template) };
  const entries = section.scripts.filter((e) => e.match === 'inline' && coversPage(e.pages, page.path, page.sensitive));
  const listing = entries.find((e) => e.template?.includes(template));
  if (listing) { ctx.markSeen('scripts', listing); return; }
  const deployEntry = entries.find((e) => e.trust === 'deploy');
  const accepted = (st.inline[page.path] ?? []).includes(short(template));
  if (deployEntry && (accepted || ctx.evident)) {
    ctx.markSeen('scripts', deployEntry);
    if (!accepted) {
      ctx.acceptByDeploy(`subject:${template}`);
      st.inline[page.path] = [...(st.inline[page.path] ?? []), short(template)];
      ctx.add({ ...base, kind: 'accepted', subject: `inline ${short(template)}`, page: page.path, severity: 'info', reasons: ['a new inline script came with a deploy'] });
    }
    return;
  }
  const severity = page.sensitive ? (ctx.evident ? 'medium' : 'high') : 'medium';
  ctx.add({ ...base, kind: 'new-inline', subject: template, page: page.path, severity, reasons: [page.sensitive && !ctx.evident ? 'a new inline script on a sensitive page, with no deploy' : 'a new inline script'], evidence: [template], data: { template, page: page.path, sensitive: page.sensitive } });
}

// A script whose source names a build file vouches for it only when it is trusted itself: known from
// an earlier run, or the entry file of a slot the page loaded before (design §8, "an accepted own
// script"). Two files dropped in the build folder that name each other vouch for nothing.
function trustedReferencer(ctx, url) {
  const cls = classifyUrl(url);
  if (ctx.ownBaseline.has(ownKey(fileIdentity(url, cls)))) return true;
  const token = cls.token ?? cls.version ?? cls.queryVersion;
  const slot = slotOf(url, cls);
  return token !== undefined && ctx.entry.current[slot] === token && (!ctx.entry.previous || slot in ctx.entry.previous);
}

// A reported change is not adopted into the state: it is reported on every run until its hash is
// approved on the entry (sha256), or, for an unversioned file, until a deploy is evident.
// The hashes an own file has had, kept under its identity (fileIdentity): a few, for a file whose
// variants differ by a query parameter (config.js?lang=en and ?lang=fr).
const knownHashes = (st, k) => [st.ownHashes[k] ?? []].flat();
function remember(st, k, hash) {
  const list = [...new Set([...knownHashes(st, k), short(hash)])].slice(-8);
  st.ownHashes[k] = list.length === 1 ? list[0] : list;
}

function judgeOwnFile(ctx, page, base, url, cls, obs, covering) {
  const { st } = ctx;
  const hash = obs.ref.contentHash;
  const k = ownKey(fileIdentity(url, cls));
  // Known from an earlier run: what this run sees for the first time (every variant) is the baseline.
  const prev = ctx.ownBaseline.has(k);
  const deployEntry = covering.find((e) => e.trust === 'deploy');
  if (covering.some((e) => e.sha256?.includes(hash))) { remember(st, k, hash); return; }
  const immutable = cls.kind === 'hashed' || cls.kind === 'versioned';
  const data = { url, hash, page: page.path, sensitive: page.sensitive, slot: slotOf(url, cls), entryId: deployEntry.id };
  if (prev && !knownHashes(st, k).includes(short(hash))) {
    if (immutable) {
      ctx.add({ ...base, kind: 'in-place-change', subject: url, severity: 'high', reasons: [cls.kind === 'hashed' ? 'the content changed at a file name that carries a build token' : `the content of version ${cls.version} changed in place`], evidence: [hash], data });
    } else if (ctx.evident) {
      ctx.acceptByDeploy(`content:${url}|${hash}`);
      remember(st, k, hash);
      ctx.add({ ...base, kind: 'accepted', subject: url, severity: 'info', reasons: ['changed with a deploy'] });
    } else {
      ctx.add({ ...base, kind: 'own-change', subject: url, page: page.sensitive ? page.path : '*', severity: page.sensitive ? 'medium' : 'info', reasons: ['your own file changed with no deploy evident'], evidence: [hash], data });
    }
    return;
  }
  if (prev) return;
  if (cls.kind === 'hashed' && /\{token\}|\*/.test(deployEntry.match)) {
    const slot = slotOf(url, cls);
    const entrySlot = slot in ctx.entry.current;
    // Loaded directly by the page and nothing to compare with yet (a first or stateless run).
    const known = entrySlot && (!ctx.entry.previous || slot in ctx.entry.previous);
    const referenced = (obs.referencedBy ?? []).some((u) => trustedReferencer(ctx, u));
    if (known || buildFileAccepted({ token: cls.token, referenced, evident: ctx.evident, deployTokens: st.deployTokens })) {
      if (!known) ctx.acceptByDeploy(`content:${url}|${hash}`);
      remember(st, k, hash);
      if (ctx.evident && !referenced && !st.deployTokens.includes(cls.token)) st.deployTokens.push(cls.token);
      return;
    }
    if (entrySlot) ctx.reportedSlots.add(slot);
    ctx.add({ ...base, kind: 'build-file', subject: url, severity: page.sensitive ? 'high' : 'medium', reasons: [entrySlot ? 'a new file loaded directly by the page, in the build folder, with no deploy' : 'a new file in the build folder that the build does not name, with no deploy'], evidence: [hash], data });
    return;
  }
  // A version folder (Magento's /static/version{version}/**): every file of a build shares the version,
  // so it vouches for none of them. A new file there is accepted on a first run, with a deploy, or as
  // a known entry file; otherwise it is a file dropped into the build.
  if (cls.kind === 'versioned' && /\*/.test(deployEntry.match)) {
    const slot = slotOf(url, cls);
    const entrySlot = slot in ctx.entry.current;
    const known = entrySlot && (!ctx.entry.previous || slot in ctx.entry.previous);
    if (!ctx.entry.previous || known || ctx.evident) {
      if (ctx.entry.previous && !known) ctx.acceptByDeploy(`content:${url}|${hash}`);
      remember(st, k, hash);
      return;
    }
    if (entrySlot) ctx.reportedSlots.add(slot);
    ctx.add({ ...base, kind: 'build-file', subject: url, severity: page.sensitive ? 'high' : 'medium', reasons: ['a new file in the versioned build folder, with no deploy'], evidence: [hash], data });
    return;
  }
  remember(st, k, hash);
}

function judgeExternal(ctx, page, profile, url, observations, visits) {
  const { section, own, snapshot } = ctx;
  const obs = observations[0];
  const base = { site: ctx.site, profile, path: page.path, visits, attributedTo: obs.ref };
  const hashes = [...new Set(observations.map((o) => o.ref.contentHash))];
  const origin = originOf(url);
  const isOwn = own.has(origin);
  const cls = classifyUrl(url);
  const slot = slotOf(url, cls);
  // Integrity is of the bytes as served: the cross-check has them; Chrome hands over decoded text.
  const check = snapshot.crossCheck.find((c) => c.url === url);
  const data = { url, slot, hash: obs.ref.contentHash, hashes, sri: check?.sri ?? obs.sri, origin, page: page.path, sensitive: page.sensitive, own: isOwn, kind: cls.kind, creator: obs.creator?.url ?? null };

  const covering = coveringScripts({ url, template: null }, section, page.path, page.sensitive);
  // A file that legitimately differs by browser is approved with origin trust (design §10).
  if (check?.directHash && check.directHash !== check.chromeHash && !covering.some((e) => e.trust === 'origin')) {
    ctx.add({ ...base, kind: 'cloaking', subject: url, severity: 'high', reasons: ['Chrome received different bytes than a direct download of the same file'], evidence: [check.chromeHash], data });
  }

  if (covering.length) {
    for (const e of covering) ctx.markSeen('scripts', e);
    const exact = covering.filter((e) => e.trust === 'exact');
    if (exact.length && hashes.every((h) => exact.some((e) => e.sha256?.includes(h)))) return;
    const deployEntry = covering.find((e) => e.trust === 'deploy');
    const originEntry = covering.find((e) => e.trust === 'origin');
    if (!deployEntry && !originEntry) {
      const unapproved = hashes.filter((h) => !exact.some((e) => e.sha256?.includes(h)));
      ctx.add({ ...base, kind: 'content-mismatch', subject: url, severity: 'high', reasons: ['the content does not match any approved version of this file'], evidence: unapproved, data: { ...data, entryId: exact[0].id } });
      return;
    }
    if (deployEntry && isOwn) judgeOwnFile(ctx, page, base, url, cls, obs, covering);
    return;
  }

  const keyParams = accountKeyParams(url);
  const anywhere = section.scripts.filter((e) => e.match !== 'inline' && matchUrl(e.match, url, { accountKeyParams: keyParams }));
  if (anywhere.length) {
    ctx.add({ ...base, kind: 'scope', subject: anywhere[0].id, page: page.path, severity: 'medium', reasons: [`an approved script now runs on ${page.path}, which its entry does not list`], data: { ...data, entryId: anywhere[0].id } });
    return;
  }

  // Nothing inherits onto a host that serves anyone's files (cloud storage, tenant subdomains), even
  // one the loader's company runs: a stolen tag-manager login loading from a bucket is the classic case.
  if (obs.creator?.url && !sharedHostKind(hostOf(url))) {
    const loaders = coveringScripts({ url: obs.creator.url, template: null }, section, page.path, page.sensitive).filter((e) => e.trust === 'origin');
    const creatorVendor = vendorOf(hostOf(obs.creator.url));
    // Across hosts, a cloud company's name is no guarantee (it covers buckets, ad creatives and web
    // apps): only the hosts listed as its own code count.
    const ownHosts = vendorOwnHosts(creatorVendor);
    const sameVendor = originOf(obs.creator.url) === origin || (creatorVendor && creatorVendor === vendorOf(hostOf(url)) && (!ownHosts || ownHosts.includes(hostOf(url))));
    if (loaders.length && sameVendor && !accountKey(url)) {
      for (const e of loaders) ctx.markSeen('scripts', e);
      ctx.inherit(page.path, url, loaders);
      return;
    }
  }

  const key = accountKey(url);
  if (!isOwn && cls.kind === 'versioned') {
    const sameSlot = section.scripts.find((e) => e.trust === 'exact' && e.match !== 'inline' && e.match !== url && !/[*{]/.test(e.match) && slotOf(e.match, classifyUrl(e.match)) === slot);
    if (sameSlot) {
      ctx.add({ ...base, kind: 'new-version', subject: url, severity: 'medium', reasons: [`upgraded from ${classifyUrl(sameSlot.match).version} to ${cls.version}`], evidence: [obs.ref.contentHash], data: { ...data, entryId: sameSlot.id, previousUrl: sameSlot.match } });
      return;
    }
  }
  if (isOwn) {
    ctx.add({ ...base, kind: 'new-own-script', subject: slot, severity: page.sensitive ? 'high' : 'medium', reasons: ['a new script from your own site that no entry covers'], evidence: [obs.ref.contentHash], data });
    return;
  }
  const pathShared = sharedHostKind(hostOf(url)) === 'path';
  const atOrigin = section.scripts.some((e) => e.match !== 'inline' && patternOrigin(e.match) === origin);
  if (!key && !pathShared && atOrigin) {
    ctx.add({ ...base, kind: 'new-slot', subject: slot, severity: 'medium', reasons: [`a new script from ${origin}, where another script is approved`], evidence: [obs.ref.contentHash], data });
    return;
  }
  const why = key ? `a new ${key.service} account (${key.key}) on a service you already use` : pathShared ? `a new file on ${hostOf(url)}, a host that serves anyone's files` : `a script from ${origin}, which nothing approves`;
  ctx.add({ ...base, kind: 'new-origin', subject: slot, severity: 'high', reasons: [why], evidence: [obs.ref.contentHash], data: { ...data, accountKey: key } });
}

// The conclusive visits of each page and profile that this judging pass looks at, with stable ids.
export function* judgedVisits(ctx, pages) {
  for (const page of pages) {
    for (const [profile, result] of Object.entries(page.profiles)) {
      if (!result?.conclusive) continue;
      const visits = result.visits.map((v, i) => ({ v, id: `${page.path}|${profile}|${i}` })).filter(({ v }) => v.conclusive && ctx.includeVisit(v));
      if (visits.length) yield { page, profile, visits };
    }
  }
}

export function judgeScripts(ctx, pages) {
  for (const { page, profile, visits } of judgedVisits(ctx, pages)) {
    const byIdentity = new Map();
    for (const { v, id } of visits) {
      for (const s of v.scripts) {
        if (s.kind === 'code') continue;
        const identity = s.kind === 'inline' ? `inline:${s.ref.template}` : s.ref.url;
        if (!byIdentity.has(identity)) byIdentity.set(identity, { observations: [], visits: new Set() });
        const group = byIdentity.get(identity);
        group.observations.push(s);
        group.visits.add(id);
      }
    }
    for (const [identity, { observations, visits: ids }] of byIdentity) {
      if (identity.startsWith('inline:')) judgeInline(ctx, page, profile, observations[0].ref.template, [...ids]);
      else judgeExternal(ctx, page, profile, identity, observations, [...ids]);
    }
  }
}
