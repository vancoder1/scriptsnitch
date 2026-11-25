# scriptsnitch: design

Status: approved 2026-11-23, with the additions in sections 8, 12 and 14 (domain risk, code diffs,
comment approvals, a reusable workflow, consent banners, stale approvals, `scan`/`init`, fire drills,
the evidence pack, one-time codes); implemented in v1.0.0. Section 20 records what the experiments
found, and section 23 the decisions taken during the build that changed what this document says.
Author: Ivan Zaporozhets.

## 1. What it is

scriptsnitch is a GitHub Action (and a command-line tool) that visits the pages you list in a real
Chrome, records what each page runs and where it sends data, and compares that with a list of
approved scripts committed to your repository. When something changes that nobody approved, it opens
a GitHub issue that says exactly what changed and why it matters, and proposes the edit to the
approved list as a pull request.

**Why it exists.** Card skimmers and other injected scripts (Magecart, the polyfill.io takeover) work
by changing the JavaScript a page loads, on a third party's server or on the site's own. The tools
that watch for this are commercial (Report URI, Feroot, cside, Akamai, Cloudflare Page Shield). No
open-source tool watches continuously and keeps an approval record. PCI DSS 4.0.1 asks merchants for
exactly that. Requirement 6.4.3 wants three things for payment-page scripts: a way to confirm each one
is authorized, a way to assure each one's integrity, and an inventory with a written reason for each.
Requirement 11.6.1 wants a mechanism that alerts on unauthorized changes to the scripts and the
security-impacting headers of payment pages, as the browser receives them, at least weekly by
default.

**Who it is for.** Developers and small teams who run a website with a login, a checkout or other
pages worth protecting, and merchants who need 6.4.3/11.6.1 evidence without paying a vendor.

**The job, in one sentence.** Tell you when the code your pages run, or where they send data,
changes in a way nobody approved, and keep the approved list.

## 2. Goals, non-goals, anti-goals

**Goals**
- Detect: new script sources (including a new account on a shared service); changed script content,
  on third-party servers and on your own; new places a page sends data (requests, beacons,
  WebSocket, WebTransport, WebRTC, DNS prefetch); new listeners on, and new code running during,
  input into password and card fields; new password or card fields, including inside new iframes;
  weaker security headers; code served differently to bots; data sent, stored or delayed on form
  submit.
- Keep false alarms close to zero. Every alert must be reproducible, explained in plain words and
  worth acting on. Ordinary deploys of a modern web app must not alert.
- Approvals as code: a committed, human-readable approved file; changes proposed as pull requests;
  every approval has a reason; risky approvals take a deliberate act.
- Zero runtime dependencies. Node 24 built-ins and the Chrome already installed on GitHub's runners.
- Least privilege: the job that runs untrusted web pages holds no write token, and the browser
  process inherits no token or secret at all.
- Fast: a few dozen page visits in a minute or two.
- Warn before an attack is possible: a script or destination domain that no longer resolves, is about
  to expire, or has changed hands.
- Easy to adopt and to act on: a five-line reusable workflow, a one-off `scan`, readable code diffs in
  every alert, approval by issue comment, a fire drill that proves the setup works, and an evidence
  pack for assessors.

**Non-goals**
- Known vulnerabilities in libraries (vuln-watch and retire.js do that).
- Writing or enforcing a Content-Security-Policy.
- Monitoring real visitors' browsers (CSP reporting does that; it complements scriptsnitch).
- Blocking attacks. scriptsnitch detects; it does not prevent.
- Crawling. It visits only the pages you list.
- Performance, privacy-tracker or uptime monitoring.
- A hosted dashboard or any server.

**Anti-goals** (failure even if the code works)
- Alert fatigue. If people mute it, it failed. A change that is not worth acting on must never open
  or comment on an issue.
- Approval fatigue: a design where people learn to merge proposals unread. Risky approvals never ride
  along with routine ones.
- A failed, stopped or inconclusive check that looks like "all clear", or that resolves anything.
- Real data leaving the browser, or the probe causing real effects on the site. The probe uses fake
  values and holds every request it can.
- scriptsnitch becoming a supply-chain risk itself (dependencies, unpinned actions, a write token
  reachable from the browser).
- Claiming PCI compliance. It can support a merchant's evidence; the assessor decides compliance.

## 3. Constraints

- Ships as a JavaScript action: `runs.using: node24`, run from source, no build step, no
  `node_modules`. Same conventions as vuln-watch (see its CONTRIBUTING.md): no dependencies, format
  checks on everything read, never retry a POST or PUT, third-party text never trusted.
- Chrome comes from the runner image: GitHub's Ubuntu 24.04, Windows Server 2025 and macOS 15 images
  all include Google Chrome (157 on the 2026-11-16 Ubuntu image). The runner images document no
  `CHROME_BIN`, so scriptsnitch finds Chrome itself, with a `chrome-path` input as override.
- Must run locally on Linux, macOS and Windows with an installed Chrome, for writing and debugging a
  configuration.
- The public repository must stay generic: examples and tests use a demo site served by the tests,
  never a real site.

## 4. Approaches considered

**Driving the browser**
1. **Chrome DevTools Protocol directly, over `--remote-debugging-pipe` (chosen).** No dependency, no
   browser download, no open port. Puppeteer's source confirms the transport: JSON messages separated
   by a NUL byte, written to the child's fd 3 and read from fd 4. Cost: scriptsnitch owns the protocol
   plumbing (sessions, iframes, workers), so it gets thorough tests against real Chrome.
2. Playwright: robust and well tested, but a large dependency, its own browser builds, and frequent
   breaking releases. A supply-chain security tool should not import a supply chain.
3. Puppeteer: same trade-off, smaller.

**Judging a change**
1. **Deterministic rules with a severity and a plain-words reason per finding (chosen).** Explainable,
   testable, no service.
2. A machine-learning or LLM classifier (Cloudflare reports about 0.1% false positives with one). It
   needs training data and a service, costs money per run, and cannot say why.

**Where approvals and state live** (Ivan chose 1)
1. **A committed approved file, changes proposed as pull requests (chosen).** Reviewed, dated by the
   merge commit, diffable; doubles as the 6.4.3 inventory.
2. Issues as the only state, like vuln-watch: closing an issue approves. Simpler, but approval is a
   click without review and there is no inventory to show.
3. A dashboard: needs a server. Rejected.

## 5. Terms

Each term means exactly this everywhere below.

- **Site**: an origin (`https://shop.example`) that owns pages, an approved-file section, a site issue
  and an approval branch. A page belongs to the site named by its `site` key in the config, or by
  default to its URL's origin.
- **Page**: one entry in the config's `pages`, judged at its `url` after its `steps`. Pages are named
  in the approved file by URL path (section 9). A **sensitive page** is one marked `sensitive` (login,
  checkout).
- **Own origin**: the site's origin plus the exact origins in the site's `own` list in the approved
  file. Everything else is third-party.
- **Content hash**: the SHA-256 of a script's response bytes (external scripts), reproducible with
  `curl -s URL | sha256sum`. V8's internal script hash is computed over UTF-16 and matches nothing
  outside Chrome; it is used only as a cache key.
- **Build token**: a content-derived token in a file name (`main.3f2a1c9b.js`, `index-CLlpVvjr.js`). A
  URL with one is a **hashed file name**. A **path version** is a version in the path or file name
  (`@3.7.1`, `-3.7.1.min.js`); a **query version** is one in the query (`?ver=6.4.2`).
- **Slot**: the identity of one script across builds and versions: its URL with the build token or
  version replaced by a placeholder (section 8).
- **Template**: the identity of an inline script, its code structure (section 8).
- **Destination**: any request a tracked page or frame makes other than loading scripts and frame
  documents (section 8).
- **Deploy evidence**: proof, within a run, that the site released new code (section 8).
- **Visit**: one load of a page in one profile, in a fresh browser context. A **run** is one execution
  of the workflow. A run is **conclusive** for a page and profile unless its visits were inconclusive
  (section 10).
- **Approved for a page**: covered by an approved-file entry whose page scope includes that page
  (section 9). "Approved" always means this.
- **Finding**: one reportable difference between what a run observed and what is approved. Its
  **kind** comes from the table in section 10; its **key** is `kind|subject|page`, where the subject
  is the slot, template, origin, destination pattern, field signature or header name concerned, and
  `page` is the page path for page-level kinds and `*` otherwise. The profile is not part of the key
  (it is shown in the issue). Keys are stable across runs: changing how one is built rewrites every
  open issue, so it is a breaking change, as in vuln-watch.
- **Behaviour sign**: a finding of kind `new-destination`, `listener`, `input-code` or
  `probe-exfil` that is attributed to a script.
- **Routine** and **pending**: how a proposal enters the approved file (section 9). Routine entries
  are approved when the pull request is merged; pending ones are not approved until a person moves
  them out of `pending`.

## 6. How a run works

```
scriptsnitch/config.json      what to visit, how, who to tell
scriptsnitch/approved.json    what is allowed (reviewed in PRs)

collect job: observes, never judges
  permissions: contents: read; checkout without persisted credentials
  launch Chrome (pipe, sandbox on, allowlisted environment)
  for each page x profile, in parallel up to `concurrency`:
    visit A, visit B                                     -> learn what varies per visit
    probe visit(s) if the page has a sensitive field
    one more visit if anything not matched by approved.json was seen in only one visit
  cross-check new versioned and hashed files with a direct fetch
  write scriptsnitch-out/snapshot.json + evidence/

        snapshot artifact (same workflow run)

report job: judges and writes
  permissions: contents: write, issues: write, pull-requests: write, actions: read
  validate the snapshot strictly
  read the status issue marker (deploy evidence, accepted state, sightings, run log)
  turn observations into findings (section 10), with severity
  once a week: check the domains of approved scripts and destinations (section 8)
  fetch the previous run's evidence and build code diffs for changed scripts
  reconcile the site issues and the status issue; propose the approval pull request
  write the job summary and scriptsnitch-out/report.json (every finding, Info included)

command job (on issue comments): `/scriptsnitch approve <key> because <reason>` (section 12)
```

