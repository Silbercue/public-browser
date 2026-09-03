# Security Policy

## Supported versions

Only the latest published version of `public-browser` receives security fixes. Please
upgrade before reporting an issue.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's
[private vulnerability reporting](https://github.com/Silbercue/public-browser/security/advisories/new)
rather than in a public issue.

Include the affected version, what an attacker can achieve, and the steps to reproduce.
You can expect a first response within seven days. Once a fix is released, you will be
credited in the advisory unless you prefer otherwise.

## Scope notes

Public Browser drives a real Chrome instance over the Chrome DevTools Protocol on the
user's own machine. Anything reachable from that browser session — cookies, logged-in
sessions, local files exposed to the page — is by design within reach of the automation.
Reports that only restate this model are not vulnerabilities; reports about the server
exceeding it (for example, data leaving the machine, or a page being able to steer the
server) are.
