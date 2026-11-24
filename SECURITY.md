# Security policy

## Reporting a vulnerability in scriptsnitch

Please report it privately through GitHub: **Security → Report a vulnerability** on this repository
([private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
Don't open a public issue. You should get a first answer within a week.

Useful details: the version or commit you use, what an attacker could do, and the steps or input that
show it.

## Scope

In scope: scriptsnitch's own code and workflows. For example: a way for a watched web page to run code
outside the browser, reach the workflow token or a step secret, hide a finding, make scriptsnitch
approve something, close an issue for a change that is still live, mention or notify people, or make
the form probe's values reach a server.

Out of scope: scripts scriptsnitch reports on your site, and the limits listed in the README (a
scheduled check is a tripwire; a skimmer that uses only approved channels can pass).

## Supported versions

Only the latest release of the current major version (`v1`) gets fixes.