The collect job reads the approved file only to decide confirmation visits and cross-checks, by
plain matching; every severity, acceptance and deploy-evidence decision is the report job's, because
only it reads the stored state. `mode: check` runs both halves in one process, for the CLI and for
people who accept that trade-off (section 15); the action makes you choose a mode, and the README's
quick start uses the two-job split.

**State, in full.** Three places, each with one job:
- the **approved file**: what is allowed, and pending proposals (the only record of approval);
- each **site issue's marker**: per finding key, first seen, last seen, last reported, conclusive runs
  missed since last seen, whether a person muted it by closing the issue, and the date it dropped off
  (kept 30 days so a return does not notify again);
- the **status issue's marker**: a run counter; per page and profile, the last conclusive run and the
  current streak of inconclusive runs; per site, the build token or version of each own script slot
  that a page's HTML loads directly and the `deployMarker` value (the inputs to deploy evidence), the
  last accepted content hash of each own unversioned script and the accepted inline templates of each
  page (short hash prefixes), and the build tokens accepted through deploy evidence since the last
  deploy; per approved entry, the last run it was seen (for stale approvals); per checked domain, its
  registrar, registration date and expiry, and the date of the last domain check; a run log (date,
  conclusive pages, High and Medium counts, drill result) for the evidence pack; and, per finding key,
  the runs in which a not-yet-confirmed Medium finding was seen (the last 7). If the marker nears
  GitHub's size limit, the oldest sightings are dropped first, then the oldest run-log lines (the
  evidence pack says how far back the log reaches).

## 7. Capture

**Launch.** Chrome is located from `chrome-path` if set, else the known paths per OS
(`/usr/bin/google-chrome`, `/opt/google/chrome/chrome`,
`C:\Program Files\Google\Chrome\Application\chrome.exe`, the macOS app bundle, plus Chromium paths).
Flags: `--headless --remote-debugging-pipe --user-data-dir=<temp> --no-first-run
--no-default-browser-check --disable-background-networking --disable-component-update
--disable-sync --disable-extensions --disable-component-extensions-with-background-pages
--disable-blink-features=AutomationControlled --mute-audio`, with fds 3 and 4 opened as pipes. Chrome gets an
allowlisted environment (`PATH`, `HOME`, the temp-directory variables, `LANG`, and on Windows
`SystemRoot`), never the action's own, so no input, token (`INPUT_GITHUB-TOKEN`,
`ACTIONS_RUNTIME_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_*`) or secret reaches the browser process. No
`--no-sandbox` unless the `allow-no-sandbox` input is set; if Chrome reports no usable sandbox, fail
with an error that names the cause and the input. Chrome is killed (process tree) on exit, timeout or
crash; after a crash it is relaunched once, and pages still unvisited are inconclusive.

**Transport.** One module speaks the protocol: request ids, per-session routing (flattened sessions),
event subscription, a timeout on every command, and clean failure when Chrome exits. Messages are
NUL-delimited JSON on fds 3/4; partial reads are buffered.

**Staying unnoticed.** On page sessions scriptsnitch never enables the `Runtime`, `Console` or `Log`
domains (console serialization with `Runtime` enabled is a known detection trick); it calls
`Debugger.setSkipAllPauses({skip: true})` so a `debugger;` statement neither pauses nor hangs the page;
and it uses only queries that run outside the page's JavaScript.

**A visit.** Every visit gets a fresh `Target.createBrowserContext` (no cookies, no storage: each visit
is a first-time visitor, which many skimmers target) and is disposed afterwards. If the page has
`steps`, they run first; after the last step, if the tab is not already at the page's `url`, it
navigates there. Only the final page is judged: observations start with the navigation (or, in a
single-page app, the client-side route change) that lands on `url`. Auto-attach runs at browser level,
filtered to the visit's browser context, so the page, out-of-process iframes, popups, dedicated,
shared and service workers are all covered (`waitForDebuggerOnStart`, `flatten`). On every attached
session:
- `Network`, enabled with resource buffer sizes large enough to read big bundles back: every request
  (URL, method, resource type, initiator with stack, frame, body), responses (status, headers),
  `webSocketCreated`, `webSocketFrameSent` (payloads scanned for probe values, not stored),
  `webTransportCreated`, failures. Response bodies of scripts are read with `Network.getResponseBody`
  for the content hash.
- `Debugger`: every `scriptParsed` (script id, URL or none, start position for inline scripts, V8's
  hash, length, module flag, stack trace for injected code). Source text comes from
  `Debugger.getScriptSource`, cached within the run by V8's hash.
- `Runtime.runIfWaitingForDebugger` after setup, so nothing runs before scriptsnitch is listening.

After settling, and again after the probe, the DOM is read for `<link rel>` `dns-prefetch`,
`preconnect`, `prefetch` and `preload` hosts, which can carry data in a host name without any request
event.

**Headers.** From the final document's response, and `<meta http-equiv>` in the page: the
Content-Security-Policy (enforced and report-only), Strict-Transport-Security, X-Frame-Options,
X-Content-Type-Options, Referrer-Policy, Permissions-Policy and Cross-Origin-Opener-Policy.

