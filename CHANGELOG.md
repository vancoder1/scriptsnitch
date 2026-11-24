# Changelog

## 1.0.0

First release.

- Visits the configured pages in Chrome (desktop and mobile, twice each) and records scripts,
  destinations, frames, sensitive fields, listeners, security headers and runtime code.
- A form probe with fake values on pages with password or card fields; nothing reaches any server.
- Judging per the design's findings table: script identity and content, behaviour, fields, frames,
  headers, domain risk, combination, two-sighting confirmation for Medium findings, and deploy evidence
  for your own builds.
- One issue per site, a status issue holding the cross-run state, approval pull requests that respect
  people's edits, approval by comment, code diffs, fire drills and an evidence pack.
- A reusable workflow, the action modes `collect`, `report`, `validate`, `command`, `evidence` and
  `check`, and a command line with `scan`, `init`, `check`, `approve` and `evidence`.
