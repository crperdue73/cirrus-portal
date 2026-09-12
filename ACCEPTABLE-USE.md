# Acceptable Use Policy — Cirrus Portal

**Product:** Cirrus Portal · **Copyright:** © 2026 CRPerdue Technologies, LLC
**License:** Apache-2.0 (see [`LICENSE`](LICENSE))

Cirrus Portal is **self-hosted, single-tenant** software. CRPerdue Technologies
does not operate your instance and does not have access to it. **You** — the person
or organization running an install — are the operator, and you are responsible for
how it is used and who can reach it.

This policy describes the baseline an operator must uphold when an instance is
reachable from an untrusted network, and sets expectations for anyone using one.

---

## 1. Operator responsibilities

If you expose a Cirrus Portal instance publicly (anything beyond loopback / your
own trusted LAN), you agree to:

1. **Terminate TLS.** Serve over HTTPS (the portal refuses a public bind without
   TLS unless you explicitly override it). Never expose credentials in cleartext.
2. **No default or shared credentials.** Create unique, strong per-person accounts.
   Never reuse the setup password or a shared login.
3. **Keep it patched.** Track upstream releases and apply security fixes promptly.
4. **Least privilege.** Grant the smallest role each user needs; review the roster
   and revoke access for people who no longer need it.
5. **Know your users.** Only people you are willing to be accountable for should
   have accounts.
6. **Protect the data.** Users' conversations, files, and gateway tokens are
   sensitive. Secure backups, restrict file access, and retain data no longer than
   you need it.
7. **Honor the licenses and terms of what you connect.** Any OpenClaw gateway or
   third-party service you wire up has its own terms; you are responsible for
   complying with them, and for having the right to connect those systems.

## 2. Prohibited uses

You may not use a publicly exposed Cirrus Portal instance to:

- Break the law, or help anyone else break the law
- Harass, threaten, defraud, or harm other people
- Generate or distribute malware, or attack other systems
- Attempt unauthorized access to any system, network, or account, including the
  gateways behind the instance or any third party
- Send spam or unsolicited bulk messages, or evade rate limits / access controls
- Infringe intellectual-property, privacy, or other rights
- Store or process data you are not legally permitted to hold
- Misrepresent the software's origin, or use the "Cirrus" name/branding as your own
  (the Apache-2.0 license does **not** grant trademark rights — see `NOTICE`)

## 3. User expectations

If you use an instance run by someone else:

- Use it only for the purpose that operator intends, and follow their local rules
- Do not attempt to escalate your role or reach data or agents you were not given
- Do not share your credentials; report suspected compromise to the operator
- Understand that **the operator** — not CRPerdue Technologies — controls that
  instance, its data, and its retention

## 4. Enforcement

Operators are responsible for enforcing this policy on their own instance,
including suspending or removing users who violate it. Where abuse is reported
against a deployment, CRPerdue Technologies may decline support for, and is not
responsible for, instances that are run contrary to this policy.

## 5. No warranty

This software is provided "AS IS", without warranty of any kind, as set out in
section 7 of the [Apache License 2.0](LICENSE). You operate it at your own risk.

---

_Questions: security@crperdue.com. This policy governs use of hosted instances; it
does not modify or replace the `LICENSE` that governs the software itself._