**Profiles.** `desktop` and `mobile`, both by default (polyfill.io's payload ran only on phones). Each
run picks a viewport from a short list of common sizes for each profile, so the check does not always
look the same. Desktop uses the Chrome user agent of the host's operating system with
"HeadlessChrome" replaced, and matching client hints (always set: without them the brand list is
empty). Mobile uses an Android Chrome user agent, client hints, `navigator.platform` (set through
`setUserAgentOverride`), touch emulation and `maxTouchPoints` that agree with each other.

**Settling.** After the load event, wait until there are no requests in flight for 1 s and no new
script for 1.5 s, capped at 15 s; then scroll to the bottom once and settle again (cap 5 s) to
catch lazy scripts. WebSockets, event streams and requests open longer than 5 s (long polling) do not
count as in flight. Per-page overrides in the config.

**Consent banners.** On sites with a cookie-consent banner, most marketing tags (a common way in for
skimmers) load only after consent, so a visitor who never accepts never sees them. After the first
settle, scriptsnitch looks for a known consent manager (OneTrust, Cookiebot, Didomi, Usercentrics,
Quantcast Choice, TrustArc, Complianz, CookieYes, Osano, Termly and similar; one maintained list in
`data/` with each one's "accept all" control), clicks "accept all" with a trusted click, and settles
again. Everything observed before and after the click belongs to the same visit. `consent` in the
config: `"accept"` (default), `"ignore"`, or steps of your own. A banner found but not accepted is a
note on the status issue.

**Speed.** Images, media and fonts are held with `Fetch` and answered locally with an empty response,
but their URLs are still recorded as destinations (tracking pixels are a known exfiltration channel).
Configurable.

**Frames.** Iframes whose origin is an own origin are tracked exactly like the page. For other
iframes, by default scriptsnitch records the iframe's origin and the sensitive fields inside it, but
neither the scripts it runs nor the requests it makes (a payment provider's iframe is the provider's
responsibility, which PCI DSS 4.0.1 says too). `frames: "all"` in the config tracks their scripts and
requests as well.

**Fields.** One vocabulary everywhere: `password`, `card` (number, expiry or security code) and `iban`
are the sensitive kinds; `email` and `name` are filled by the probe and can be named in `receives`.
Detection: `input[type=password]`; any `autocomplete` token starting `cc-`; inputs whose name, id or
label looks like a card number, expiry, security code or IBAN (heuristics in one tested module);
`type=email` and `autocomplete` `email`/`name`; plus selectors from the config. Each sensitive field
gets a **field signature**: the frame (`top` or the frame's origin), the form (its method and action
path, else its id or name, else `none`), the field's name, id or `autocomplete` token, and the kind.
Identical signatures are counted, so a second card-number field next to the approved one is a new
field.

**Listeners.** In each tracked frame, after settling and again after the probe, for each sensitive
field, every ancestor up to the document and the window (crossing shadow-root hosts), and the submit
buttons of its form, `DOMDebugger.getEventListeners` returns listeners with the owning script.
Recorded: (field kind, role, event type, owning script), where the role is `field`, `form`, `submit`,
`ancestor`, `document` or `window`. Event types: `keydown`, `keyup`, `keypress`, `input`,
`beforeinput`, `change`, `focus`, `blur`, `focusin`, `focusout`, `paste`, `submit`, `click`,
`mousedown`, `mouseup`, `pointerdown`, `pointerup`, `touchstart`, `touchend`, and on the window
`beforeunload`, `pagehide` and `visibilitychange`. Chrome answers this without anything the page can
observe.

**Input-time code.** Listener ownership can mislead: a handler delegated through jQuery shows up as
jQuery, a debounced one as lodash. So during the probe, `Profiler.startPreciseCoverage({callCount:
true})` runs from the first keystroke until after submit, and the coverage says which scripts' code
actually ran while the fields were being filled. Code without a URL that ran is attributed to its
creator (section 8). The page cannot observe this either.

**Peer connections.** Live `RTCPeerConnection` objects are counted with
`Runtime.queryObjects` after settling and several times during the probe's wait (a closed, collected
connection would otherwise be missed). The prototypes are captured before any page script runs, so a
page cannot swap in a decoy. They have no owning script. Best effort; section 19 says so.

**Cloaking cross-check.** For every script at a versioned URL or hashed file name that the approved
file does not match exactly, the bytes Chrome received are compared with a direct `fetch()` of the
same URL from Node, sent with the Referer Chrome sent. Only a 200 response with a JavaScript content
type is compared; anything else (a 403, a challenge page) is recorded as a note.

**Evidence.** The source of every script that no `exact` entry matches (unapproved, or approved with
`origin` or `deploy` trust) is saved once per content hash under
`scriptsnitch-out/evidence/<content-hash>.js`, up to 2 MB each and 100 MB in total, so people can
read it even if an attacker later removes it.

## 8. Giving each observation a stable identity

This is where false alarms are won or lost.

**URL kinds.** Per-visit noise is removed first: query parameters whose values differ between visits A
and B are masked. Then every external script URL is classified by one tested module:
- *Hashed file name*: the file name carries a build token (`main.3f2a1c9b.js`,
  `/_next/static/chunks/8069-<token>.js`, and Vite's default 8-character base64url tokens such as
  `index-CLlpVvjr.js`, which may contain no digit and may contain `-` or `_`). The heuristic is built
  and tested against file names from real webpack, Next, Vite, Rollup, Parcel and esbuild builds. The
  same URL never legitimately serves different content.
- *Versioned*: a path version or a query version. On own origins a path version is treated like a
  build token (immutable): British Airways' attackers edited `modernizr-2.6.2.min.js` in place on
  BA's own server. A query version marks a new release of an own file; on third-party URLs it counts
  as floating, because vendors move it on their own.
- *Floating*: anything else (`js.stripe.com/v3/`, a tag manager container URL). Account keys are kept
  (below).
- `blob:`, `data:` and `wasm:` scripts are not URLs for this purpose: they are code without a URL,
  attributed to whatever created them, and compiling WebAssembly counts as runtime code creation.

**Slots.** A slot is the URL with the build token or version replaced by a placeholder.
`main.3f2a1c9b.js` and `main.9e8d7c6b.js` are the same slot (a newer build); `jquery@3.7.1` and
`jquery@3.8.0` are the same slot (an upgrade). When a hashed file disappears and another appears whose
name differs in that one token, they are the same slot even when the heuristic did not recognise the
token. Slots let findings say "upgraded from 3.7.1 to 3.8.0" instead of "unknown script".

**Deploy evidence and build folders.** An own script slot that a page's HTML loads directly is an
*entry slot*. A deploy is evident for a site in a run when an entry slot that existed in the previous
run now has a different build token, path version or query version (a replacement; a newly added
entry slot is not evidence, it is a new script), or when the site's `deployMarker` value changed. With
a `deployMarker` set up, only the marker counts: anyone who can edit the HTML can change an entry
token. Sites without hashed file names or query versions show deploy evidence only through a
`deployMarker`; the README says so.

A `deploy` entry can approve a whole build folder (`https://shop.example/assets/*.{token}.js`). A new
hashed file there is accepted when either its build token appears in the source of an accepted own
script on the page (the build's own chunk map names it, which a dropped-in file cannot arrange without
changing that script, itself a finding), or a deploy is evident in the run. Tokens accepted through
deploy evidence are remembered until the next deploy (section 6), so a lazily loaded chunk is not
reported again on a later run.

**Learning what varies.** Visits A and B of the same page and profile are compared before anything is
judged, to find *literal values inside an identity* that change per visit (query values, as above).
Masking never applies to *presence*: a script, destination, iframe, field or listener seen in only one
visit is an observation like any other. A probabilistic skimmer that shows up in one visit out of four
is therefore still caught. If one visit of a pair is inconclusive, one replacement visit is made; if
that fails too, the page and profile are inconclusive for this run.

**Inline scripts.** An inline script's template is its code structure. The source is tokenized.
Every string, number and regular-expression literal is replaced by a placeholder, except literals that
are entirely a URL or a host name and the arguments of code-running calls (`eval`, `Function`, string
`setTimeout`/`setInterval`, `document.write`, `innerHTML`/`outerHTML`/`insertAdjacentHTML`
assignments). Any bracketed region that contains only literals (a data blob) collapses to one
placeholder. A script that is a single assignment to, or push onto, a known framework data global
(`__NEXT_DATA__`, `self.__next_f`, `__NUXT__`, `__remixContext`, SvelteKit's data,
`ShopifyAnalytics.meta` and similar; one maintained list) keeps only the global's name, its URL
literals and its code-running calls. The template's identity is the SHA-256 of the result, and a
page's inline scripts are compared as a set, ignoring their number and order. Prices, product lists,
nonces and translations change the data, not the template; added code, a swapped endpoint or a swapped
`eval` payload change it.

**Injected and eval'd code.**
- *Injected code with its own URL* (a script element appended at runtime, a vendor loader's tags,
  lazy chunks) is a first-class external script: its own slot, approval and findings, like a script in
  the HTML. Its creator is recorded for the explanation. A script that an approved `origin` script
  injects from that script's own origin, or from a domain of the same vendor (vendor families from the
  vendored third-party-web entity list), inherits the injector's `origin` trust: reCAPTCHA's rotating
  release files and Google Maps' versioned chunks then never alert on their own. Nothing inherits onto
  a host that serves anyone's files (cloud storage, tenant subdomains), whoever runs it.
- *Code without a URL* (`eval`, `new Function`, inline script elements appended at runtime, `blob:`
  and `data:` scripts, WebAssembly) is attributed to the script that created it, using the stack trace
  from `scriptParsed` and the `Network` initiator. Its listeners, input-time code, destinations and
  hostnames count as the creating script's.

**Shared hosts.** One maintained list in `data/`, in two kinds:
- *Path-shared hosts*, where tenants differ by path (`cdn.jsdelivr.net`, `unpkg.com`,
  `cdnjs.cloudflare.com`, `raw.githubusercontent.com`, `gist.githubusercontent.com`, path-style
  `storage.googleapis.com` and S3): every slot there counts as its own origin for `new-origin`, and
  `origin` and `deploy` trust are refused.
- *Host-shared domains*, where each tenant gets a host name (`*.github.io`, `*.netlify.app`,
  `*.vercel.app`, `*.pages.dev`, `*.workers.dev`, `*.web.app`, `*.firebaseapp.com`, `*.herokuapp.com`,
  `*.cloudfront.net`, bucket-style S3, `*.firebaseio.com`): one exact host name is an ordinary origin
  and may get any trust level; a wildcard over the domain is refused. The README notes that names on
  Heroku, Netlify, Vercel and S3 can be re-registered by someone else after deletion; CloudFront
  names are assigned.

**Account keys.** Some services serve everyone from one host and tell accounts apart by a key: Google
Tag Manager and gtag (`?id=`), Google Analytics collect (`tid`), Apps Script (`/macros/s/<id>`),
Google Forms, the Meta pixel config, Hotjar and Segment script paths, Telegram bot, Discord and Slack
webhook paths, and similar. A maintained list in `data/` records where each key sits (a query
parameter or a path segment). For scripts and destinations on these services the key is part of the
identity: a new key counts as a new origin, and a pattern whose wildcard would cover keys is refused.
An attacker's own tag-manager container on the already-approved tag-manager host is therefore a
script from a new origin.

**Destinations** are every request a tracked page or frame makes other than loading scripts and frame
documents: fetch, XHR, beacons, pixels and other images, media, fonts, stylesheets, WebSockets,
WebTransport, and `<link>` prefetch hosts. Each destination is attributed to the script that made the
request, when the initiator stack names one. Loading a script from an origin never approves sending
data to it.

**Domain risk.** polyfill.io began with a domain sale, and expired script domains are regularly
re-registered by attackers. Once every 7 days (the date is kept in the status issue marker) the report
job checks each domain behind an approved script or destination, and each third-party host a page
still references:
- **DNS** (`node:dns`): a host, or the target of its CNAME, that no longer resolves is *dangling*:
  anyone could register it and serve code to your pages.
- **RDAP**, the registries' free JSON replacement for WHOIS (servers found through IANA's bootstrap
  file): the expiry date, the registration date and the registrar. The registrable domain is found by
  asking for the last two labels first and adding one label while the registry answers "not found".

A domain whose RDAP lookup fails is skipped for that week, never reported as safe. Findings:
`domain-dangling`, `domain-expiring` (within 30 days), `domain-changed` (registrar changed, or
re-registered since the last check); see section 10.

## 9. The approved file

`scriptsnitch/approved.json` by default (path set in the config). Written by scriptsnitch with
deterministic key order and one entry per object so diffs read well; edited by people in reviews.

