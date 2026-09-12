# Security Policy — Cirrus Portal

**Product:** Cirrus Portal (family: Cirrus · engine: Cirrus Core)
**Maintainer:** CRPerdue Technologies, LLC

We take the security of Cirrus Portal and the people who deploy it seriously.
This document explains how to report a vulnerability and what to expect from us.

---

## Supported versions

Security fixes are provided for the most recent public release line.

| Version | Supported | Notes |
| --- | --- | --- |
| 3.x | ✅ | Current public line |
| 2.x | ⚠️ Best effort | Pre-release; upgrade to 3.x for fixes |
| < 2.0 | ❌ | Unsupported |

Always test reports against the latest release.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately to:

- **Email:** security@crperdue.com
- **Encryption:** available on request (ask for our public key in your first message)

Include as much of the following as you can:

- A clear description of the issue and the impact you believe it has
- The affected component (server, web UI, installer, container config)
- The exact version, plus OS/runtime and how it was deployed (Docker or Node)
- Step-by-step reproduction, or a minimal proof of concept
- Any suggested fix or mitigation
- How you would like to be credited (or "anonymous")

If you are unsure whether something is a real vulnerability, send it anyway — we
would rather triage a false positive than miss a real one.

## What to expect

| Stage | Target |
| --- | --- |
| Acknowledge your report | within 3 business days |
| Initial triage + severity assessment | within 7 business days |
| Status update | at least every 14 days while open |
| Fix or documented mitigation | by severity, agreed with you during triage |
| Coordinated public disclosure | by default, 90 days after the report, or sooner by agreement |

We will keep you informed, tell you plainly if we decide something is not a
vulnerability and why, and credit you in the release notes unless you ask us not to.

## Scope

**In scope** — issues in our code and shipping configuration:

- The Cirrus Portal server (`portal-server.js`) and its HTTP API
- The web UI (`portal.html`, `setup.html`) and the setup wizard
- Authentication, session, CSRF, RBAC, and rate-limiting logic
- The installer, container image/Compose config, and shipped TLS templates
- Credential/secret handling and defaults

**Out of scope** — please report these upstream or elsewhere:

- The **OpenClaw gateway** itself (report to the OpenClaw project)
- Third-party components (Node.js, Alpine/BusyBox, Caddy, nginx)
- Vulnerabilities that require a host already compromised by the attacker
- Social engineering, physical access, or supply-chain issues in dependencies
  you obtained from a third party
- Volumetric denial-of-service, or reports produced only by an automated scanner
  with no demonstrated impact

## Ground rules (safe harbor)

We will not pursue or support legal action against researchers who:

- Act in **good faith** and make a genuine effort to avoid privacy violations,
  data destruction, and service interruption
- Test only against **your own** instance, or one you have explicit permission to test
- Give us reasonable time to fix an issue before public disclosure
- Do **not** access, modify, or exfiltrate other people's data

Please **do not**: run destructive tests, pivot into other systems, use the finding
for extortion or profit, or disclose publicly before a fix is available. If in doubt,
ask us first — we will work with you.

## Hardening guidance for operators

Cirrus Portal is **single-tenant and self-hosted**. Before exposing an instance
publicly, follow:

- [`DEPLOYMENT.md`](DEPLOYMENT.md) — supported model and platforms
- [`ACCEPTABLE-USE.md`](ACCEPTABLE-USE.md) — acceptable-use baseline for public hosts

Minimum: terminate TLS (the portal refuses a public bind without TLS unless
explicitly overridden), keep the instance patched, and never ship default credentials.

---

Thank you for helping keep Cirrus Portal and its users safe.
