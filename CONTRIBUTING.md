# Contributing

Thanks for helping. [README.md](README.md) is the reference for what scriptsnitch does, the approved
file and the issue lifecycle; [docs/design.md](docs/design.md) holds the reasoning behind each rule.
This file is how to change it safely.

## Before you start

scriptsnitch does **one job**: it tells you when the code your pages run, or where they send data,
changes in a way nobody approved. Known vulnerabilities in libraries, CSP authoring, uptime, privacy
trackers and blocking attacks belong to other tools (design §2). If you are unsure, open a feature
request first.

## Working on it

```sh
npm run test:unit       # judging, reporting, GitHub (in memory): a few seconds
npm run test:chrome     # real Chrome against the demo site: a few minutes
npm run test:scenarios  # every documented attack and false alarm: about 25 minutes
npm test                # all of it
```

Node 24 and an installed Chrome. There is nothing to install: no dependencies. The demo site
(`test/fixtures/site/`) serves `shop.test`, `cdn.test` and friends on 127.0.0.1; each scenario module
changes one thing.

- **A judging change gets a unit test** in the owning test file and, when it changes what a whole
  page or run reports, a scenario in `test/scenarios/` (attacks assert exact findings, false alarms
  assert none).
- **A capture change gets a real-Chrome test** in `test/chrome/`, and must pass on Linux, where CI
  runs it: Chrome behaves differently between platforms (see `src/capture/proxy.js`).
- **Workflows** pin actions by commit SHA with the version in a comment. `actionlint` runs on every
  workflow change.
- One commit per change, with a message that says why.

## Rules a change can quietly break

- **Finding keys are permanent.** `kind|subject|page` (`src/analyze/keys.js`) identifies a finding in
  every open issue, approval pull request and pending entry. Changing how a subject is built rewrites
  them all, so it is a breaking change.
- **The findings table is the contract.** Severities and kinds follow design §10 and the README. A
  change there changes what wakes people up; argue it in the pull request.
- **`pending` never approves.** The loader ignores the `pending` list, High findings are only ever
  proposed there, and moving an item out takes a deliberate act (a hand edit, `approve --id`, or a
  comment). Nothing may route a High proposal into a live section.
- **Never touch a branch a person pushed to.** The approval pull request is changed only while every
  commit on its branch is the bot's (`src/report/pr.js`). Never force-push, ever.
- **Never retry a POST.** A create that timed out may have gone through (`src/report/github.js`); the
  next run is the retry.
- **Inconclusive resolves nothing.** A page that could not be checked raises nothing and closes
  nothing. A failed or missing snapshot changes nothing but the status issue.
- **Nothing reaches the site.** The probe's requests are answered locally, its connections are cut
  before the browser context closes, and its values are fake. Keep it that way, and keep scriptsnitch
  invisible to the page: no `Runtime.enable`, `Console.enable` or `Log.enable` on page sessions.
- **Web text is hostile.** Script URLs, code, header values and page titles reach GitHub only through
  `src/report/text.js` (`md`, `code`, `fence`), which escapes them and stops mentions and links. In a
  table cell use `cellCode`, not `code`: GitHub splits a cell at a pipe even inside a code span, and
  URLs may hold pipes.
- **The browser holds no secrets.** Chrome gets an allowlisted environment, the collect job holds a
  read-only token, and step secrets are redacted from everything written.
- **No dependencies.** Node built-ins only. A security tool should not bring its own supply chain, and
  it is why the action runs from source with no build step.

## Releasing

Update `CHANGELOG.md` and the version in `package.json`, tag `vX.Y.Z`, publish a GitHub release, and
move the major tag (`v1`) to the same commit. The reusable workflow checks the action out at its own
commit, so the tag moves both.