```json
{
  "version": 1,
  "sites": {
    "https://shop.example": {
      "own": ["https://static.shop.example", "https://auth.shop.example"],
      "scripts": [
        {
          "id": "jsdelivr-jquery",
          "match": "https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js",
          "trust": "exact",
          "sha256": ["5d0f…"],
          "pages": ["**"],
          "behavior": { "hosts": [], "listens": [], "input": false, "eval": false, "obfuscation": "minified" },
          "reason": "jQuery for the product gallery",
          "approved": "2026-11-23"
        },
        {
          "id": "self-build",
          "match": "https://shop.example/assets/*.{token}.js",
          "trust": "deploy",
          "pages": ["**", "/login", "/checkout"],
          "behavior": { "hosts": ["api.shop.example"], "listens": ["password:field:input"], "input": true, "eval": false, "obfuscation": "minified" },
          "reason": "Our app's build output",
          "approved": "2026-11-23"
        },
        {
          "id": "gtm-main",
          "match": "https://www.googletagmanager.com/gtm.js?id=GTM-ABC123",
          "trust": "origin",
          "pages": ["**"],
          "behavior": { "hosts": [], "listens": ["*:document:click"], "input": false, "eval": true, "obfuscation": "minified" },
          "reason": "Marketing tags",
          "approved": "2026-11-23"
        },
        {
          "id": "inline-login-1",
          "match": "inline",
          "trust": "exact",
          "template": ["a91c…"],
          "pages": ["/login"],
          "behavior": { "hosts": [], "listens": [], "input": false, "eval": false, "obfuscation": "plain" },
          "reason": "Sets up the sign-in form",
          "approved": "2026-11-23"
        }
      ],
      "destinations": [
        { "match": "https://*.stripe.com", "pages": ["/checkout"], "reason": "Payments", "approved": "2026-11-23" },
        { "match": "POST https://shop.example/api/login", "receives": ["email", "password"], "pages": ["/login"], "reason": "Our sign-in endpoint", "approved": "2026-11-23" }
      ],
      "frames": [{ "match": "https://js.stripe.com", "fields": ["card"], "pages": ["/checkout"], "reason": "Stripe Elements", "approved": "2026-11-23" }],
      "fields": [{ "frame": "top", "form": "POST /login", "field": "password", "kind": "password", "count": 1, "pages": ["/login"], "reason": "Sign-in form", "approved": "2026-11-23" }],
      "allow": [{ "what": "peer-connection", "pages": ["/support"], "reason": "Video help widget", "approved": "2026-11-23" }],
      "headers": {
        "**": { "strict-transport-security": "max-age=31536000" },
        "/checkout": { "content-security-policy": { "script-src": ["'self'", "https://js.stripe.com"] } }
      },
      "pending": [
        {
          "finding": "new-origin|https://cdn.evil.example/x.js|*",
          "severity": "high",
          "into": "scripts",
          "entry": { "id": "evil-x", "match": "https://cdn.evil.example/x.js", "trust": "exact", "sha256": ["9b2e…"], "pages": ["/checkout"], "reason": "TODO: why does this page need it?" }
        }
      ]
    }
  }
}
```

**Patterns.**
- *URLs*: `scheme://host/path[?query]`. In the host, only leading labels may be wildcarded
  (`*.stripe.com` covers any depth of subdomain, not the bare domain). In the path, `*` matches within
  one segment and `**` across segments; `{token}` matches a build token and `{version}` a version. A
  query in a pattern lists the parameters that must match (a value or `*`); other parameters are
  ignored, except account-key parameters, which must be listed with their value, and per-visit
  parameters, which are always ignored. `http`/`ws` and `https`/`wss` match alike. A destination
  pattern may start with a method (`POST https://…`); without one it covers every method. Hosts from
  `<link>` prefetch match by host alone.
- *Pages*: URL paths, with `*` and `**` as above; `**` alone means every page. **A pattern never covers
  a sensitive page**: a sensitive page is covered only by an entry that lists its exact path. This
  applies to every entry type with `pages`. The default for `pages` is `["**"]`.
- *Listeners*: `kind:role:event`, each part a value from section 7 or `*`.

**Script entries.** `match` is a URL pattern, or `"inline"` with `template` hashes. Worker,
shared-worker and service-worker scripts are external scripts like any other.

**Trust levels.** Proposed automatically; people can change them in review. Each trust level is the
documented authorization for its entry, and says how integrity is assured (the README's PCI table
repeats this):
- `exact`: content must match an approved hash: `sha256` (several allowed, for A/B or regional
  variants) for external scripts, whose `match` must then be a literal URL; `template` for inline
  scripts. Integrity: the hash. Default for versioned and hashed third-party files and for inline
  scripts on sensitive pages. A new version of the same slot is a new URL to approve.
- `origin`: any content in this slot is accepted, which authorizes the vendor to update it; the
  findings in section 10 are the integrity check. Default for floating third-party files. Refused on
  path-shared hosts.
- `deploy`: own files and inline scripts, authorized through the site's own release process. For an
  external slot: a new build token, path version or query version is accepted when it replaces the
  previous one in an entry slot, when a deploy is evident, or (in a build folder) when the chunk map
  names it; a content change at an unchanged hashed file name or own path-versioned URL is never
  accepted; a content change to an unversioned own file is accepted only when a deploy is evident.
  For inline scripts (`match: "inline"`, default on pages that are not sensitive): a new template is
  accepted when a deploy is evident. Refused on path-shared hosts.

**Other entries.**
- `destinations` approves where data may go, by URL pattern (optionally with a method). `receives`
  names the field kinds it may receive from the probe on its pages: your sign-in endpoint, an SSO
  provider, a gateway that collects card data in the top page and posts it to its own API. Without
  `receives`, a destination may be contacted but may not receive probe values, and no origin, your own
  included, receives them implicitly.
- `frames` approves an iframe origin on pages, and the field kinds it may contain.
- `fields` approves sensitive fields by signature (section 7), with a `count` (default 1).
- `behavior.listens` approves a script's listeners; `behavior.input` approves its code running while
  sensitive fields are filled; `behavior.obfuscation` (`plain`, `minified`, `packed`) is the approved
  band; `behavior.eval` approves runtime code creation; `behavior.hosts` approves hostnames in its
  code.
- `allow` approves page capabilities that are otherwise findings: `peer-connection` for now.
- `headers` is the expected baseline, keyed by page pattern; unlike approvals, a `headers` pattern
  does cover sensitive pages. For each header name, the most specific matching key wins. Only listed
  headers are judged; the first-run proposal lists every tracked header that is present. Stronger
  headers do not move the baseline on their own (they are Info); `scriptsnitch approve --headers` or a
  hand edit adopts them.

**Pending.** Proposals that must not be approved by a merge go into the site's `pending` list instead
of the live sections: each names its finding key, severity, the section it goes `into`, and either a
whole `entry` or, for an addition to an existing entry, the entry `id` and the fields to add (`"add":
{"sha256": ["…"]}`, `{"listens": ["card:field:keydown"]}`, `{"receives": ["card"]}`, a header value).
The loader ignores `pending` completely, so nothing already approved is ever un-approved by a
proposal. Approving one means moving it into the live section, by hand or with `scriptsnitch approve
--id <key>`, one at a time. Which proposals are pending is decided by the table in section 10.

**Stale approvals.** An approved entry not seen in any conclusive run for 30 days is proposed for
removal as a routine change (PCI asks for an accurate inventory, and an approved file that only grows
leaves old approvals for an attacker to reuse). Removals ride in the open approval pull request, or in
one opened for them at most once a month.

**Reasons and dates.** Proposed entries carry `"reason": "TODO: why does this page need it?"`.
`scriptsnitch validate` fails while any live entry (not a pending one) still has a TODO reason, when
`requireReasons` is on (default on), so a required check can enforce the 6.4.3 justification. TODO
reasons never stop a monitoring run. `approved` is the date scriptsnitch proposed the entry; the merge
commit is the authoritative record of when and by whom it was approved. Integrity-attribute (SRI)
suggestions for third-party files appear in the pull request body, not in the file.

**Validation.** The approved file and the config are checked strictly on load, with errors that say
how to fix them: unknown fields; bad patterns; `origin` or `deploy` trust on a path-shared host; a
wildcard over a host-shared domain or over account keys; an `own` entry that is not one exact origin;
duplicate ids; an external `exact` entry without a literal URL and a `sha256`, or an inline one without
a `template`; a `pending` item that does not match its finding key. Load errors stop the run before
any visit. Warnings: a page without `expect` and without any approved own script (nothing would tell
its error page apart).

## 10. From observations to findings

The report job turns the snapshot's observations into findings. *Content* findings are computed only
for scripts whose content changed or that are new. *Behaviour* findings (listeners, input-time code,
eval, destinations, peer connections, probe results) are computed on every visit for every script,
because behaviour can change while content does not.

**Findings.** Severity decides whether a finding reaches an issue (High and Medium do; Info goes only
to the job summary and `report.json`). The last column decides how the approval pull request proposes
it: High findings are always **pending**, Medium findings are **routine**.

| Kind | Raised when | Severity |
| --- | --- | --- |
| `new-origin` | A script (in the HTML or injected) from an origin with no approved script for the page, a new slot on a path-shared host, or a new account key | High |
| `new-slot` | A new slot at an origin that already has an approved script for the page | Medium |
| `scope` | An approved script appears on a sensitive page its entry does not list | Medium |
| `new-version` | A new version, in a URL the page wrote, of an approved `exact` third-party script | Medium |
| `content-mismatch` | Content at an approved `exact` URL that matches no approved hash (including two different unapproved hashes in visits A and B) | High |
| `in-place-change` | A content change at an unchanged hashed file name, or at an own path-versioned URL | High |
| `own-change` | A content change to an unversioned own file with no deploy evident | Medium on sensitive pages, Info elsewhere |
| `new-own-script` | A new own script slot not covered by an approved entry (a build folder, an entry slot replacement) | High on sensitive pages, Medium elsewhere |
| `build-file` | A new file in an approved build folder that the chunk map does not name, with no deploy evident | High on sensitive pages, Medium elsewhere |
| `new-inline` | A new inline template not accepted by `deploy` trust | High on sensitive pages with no deploy evident; Medium otherwise |
| `cloaking` | A versioned or hashed file whose bytes differ between Chrome and a direct fetch | High |
| `new-destination` | A destination no approved pattern covers for the page | High during the probe (from the moment the network is held), or on a sensitive page when made by code without a URL or by a script whose content changed this run; Medium otherwise |
| `probe-exfil` | Any of section 11's tests | High |
| `listener` | A listener not approved for its script: on a field, its form or its submit button by a third-party or unapproved script | High |
| | The same, by an approved own script; or on an ancestor, the document or the window by an approved script | Medium |
| `input-code` | Code that ran during the probe's input, by an unapproved script or by code without a URL whose creator is not approved for input | High |
| | The same, by an approved script whose `behavior.input` is false | Medium |
| `new-field` | A sensitive field signature not approved in `fields`, or more of one than its `count` | High |
| `frame-field` | A sensitive field kind inside an iframe not approved for that kind | High |
| `new-frame` | An iframe origin not approved for the page, with no sensitive fields | Medium |
| `peer-connection` | Live `RTCPeerConnection` objects on a page without an `allow` entry | High |
| `eval` | Runtime code creation (WebAssembly included) by a script whose behaviour does not approve it | Medium |
| `obfuscation` | An obfuscation score above the script's approved band (section 10, "scores") | Medium |
| `hostname` | A new hostname in a script's code (section 10, "scores") | Medium on sensitive pages (for own scripts only when no deploy is evident), Info elsewhere |
| `domain-dangling` | A script or destination host (or its CNAME target) that no longer resolves | High |
| `domain-changed` | A script or destination domain whose registrar changed, or that was re-registered, since the last check | Medium |
| `domain-expiring` | A script or destination domain that expires within 30 days | Medium |
| `headers-weaker` | A weaker effective security header (below) | High |
| `csp-source` | A new specific host in a CSP directive, with no weakening | Medium |
| `headers-stronger`, `csp-report-only`, `accepted`, `not-seen`, `note` | Stronger headers; report-only CSP changes; changes accepted by trust or deploy evidence; approved scripts not seen; cross-check, consent and domain-lookup notes | Info |

