# Third-Party Notices — Cirrus Portal

**Product:** Cirrus Portal (family: Cirrus · engine: Cirrus Core)
**Copyright:** © 2026 CRPerdue Technologies, LLC
**License:** Apache License, Version 2.0 (see [`LICENSE`](LICENSE))

This file satisfies the attribution requirement of Apache-2.0 §4(d) and documents
every third-party component a user receives when they install Cirrus Portal.

---

## 1. Bundled third-party code: none

Cirrus Portal ships **zero bundled third-party libraries**.

- The server (`portal-server.js`), UI (`portal.html`, `setup.html`, `nexus.html`),
  installer, and tooling have **no npm dependencies** — there is no `package.json`,
  no `node_modules/`, and no vendored/forked source tree.
- Every `require()` in the shipped code resolves to a **Node.js built-in module**
  (`crypto`, `fs`, `http`, `https`, `path`). Node built-ins are part of the Node
  runtime, not redistributed third-party packages.
- The release tarball (`dist/cirrus-portal-<version>.tar.gz`) contains **only**
  our own code, the installer, and our documentation. `release.sh` refuses to build
  if any runtime-state or secret file would leak in.

Because nothing third-party is redistributed *inside* the product, there is no
third-party copyright notice that must be reproduced in the tarball.

## 2. Runtime dependencies (not redistributed by us)

Cirrus Portal needs a **Node.js 22+** runtime. In the official container image the
runtime is the upstream `node:22-alpine` base image. Users obtain it themselves
(Docker pulls it, or the host provides Node). CRPerdue Technologies does not
redistribute the base image in the release tarball.

For transparency, the notable components of that runtime stack are:

| Component | Role | License |
| --- | --- | --- |
| Node.js 22 | JavaScript runtime | MIT |
| musl libc (Alpine) | C standard library | MIT |
| BusyBox (Alpine) | Core userland utilities | GPL-2.0-only |
| Alpine Linux base | Distribution | Mixed / per-package |

The Alpine image is an **aggregate** of separate programs. BusyBox and other
GPL/GPL-compatible components are independent executables that are *not* linked
into Cirrus Portal's code, so they do not impose copyleft obligations on this
project. If you redistribute a derived container image yourself, you are
responsible for honoring those upstream licenses.

## 3. Reverse-proxy templates

`deploy/Caddyfile` and `deploy/nginx/cirrus-portal.conf` are **configuration
templates authored by us**, consumed by Caddy or nginx that you install yourself.
Neither Caddy nor nginx is bundled or redistributed here (Caddy: Apache-2.0;
nginx: BSD-2-Clause).

## 4. Dependency inventory (SBOM note)

Because the dependency set is empty (§1) and the runtime is host/upstream-provided
(§2), the software bill of materials for a Cirrus Portal release is trivially small.
A machine-readable SBOM will ship with release engineering (plan item 14) and will
record the pinned `node:22-alpine` image digest — the only meaningful external input
to the build.

---

_If you believe a third-party notice is missing, contact security@crperdue.com._
