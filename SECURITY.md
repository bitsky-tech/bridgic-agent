# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security problems.**

Report privately through GitHub's ["Report a vulnerability"][ghsa] button on
the Security tab, or by email to <security@bitsky-tech.com>.

Please include what you were able to do, the steps to reproduce it, and the
version and OS you tested on. We will acknowledge your report and keep you
updated on the fix.

We do not currently run a paid bug bounty. We will credit you in the release
notes unless you'd rather stay anonymous.

[ghsa]: https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability

## Supported versions

Only the latest release receives security fixes.

## What Bridgic Agent is, in security terms

This matters more than the usual boilerplate, so read it before deploying
Bridgic Agent anywhere.

**Bridgic Agent runs code on your machine on behalf of a language model.** The agent
has a shell tool, a file-write tool, and network access. That is the product,
not a bug. The consequence is that anything able to influence the model's
input — a web page it fetches, a file it reads, a repository it clones — is
in a position to attempt prompt injection, and a successful injection can
reach those tools.

The defenses against that are:

- **A permission engine** that classifies each tool call and is fail-closed:
  when the classifier is unavailable, the call is denied rather than allowed.
- **Execution modes** that set how much the agent may do without asking you.
  The strictest mode requires approval for every side effect.
- **A sensitive-path list** that forces approval for reads and writes near
  credentials — SSH keys, `.env` files, cloud credentials, browser password
  stores, and the agent's own policy and credential files.

None of these are a sandbox. **Do not treat Bridgic Agent as a security boundary.**
If you point it at untrusted content while running in a permissive execution
mode, assume it can do anything your user account can do. Run it in a VM or
container if that matters to you.

## Local service surface

The daemon listens on `127.0.0.1:7421` and exposes an HTTP + WebSocket API.
Binding to loopback keeps other machines out. It does **not** keep local
software out, and it does not by itself stop a web page in your browser from
issuing requests to it — the API requires a bearer token, read from
`~/.bridgic/AmphiAgent/runtime.json`, for exactly that reason.

If you find any endpoint that accepts a state-changing request without a
valid token, that is a vulnerability. Please report it.

## Known limitations in the current release

We would rather list these than have you discover them.

- **Provider API keys are stored unencrypted** in the local SQLite database
  under `~/.bridgic/`. The directory is created with `0700` permissions, so
  other users on the same machine cannot read it, but any process running as
  you can. Encryption at rest is planned.
- **The Chromium download used by the browser tool is not integrity-checked.**
  The runtime may select a regional mirror for speed and does not verify a
  checksum or signature against the official release. A compromised mirror, or
  a network able to intercept that domain, could serve a modified browser
  binary. Pinning and checksum verification are planned. You can avoid the
  mirror path entirely by pre-installing the browser yourself.
- **The renderer's Content Security Policy allows `unsafe-inline` and
  `unsafe-eval`**, which substantially weakens CSP as a defense against XSS in
  rendered agent output. Markdown output is sanitized before rendering, which
  is the primary control here. Tightening the CSP is planned.

## Scope

In scope: authentication and authorization on the local API, sandbox and
permission-engine bypasses, credential disclosure, code execution reachable
without user consent, and supply-chain issues in how we build and distribute.

Out of scope: the model doing something you disagree with when you granted it
permission to; findings that require an attacker who already has code
execution as your user; and denial of service against your own local daemon.