The domain findings are approved or dismissed by fixing the domain (renewing it, removing the
reference); they have no entry in the approved file, and closing the issue mutes them until the next
change. Stale approvals (section 9) are housekeeping proposals, not findings.

**Combination.** When one script has two or more findings attributed to it in a run and at least one
of them is a behaviour sign (peer connections, which have no owning script, do not count), all of
that script's findings are raised to High (and so become pending).

**First run.** With no approved file, or none for a site, and no open approval pull request for it,
the first run proposes the whole inventory; once that pull request exists, what appears is proposed as
anything new is.
Because everything would otherwise be a High `new-origin`, the first run uses a different split: every
entry is routine except those risky in themselves, which are pending: `receives`, sensitive fields in
the top page or a tracked frame, frames with sensitive fields, listeners on a field, form or submit
button by a third-party script, input-time code by a third-party script or code without a URL, and
peer connections. The site issue says nothing is approved yet and that the first inventory is only as
clean as the site is today.

**Scores.**
- *Hostnames* are found in decoded string values only: adjacent literals joined
  (`'ba'+'ways.com'`), escape sequences decoded, base64-looking literals decoded and scanned, IPv4
  literals included. A bare dotted string counts only if it is URL-shaped after joining, or is entirely
  a hostname with a top-level domain from the vendored IANA list. Never property names or other code.
  A hostname is not new when it belongs to the script's own origin, an own origin, an approved
  destination, any approved script's `behavior.hosts` for the site, or a short built-in list of
  namespace and documentation hosts (`www.w3.org`, `schema.org`, `react.dev` and similar).
- *Obfuscation* is a cheap score (escape-sequence density, long high-entropy strings,
  `eval`/`atob`/`fromCharCode` per KB) mapped to the bands `plain`, `minified` and `packed`. `data:`
  URLs and decodable images, fonts and WebAssembly are left out, and minification alone never reaches
  `packed`.

**Weaker headers** are judged on the policy that actually takes effect under CSP level 3
(`'unsafe-inline'` and host sources ignored where a nonce or `'strict-dynamic'` applies): CSP removed,
a directive dropped, or `*`, a scheme-wide source, or an effective `'unsafe-inline'`/`'unsafe-eval'`
added to script, default or connect sources; HSTS removed or its max-age cut; framing protection
removed. Nonces and hashes are ignored.

**Confirmation.** High findings count on a single sighting, because real attacks can be probabilistic
(polyfill.io fired on 10-20% of phone visits). A Medium finding must be seen twice: in two visits of
one run (either profile), or in two different runs within the last 7, per finding key. Persistent
content is seen in every visit, so the rule only delays things that come and go, such as ad rotation.

