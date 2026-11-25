# Data files

Lists scriptsnitch reads at run time. Each says where it comes from and when it was last refreshed.

| File | What it is | Source | Refreshed |
| --- | --- | --- | --- |
| `tlds.txt` | Every top-level domain, lowercase, one per line. Used to tell a hostname in a string from a dotted word. | [IANA root zone list](https://data.iana.org/TLD/tlds-alpha-by-domain.txt) | 2026-11-24 |
| `vendor-families.json` | Domain → company, so a script one vendor's loader injects from another of its domains (Google's `gstatic.com` for `google.com`) is recognised as the same vendor. | [third-party-web](https://github.com/patrickhulce/third-party-web) `data/entities.js`, MIT licence (see `NOTICE-third-party-web.md`) | 2026-11-24 |
| `vendor-own-hosts.json` | For companies whose name also covers hosting anyone can use (Google, Microsoft, Amazon Web Services), the hosts that serve their own code: only these inherit a loader's trust across hosts. | Hand-maintained | 2026-11-25 |
| `shared-hosts.json` | Hosts that serve anyone's files. `path`: tenants differ by path (jsDelivr, unpkg). `host`: each tenant gets a host name (`*.netlify.app`). | Hand-maintained | 2026-11-24 |
| `account-keys.json` | Services that serve every customer from one host and tell accounts apart by a key in the query (`param`) or the path (`regex`, first group). | Hand-maintained from each service's documentation | 2026-11-24 |
| `framework-globals.json` | Globals that frameworks fill with page data (`__NEXT_DATA__`, `__NUXT__`), whose inline scripts are data, not code. | Hand-maintained | 2026-11-24 |
| `namespace-hosts.json` | Hosts that appear in code as XML namespaces or documentation links and are never contacted. | Hand-maintained | 2026-11-24 |
| `challenges.json` | Signs of a bot challenge or queue page, which make a visit inconclusive. | Hand-maintained | 2026-11-24 |
| `consent-managers.json` | Cookie-consent managers and their "accept all" control. | Each vendor's documentation | 2026-11-24 |

## Refreshing the generated files

```sh
cd data/build
curl -fsSL -o tlds-alpha-by-domain.txt https://data.iana.org/TLD/tlds-alpha-by-domain.txt
curl -fsSL -o entities.js https://raw.githubusercontent.com/patrickhulce/third-party-web/master/data/entities.js
cd ../..
node data/build/build-data.mjs
```

The converter evaluates `entities.js` in an empty `node:vm` context (no `require`, no `process`).
Review the diff of the generated files before committing.