**Inconclusive.** Judged per page and profile. A visit is inconclusive, not changed, when the final
document's status is 400 or more; the page ended up on an origin that is not an own origin; the page's
`expect` is missing (`{"selector": "…"}` or `{"text": "…"}` in the config; without one, and once the
page has an approved own script, the default is "at least one of the page's approved own scripts
loaded", which an error page usually fails and a skimmer has no reason to break, unlike the payment
iframe it may hide); a known bot challenge or queue page is detected (for example
`cf-mitigated: challenge`, "Just a moment...", and a small list of other vendors' signatures), which
counts only when the visit saw neither the expected content nor any approved own script, since a page
can plant a title or a captcha script itself; the load timed out; or the visit passed its deadline. Inconclusive visits produce no findings and resolve nothing; the other profile of the
same page still reports. Three inconclusive runs in a row for a page and profile raise a comment on
the status issue.

**Findings that cannot be approved.** Every finding that can be legitimate has a home in the approved
file. Three never are: a probe value sent to a static-file path, a card, security-code or password
value kept in browser storage, and cloaking on a file approved with `exact` trust (a file that
legitimately differs by browser is approved with `origin` trust instead). The fix for those is on the
site; closing the issue mutes them.

## 11. The form probe

**When.** One probe visit per profile for each page that has a sensitive field (`probe: true` forces
it, `probe: false` turns it off), plus, on sensitive pages, a second probe visit on the desktop profile
with different values (below). Each probe visit is a fresh context with the steps replayed; its load
counts like visits A and B.

**Holding the network.** After settling, `Fetch` is enabled for every request in the context, at the
request stage, on every session. "During the probe" starts here. Each request is recorded (URL,
method, body) and answered locally with an empty `204` (or `200` where a body is expected), so nothing
reaches any server and the page sees success instead of falling onto error paths that would load more
code. A held page navigation is simply cancelled by the `204`.

**Values.** Fresh random values every run, so a skimmer cannot recognise the probe: a Luhn-valid card
number on a common card prefix, a future expiry, a security code, a plausible name and an email
address, a random password, a valid-format IBAN, and plausible values for every other visible field
the form requires (address, phone, postcode, a ticked terms box), so the browser's own validation
lets the form submit. Fields inside iframes that are not tracked are left alone.

**Acting like a person.** Text is typed with `Input.dispatchKeyEvent` (key down, character, key up)
and fields are left with a real focus change; the submit button is clicked with
`Input.dispatchMouseEvent` on desktop and `Input.dispatchTouchEvent` on mobile, so trusted
`mousedown`, `mouseup` and `touchend` events fire (the British Airways and Newegg skimmers listened for
exactly those). Without a submit button, `requestSubmit()` is used; for fields outside any form, the
probe presses Enter in the last field and clicks the nearest button in the same container.

**Watching long enough.** After submit: wait 3 s on ordinary pages and 8 s on sensitive ones; read
the fields, frames and listeners again (fake forms often appear only after "Place order"); count peer
connections; then navigate the tab to `about:blank` while `Fetch` still holds requests, so `pagehide`,
`visibilitychange` and unload beacons are recorded too. Finally read the origin's localStorage,
sessionStorage and cookies through the protocol, for values a skimmer saved to send later.

**What counts as exfiltration** (`probe-exfil`). A probe value is searched for in every held request
(URL, headers, body) from every frame, and every WebSocket frame, in all common forms: raw;
URL-encoded once and twice; JSON `\u` escapes; hex; base64 and base64url at all three alignments; the
card number digits-only and spaced. Then:
- a value reaching any destination whose `receives` does not cover that field kind on that page (your
  own origin included: a collector planted on a compromised store is a favourite);
- a value sent to a static-file path (`.jpg`, `.png`, `.gif`, `.svg`, `.css`, `.js`, `.ico`,
  `.woff`), whatever `receives` says;
- on sensitive pages, using the second probe's values of very different lengths: a request field sent
  to a destination without `receives` whose size grows with the input (which catches encrypted
  payloads);
- a card, security-code or password value found in browser storage.

**Real effects.** HTTP is held by `Fetch`, and the probe also turns on network-offline emulation,
which stops WebSocket frames, even on a socket opened before the hold, while Chrome still reports
their payloads (section 20, result 8). So forms never reach the server, including sites that submit
forms over a WebSocket (Phoenix LiveView, Blazor Server, Meteor), and the fake values are still
searched for in every frame the page tried to send.

## 12. Reporting

**Site issues.** One issue per site, titled with the worst severity and a count, for example
`🔴 scriptsnitch: 2 unapproved changes on shop.example`. The body starts with a marker
`<!-- scriptsnitch {json} -->` (section 6). Below it, a table: severity, what changed, where (page and
profile), the reasons in plain words, a link to the evidence in the run's artifact, and the approval
path. Rules:
- The body is rewritten each run to show what is live and not approved.
- A comment, which notifies, is posted only when a new finding key appears.
- A Medium finding drops off after two conclusive runs without it; if it returns within 30 days it is
  listed again without a new comment.
- A High finding that stops appearing stays listed as "not seen since <date>" until a person closes
  the issue after investigating (attackers remove skimmers to cover their tracks; approving something
  that is gone means nothing). So does a High raised under a `deploy` entry (`build-file`,
  `new-inline`) that a later deploy accepted rather than an approval.
- The issue closes itself when nothing live is unapproved and no High finding is waiting.
- Closing the issue by hand mutes the findings in it. A new finding key reopens the same issue with
  a comment; muted findings stay listed in a collapsed section, so the history stays in one place.
- Assignees and `cc` come from `notify` in the config, with vuln-watch's fallback when an assignee
  cannot be assigned.

**Status issue.** One issue `scriptsnitch status`, kept open and rewritten each run. Its first line
says "Last run <time>. If this is more than two days old, scriptsnitch has stopped running." Then:
pages and profiles checked, inconclusive pages, pages where the probe only typed, last conclusive run
per page and profile, run time. It comments when a page has been inconclusive for three runs or
recovers. Its marker holds the cross-run state (section 6).

**Approval pull requests.** One branch per site, `scriptsnitch/approve-<site>`, with one pull request
that edits `approved.json`. Only open High and Medium findings lead to proposals; Info never does.
- **Routine** (Medium) findings become live entries or additions, each with a proposed trust level,
  a TODO reason and a severity badge in the pull request body. Similar sibling hosts are grouped into
  one wildcard for review, never on a shared host or an account-keyed service.
- **Pending** (High) findings go into the site's `pending` list (section 9), so merging the pull request
  does not approve them (the first run splits differently; section 10). The pull request body lists them first, under a warning, with their evidence.
  `own` suggestions are made in the body only, never in the file.
- **Keeping the branch current.** While every commit on the branch is the bot's, each run commits
  additions for findings not yet proposed (through the contents API, never a force-push) and updates
  the branch from `main` when needed. Once a person has pushed to it, the bot stops touching the
  branch; it comments once per new finding key that it is not in this pull request and will come in
  the next one, opened after this one is merged or closed. A person's edits are never lost. The body
  lists proposals whose findings are no longer live; the pull request closes itself when none of its
  findings is live any more.
- **Checks.** Commits pushed with the default `GITHUB_TOKEN` trigger no workflows, so the `validate`
  check does not run on the bot's commits. Because the bot stops after a person's push, and a person
  must push to fill in TODO reasons, the last commit of a mergeable pull request is a person's
  whenever `validate` is required. The README explains this, and accepts a GitHub App token through
  `github-token` for teams that want checks on every bot commit (a personal token's commits would be a
  person's, which freezes the approval branch).
- With `propose: issue`, or if the repository does not allow GitHub Actions to create pull requests
  (a 403 naming that setting), no pull request is opened: the issue shows the exact edits (and, for
  the 403, how to enable the setting).

**Code diffs.** For a changed script, the issue shows what changed, not just that it changed: the
report job downloads the previous successful run's evidence artifact (the `actions: read`
permission), formats both versions (a small built-in formatter breaks minified code into lines at
statements and blocks), and shows a line diff with the added lines that contain hostnames,
code-running calls or access to sensitive fields marked. The issue shows up to 60 changed lines; the
job summary and `scriptsnitch-out/diffs/` hold the rest. When no previous copy exists (a new script,
or an expired artifact), the issue shows an excerpt of the new code with the same marks.

**Approving by comment.** A comment `/scriptsnitch approve <finding key> because <reason>` on a site
issue approves exactly one finding, without a local clone. A workflow on `issue_comment` (in the
examples and the reusable workflow) runs `mode: command`, which:
- ignores comments from bots and on issues that are not scriptsnitch site issues;
- checks through the API that the commenter has write access to the repository, else replies that
  they cannot approve;
- parses the comment strictly; the key must be an open finding in the issue's marker;
- moves the matching `pending` proposal (or routine proposal) into the live file on the site's
  approval branch, with the given reason, creating the pull request if needed, and replies with a
  link. Merging that pull request remains the approval of record, so branch protection still applies.

`/scriptsnitch mute <finding key>` mutes one finding without closing the issue. Comment text is
untrusted input and is never echoed unescaped.

**Fire drills.** With `drill: true` (an input; the examples run it on the first day of each month),
the collect job also makes one drill visit per sensitive page: inside the browser only, through
`Fetch`, it adds a harmless test skimmer from `https://drill.scriptsnitch.invalid` (a domain that can
never exist) to the page, which listens on the sensitive fields and sends the probe values to the
same domain. The report job checks that the expected findings (`new-origin`, `listener`,
`probe-exfil`) were raised for that visit, reports "drill passed" or "drill failed: missed …" on the
status issue, and never reports drill findings anywhere else. Nothing touches the site's server.

**Evidence pack.** `mode: evidence` (and the CLI's `evidence --since <date>`) writes
`scriptsnitch-out/evidence-<date>.md` for an assessor: the inventory with each entry's reason, trust
level and how its integrity is assured; who approved what and when, from the git history of the
approved file (the example checks out the full history); the run log from the status issue (every
check with its date and result, and how far back the log reaches); drill results; and the README's
PCI mapping. It states plainly that it supports, and does not certify, compliance.

**Untrusted text.** Script URLs, page titles and code excerpts come from the web. Everything is
escaped for Markdown; `@names` and links are neutralized (vuln-watch's `feedText` rule); code goes in
fenced blocks longer than any backtick run in it; no raw HTML. Strings written into `approved.json`
are JSON-encoded, so a hostile URL cannot break the file.

**Job summary.** Always written: pages, profiles, visits, inconclusive, findings by severity, changes
accepted by trust or deploy evidence (Info), timing.

## 13. The configuration file

`scriptsnitch/config.json`:

```json
{
  "approved": "scriptsnitch/approved.json",
  "notify": ["octocat"],
  "sites": { "https://shop.example": { "deployMarker": { "url": "https://shop.example/version.txt" } } },
  "pages": [
    { "name": "Home", "url": "https://shop.example/", "expect": { "selector": "#main" } },
    { "name": "Sign in", "url": "https://shop.example/login", "sensitive": true, "expect": { "selector": "form#login" } },
    {
      "name": "Checkout",
      "url": "https://shop.example/checkout",
      "sensitive": true,
      "expect": { "selector": "#payment" },
      "steps": [
        { "goto": "https://shop.example/product/1" },
        { "click": "#add-to-cart" }
      ]
    }
  ]
}
```

**Keys** (defaults in brackets): `approved` [`scriptsnitch/approved.json`]; `notify` [none];
`profiles` [`["desktop", "mobile"]`]; `block` [`["image", "media", "font"]`]; `concurrency` [4];
`requireReasons` [true]; `frames` [`"own"`, or `"all"`]; `fields` [extra selectors per field kind];
`sites` [none], per site origin: `deployMarker`, either `{"url": …}` (the SHA-256 of the response
body) or `{"page": …, "selector": …, "attribute": …}` (an attribute's value, for example a build meta
tag); and per page: `name`, `url`, `site` [the URL's origin], `sensitive` [false], `expect`, `steps`,
`probe` [automatic], `settle` overrides.

Also `consent` [`"accept"`] at the top level or per page.

**Steps:** `goto`, `click`, `type` (a selector with `value`, `secret` (the name of an environment
variable) or `totp` (the name of an environment variable holding a base32 one-time-code seed; the
code is generated with RFC 6238 defaults, SHA-1, 30 s, 6 digits, by `node:crypto`)), `wait` (a
selector or milliseconds). Secret values come from the collect step's
environment, are never logged, and are redacted from the snapshot and evidence by value. Step pages
are not judged (section 7). scriptsnitch is not a crawler and does not follow links.

## 14. Interfaces

**Reusable workflow.** The simplest setup is five lines that call the workflow this repository ships,
which contains the collect and report jobs with the right permissions, the artifact hand-off, the
validate check on pull requests and the comment command:

```yaml
name: scriptsnitch
on:
  schedule: [{ cron: '17 6 * * *' }]
  push: { branches: [main], paths: ['scriptsnitch/**'] }
  pull_request: { paths: ['scriptsnitch/**'] }
  issue_comment: { types: [created] }
  workflow_dispatch:
permissions: { contents: write, issues: write, pull-requests: write, actions: read }
jobs:
  scriptsnitch:
    uses: vancoder1/scriptsnitch/.github/workflows/scriptsnitch.yml@v1
    secrets: { step-secrets: '${{ secrets.SCRIPTSNITCH_STEP_SECRETS }}' }
```

Inside, each job narrows its own permissions (the collect job keeps only `contents: read`), and the
event decides which jobs run. Step secrets arrive as one JSON object secret and are passed to the
collect step only. The workflow refers to the action by the same major tag, so releases move both.

**Action inputs:** `mode` (required: `collect`, `report`, `validate`, `command`, `evidence` or
`check`), `drill` (false), `config` (default
`scriptsnitch/config.json`), `out` (default `scriptsnitch-out`), `github-token` (default the job token;
used only in `report` and `check`), `propose` (`pr` default, or `issue`), `dry-run` (`report` and
`check` judge everything and write the job summary and `report.json`, but make no change on GitHub),
`fail-on` (`never` default, `medium` or `high`: whether `report` and `check` fail the step when such
findings are open), `chrome-path`, `allow-no-sandbox`, `jitter` (a random delay of up to that many
minutes before collecting; default 0, because the wait is billed on private repositories).
**Outputs:** `high`, `medium`, `inconclusive`, `snapshot`. `collect` fails only on errors.

**CLI** (`node bin/scriptsnitch.js`, from a clone; no npm package in v1): `scan <url>` (a one-off
inventory of one page with no setup: scripts with their kind and trust suggestion, destinations,
frames, sensitive fields, listeners and headers; `--probe` adds the probe, `--json` prints JSON),
`init <url…>` (writes a starter config for the given pages plus the sign-in, cart and checkout links
it finds on them, one level deep and never further, and a first approved-file proposal), `check`,
`collect`, `report`, `validate`, `evidence`, and `approve`, which edits the approved file locally: `--id <key>` moves one
pending proposal into the live file or adds one finding from a report (a deliberate act), `--all` adds
every routine finding, `--headers` adopts the current headers. By default the CLI is stateless: it
reads no GitHub state, so there is no deploy evidence except a `deployMarker` and the chunk map, and
Medium findings are confirmed only within the run; it never writes to GitHub. With `--github
owner/repo` and a token it also reads the status issue's state, read-only. Exit codes: 0 nothing
unapproved, 1 High or Medium findings, 2 no findings but some page inconclusive, 3 error (invalid
config, Chrome failed).

**Example workflows** (in `examples/`; actions pinned by SHA in the real files):

```yaml
# scriptsnitch.yml
name: scriptsnitch
on:
  schedule: [{ cron: '17 6 * * *' }]
  push: { branches: [main], paths: ['scriptsnitch/**'] }
  workflow_dispatch:
concurrency: { group: scriptsnitch }
permissions: {}
jobs:
  collect:
    runs-on: ubuntu-24.04
    permissions: { contents: read }
    steps:
      - uses: actions/checkout@<sha>
        with: { persist-credentials: false }
      - uses: vancoder1/scriptsnitch@v1
        with: { mode: collect }
      - uses: actions/upload-artifact@<sha>
        if: always()
        with: { name: scriptsnitch, path: scriptsnitch-out/, retention-days: 30 }
  report:
    needs: collect
    if: always()
    runs-on: ubuntu-24.04
    permissions: { contents: write, issues: write, pull-requests: write }
    steps:
      - uses: actions/checkout@<sha>
      - uses: actions/download-artifact@<sha>
        with: { name: scriptsnitch, path: scriptsnitch-out/ }
        continue-on-error: true
      - uses: vancoder1/scriptsnitch@v1
        with: { mode: report }
```

```yaml
# scriptsnitch-validate.yml: the check that enforces reasons on approval pull requests
name: scriptsnitch validate
on:
  pull_request: { paths: ['scriptsnitch/**'] }
permissions: { contents: read }
jobs:
  validate:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@<sha>
        with: { persist-credentials: false }
      - uses: vancoder1/scriptsnitch@v1
        with: { mode: validate }
```

When collect failed or left no snapshot, report records the failure on the status issue and changes
nothing else. A second vantage point (section 19) is a self-hosted runner running the same workflow,
so it shares the same issues and state.

## 15. Security of scriptsnitch itself

- No dependencies. Example workflows pin actions by commit SHA. gitleaks and actionlint run on the
  repository.
- The collect job processes hostile content by design: read-only contents permission, checkout
  without persisted credentials, no write token for the repository, and Chrome started with an
  allowlisted environment and its sandbox on. Every job's environment still holds
  `ACTIONS_RUNTIME_TOKEN` (cache and artifact access); keeping it out of the browser process and
  keeping the sandbox on is what protects it, and the README says so. Step secrets are for low-value
  test accounts and are documented as such.
- `mode: check` runs the browser in the process that holds the write token; the README explains why
  the two-job split is the default and what `check` trades away.
- The report job never executes anything from the snapshot. The snapshot carries a format version;
  report refuses another major version and validates the shape strictly. A malformed snapshot is a
  failed run, not a clean one. A compromised collect job could lie in its snapshot; the README states
  this boundary.
- Evidence artifacts contain third-party code; retention is configurable (default 30 days).
- The comment command acts only for commenters with write access, checked through the API on every
  comment, and only through the approval branch, so branch protection and review still apply.
- DNS and RDAP answers are third-party data: format-checked like vuln-watch's feeds, and a failed or
  unrecognised answer is "unknown", never "safe".
- The reusable workflow narrows permissions per job; the caller's broader grant never reaches the
  collect job.

## 16. Performance

One Chrome for the run; one browser context per visit; `concurrency` contexts at a time (default 4).
Per page and profile: two visits, one probe visit on pages with sensitive fields, and a confirmation
visit only when something unapproved was seen once; plus a second probe on the desktop profile of
sensitive pages. Images, media and fonts are answered locally. Script sources read once per distinct V8
hash; templates, hostname extraction and obfuscation scores cached by content hash; precise coverage
only during the probe. Target: 10 pages x 2 profiles in one to two minutes on `ubuntu-24.04` (measured
by the self-test and reported in the job summary).

## 17. Testing

- **Units**, table-driven: URL kinds (file names from real webpack, Next, Vite, Rollup, Parcel and
  esbuild builds, including Vite tokens with no digit), slots, own path versions, shared hosts and
  account keys, deploy evidence, volatility masks, inline templates and framework data globals,
  hostname extraction (joined, escaped and base64 strings; property names and dotted words that must
  not match), obfuscation bands, effective-CSP comparison, probe value encodings, the findings table
  (every row and the combination rule), page-pattern and sensitive-page coverage, finding keys,
  approved-file and config validation, `pending` handling, deterministic writing, Markdown escaping of
  hostile text.
- **Transport**: fake child streams (split frames, several messages in one chunk, Chrome exiting
  mid-command, timeouts).
- **Real Chrome against a local demo site**: `node:http` on 127.0.0.1, with Chrome's
  `--host-resolver-rules` mapping `shop.test`, `cdn.test`, `pay.test`, `evil.test` and a fake
  tag-manager host to it, so tests have several origins and no network. One scenario per behaviour,
  asserting the exact findings. Attacks: injected script; tag-manager container under a new account
  key; skimmer file dropped in the build folder without a deploy; a new script added to the HTML as a
  new entry slot; in-place edit of an own path-versioned file; changed versioned third-party file;
  hashed file changed in place; tag-manager-injected inline skimmer; jQuery-delegated listener (caught
  by input-time code); card-field iframe from a new origin; second card field overlaid after "Place
  order"; keyboard listener on the password field; `mouseup` listener on the submit button; WebSocket
  exfiltration on submit; delayed send; unload beacon; value stashed in localStorage; base64 at an odd
  offset; encrypted payload (caught by the second probe); post to a collector on the site's own origin
  and to an image path; analytics collect with a foreign key; WebTransport; `dns-prefetch`
  exfiltration; peer connection; `blob:` worker; mobile-only script; cloaked file; page with a
  `debugger;` loop. **False-alarm scenarios are first-class**, each asserting zero High or Medium
  findings: a deploy that renames and adds chunks (Vite and webpack style); a lazily loaded chunk first
  seen a day after a deploy; per-visit token in a URL; nonce and data-blob changes in inline scripts; a
  Next-style flight payload change; reCAPTCHA-style rotating release file under an approved loader;
  approved A/B variant; framework root and analytics document listeners already approved; a page with
  a long-polling connection; a script that appears in only one visit at an approved slot; hash-based
  CSP churn; adopting a strict CSP with `'strict-dynamic'`. And the expected Medium, not High: a
  library upgrade, a new CSP host.
- **Whole runs** with an in-memory GitHub, run after run, as vuln-watch's `test/run.test.js` does:
  issue lifecycle, comment only on new keys, muting and reopening, "not seen since", 30-day cooling,
  7-run confirmation, deploy evidence across runs, status issue, pull request kept current until a
  person pushes and left alone after, `pending` proposals never approving, 403 and `propose: issue`
  paths, first run, `dry-run`.
- **Additions**: domain checks against stubbed DNS and RDAP (dangling, expiring, changed, lookup
  failure is never "safe"); the formatter and diff on minified fixtures; the comment command
  (permission denied, unknown key, bot comment, hostile text, success path); consent acceptance on demo
  banners in the style of the common managers; stale-approval proposals; `scan` and `init` against the
  demo site; a fire drill that passes, and one that fails when detection is broken on purpose; the
  evidence pack from a fixture history; TOTP against RFC 6238's test vectors.
- **CI**: the full suite on `ubuntu-24.04`; launch and transport smoke tests on `windows-2025` and
  `macos-15`. A self-test workflow runs the action (`uses: ./`) against the demo site, and one calls
  the reusable workflow.
- Mutation checks on the findings table, the volatility masks, the template builder and the probe
  matcher before release.

## 18. Repository

Same shape and conventions as vuln-watch: `action.yml`, `bin/`, `src/` (`chrome/`, `capture/`,
`analyze/`, `report/`, plus config, approved file and snapshot modules), `data/` (each list with its
source and date: top-level domains, shared hosts, account-keyed services, vendor families from
third-party-web with its MIT notice, framework data globals, namespace hosts), `examples/`, `test/`
(with `fixtures/site/`), README with a diagram, quick start, example issue and pull request from the
demo site, the false-alarm model, a PCI mapping table (6.4.3's three parts and 11.6.1, per trust
level, with the "supports, does not certify" note) and the limits below; LICENSE (MIT, Ivan
Zaporozhets), SECURITY.md, CONTRIBUTING.md (with the rules a change can quietly break: finding keys,
the findings table's severities, `pending` never approving, never touching a branch a person pushed
to, no dependencies), CHANGELOG.md, CLAUDE.md (`@CONTRIBUTING.md`), issue and pull request templates.
Releases: tag `vX.Y.Z`, GitHub release, move `v1`.

## 19. Limits the README states plainly

- A scheduled check from a data center is a tripwire, not a guarantee: an attack can target only
  some visitors, regions, times, returning visitors or signed-in accounts. GitHub publishes the
  Actions IP ranges, so an attacker can skip them with one lookup; a self-hosted runner gives a second
  vantage point for checkout pages. CSP reporting from real browsers is the complement.
- A skimmer that uses only approved channels (an approved script's existing listeners and eval,
  sending to an approved destination under an approved key, encrypted) can pass; the probe narrows
  this but cannot close it.
- The first inventory is only as clean as the site is on the first run.
- It sees only the pages and steps you list. Inside third-party iframes it tracks origins and fields,
  not code, unless configured.
- WebRTC detection is best effort. Domain checks depend on registries answering RDAP; some
  country-code registries do not, and those domains are reported as unchecked.
- GitHub turns off scheduled workflows in a public repository after 60 days without activity; the
  status issue's first line shows when the last run was.
- It detects; it does not block. A compromised collect job could hide findings.
- Supporting PCI DSS 6.4.3 and 11.6.1 evidence is not compliance; the assessor decides.

## 20. Experiments and results

Short throwaway experiments before the real build, because each one could change a design decision:
1. The pipe transport with the preinstalled Chrome on all three runner images, and Chrome's location
   on each.
2. The sandbox on `ubuntu-24.04` with the packaged Chrome (AppArmor exempts
   `/opt/google/chrome/chrome`), without `--no-sandbox`.
3. What new-headless Chrome reports for `navigator.userAgent`, client hints, `navigator.platform`,
   `maxTouchPoints` and `navigator.webdriver` when driven over the pipe without
   `--enable-automation`; settle the profile overrides.
4. Browser-level auto-attach filtered to a browser context: out-of-process iframes, popups,
   dedicated, shared and service workers, module scripts, inline scripts in iframes.
5. Attribution of injected code: stack traces on `scriptParsed` for eval, appended scripts and
   `blob:` workers, and `Network` initiators.
6. `getEventListeners` on fields, ancestors (across shadow roots) and submit buttons inside
   out-of-process iframes; how framework root listeners look.
7. Precise coverage during typing: overhead, and attribution of delegated handlers to the script that
   registered them.
8. `Fetch` holding fetch, XHR, `sendBeacon`, pixels and navigations during the probe and answering
   them locally; whether network-offline emulation stops WebSocket sends; recording unload beacons
   while navigating to `about:blank`.
9. `Runtime.queryObjects` for `RTCPeerConnection` and `RTCDataChannel` with the `Runtime` domain
   not enabled; capturing the prototypes before page scripts run.
10. `Network.getResponseBody` on large bundles with raised buffer sizes (the content hash depends on
    it).
11. Real-world timings and the cost of the `Debugger` domain on large bundles, to set the settle and
    timeout defaults and the concurrency.

**Results (2026-11-24, Chrome 157/158, local Windows and GitHub's runners):**
1. Confirmed on `ubuntu-24.04` (`/usr/bin/google-chrome`), `windows-2025`
   (`C:\Program Files\Google\Chrome\Application\chrome.exe`) and `macos-15` (the app bundle). On
   Windows, `PATH`, `TMP`, `TEMP` and `SystemRoot` are enough.
2. Confirmed: the sandbox works on `ubuntu-24.04` without `--no-sandbox`. macOS prints harmless
   "sandbox" XPC lines, so only Chrome's "No usable sandbox" message counts as a sandbox failure.
3. The default user agent says "HeadlessChrome" and `navigator.webdriver` is `true`.
   `--disable-blink-features=AutomationControlled` makes it `false`, and the desktop override must
   also set client hints (without them the brand list is empty, itself a tell). The mobile override is
   consistent across user agent, platform, client hints and touch points.
4. Browser-level auto-attach also attaches Chrome's own targets (its UI, the new-tab page, built-in
   extensions' service workers), some inside the visit's context. Only targets in the visit's browser
   context with an `http`, `https`, `blob`, `data` or `about` URL are kept; others are released and
   detached. `--disable-component-extensions-with-background-pages` removes most of them. Each kept
   page or frame session sets auto-attach again to reach out-of-process iframes and workers.
5. `eval` code has a stack trace whose frames carry the creator's script id; an appended external
   script has none, but its `Network` initiator stack does. A `blob:` worker attaches as its own
   target with no creator, so its behaviour is attributed to "unknown creator".
6. Listeners are readable in out-of-process iframes once `DOM.enable` is called there; window
   listeners through an evaluated `window` reference. Ancestors come from the `DOM.getDocument` tree
   (`describeNode` gives no parent).
7. Confirmed: precise coverage during typing names the skimmer behind a delegated handler.
8. Confirmed: `Fetch` holds fetch, XHR, beacons, pixels and form navigations, and the server receives
   nothing. Network-offline emulation stops WebSocket frames on an open socket (and new sockets
   fail) while `webSocketFrameSent` still reports their payloads, so the probe always submits.
   *Later, on Linux CI:* Chrome releases the held frames when the visit's browser context is torn
   down, and they then reached the server on every run (crashing the page first did not help). A
   probe visit's context therefore runs through a small local proxy that is cut just before the
   context is disposed (section 23).
9. `Runtime.queryObjects` works without `Runtime.enable` and counts `RTCPeerConnection` objects;
   counts of `RTCDataChannel` objects are unreliable (they are collected first), so only peer
   connections count.
10. Confirmed: a 5 MB body is read back with raised buffer sizes.
11. A page with a 5 MB script, an iframe and a worker loads and is read in about 5 s; the timing
    defaults stand.

## 21. Order of work

1. Transport, launch, a visit, steps, the snapshot, `collect`.
2. Content hashes, URL kinds, slots, shared hosts, account keys, deploy evidence and build folders,
   volatility, inline templates, patterns, the approved file with `pending`, the findings table,
   `check`, `approve`, `validate`.
3. Fields and signatures, listeners, frames, the probe (values, input, hold, encodings, second
   probe), input-time code, peer connections, cloaking, profiles.
4. Reporting: site issues, status issue and its state, approval pull requests, summary,
   `report.json`, code diffs, stale approvals; the action's modes and inputs; the example workflows.
5. Domain risk, consent banners, the comment command, fire drills, the evidence pack, TOTP, `scan`
   and `init`, the reusable workflow.
6. Public polish: README, self-tests, release v1.0.0.

## 22. Left to the builder

Exact thresholds (settle times, obfuscation bands, the second probe's growth test), the heuristics for
build tokens, related-domain suggestions and sensitive fields (each with tests), the contents and
refresh mechanism of the lists in `data/`, the snapshot's and the markers' internal shapes, module and
file names inside `src/`, and issue and pull request wording within the rules above.

## 23. Changes during the build

Decisions taken while building v1.0.0 that change or sharpen what the sections above say. Each was
made against this document's intent and is covered by tests.

- **Probe isolation (section 11).** A probe visit runs through a local proxy that applies Chrome's own
  host rules and is cut before the context closes, so held WebSocket frames are written into a dead
  socket (section 20, result 8). Async call stacks are enabled, so image pixels and timer-delayed
  requests name the script behind them.
- **`receives` is per endpoint (sections 9 and 11).** A probe value reaching an endpoint is one finding
  per method and path, and its approval is a destination entry for that endpoint. Granting `receives`
  on an origin-wide entry would let a collector planted elsewhere on the site receive passwords.
- **Approved or gone (section 12).** A finding that is no longer raised but whose subject is still
  observed (same content hash, endpoint, listener and script) was approved and leaves the issue
  silently; only a finding whose subject is gone has "vanished", and a vanished High stays listed.
- **Reported changes stay reported (sections 9 and 10).** A content change at an own file is not
  adopted as the new baseline until its hash is approved (`sha256` on the entry) or, for an
  unversioned file, a deploy is evident. `deploy` entries may list approved hashes and templates.
- **First and stateless runs (section 8).** With no entry-slot history, a file the page loads directly
  from an approved build folder is accepted; the CLI's stateless `check` therefore cannot tell a new
  build-folder script tag from the existing bundle.
- **Volatility (section 8).** A query parameter is per-visit only when its values in the two visits
  share nothing, and account-key parameters are never masked.
- **Link hosts (section 10).** A probe value in a `dns-prefetch` or `preconnect` host name is
  `probe-exfil`, and a hint that appears only during the probe is a High `new-destination`.
- **State (section 6).** The status marker keeps the date each entry of every section was last seen
  (for stale approvals), and drops hashes, templates and entry slots of files no longer loaded once
  every page of a site was conclusive, so it stays bounded. Step secrets are redacted from the snapshot
  and evidence by value.
- **Reusable workflow (section 14).** It checks the action out at its own commit
  (`job.workflow_sha`), so the workflow and the action always match, before and after a release.
- **Evidence pack (section 12).** Approvals come from comparing whole versions of the approved file in
  git, so moving an item from `pending` into the live file shows as the approval it is.

From the release review:

- **Script identity (section 7).** A `//# sourceURL=` name is no identity: Chrome reports it as the
  script's URL, so it counts only for the file fetched at that address with exactly that text. Inline
  scripts are also recognised by the addresses their document was fetched at and moved to with
  `history.pushState`.
- **Own files (sections 8 and 9).** An own file is known by its origin and path, plus a query version,
  whatever other parameters it is loaded with; a file whose variants differ by a parameter keeps the
  hashes of each. A new build file is vouched for only by a script known before the run or the entry
  file of a known slot, never by another new file. Next.js build directories are build tokens and
  Magento's `version<digits>` directories path versions.
- **Account keys (section 8).** A key parameter given twice matches no pattern and its key is all its
  values; paths are matched with unreserved percent-escapes decoded.
- **The probe (section 11).** The growth test compares the largest size of each field per endpoint, and
  endpoints mask the ids a session puts in a path. From the moment the network is held the proxy opens
  no new connection and looks up no name, and a page or frame whose hold cannot be set up stops the
  probe.
- **Hostile text and sizes (sections 6 and 12).** Markers count only at the top of a body. Table cells
  escape pipes. Subjects and reasons made of page text are bounded (start and hash), the site marker
  and the text are fitted to GitHub's body limit, the approval pull request names its findings by key
  digests, and own-file hashes are kept by a digest of the identity. Evidence paths are fixed by their
  hash.
- **GitHub (section 12).** The approval pull request is only one whose branch is in this repository and
  named for the site; commits by `[bot]` accounts are the bot's (GitHub App tokens included). A failure
  writing it falls back to the issue, and a proposal the approved file could not read back is left out
  with a note. Only reads are retried.
- **Configuration (section 15).** Duplicate keys and two pages on one path are refused; `notify` takes
  teams as `org/team`.
