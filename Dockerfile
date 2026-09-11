# Cirrus Portal 🐯 — browser console for OpenClaw agent fleets
# Family: Cirrus · Engine: Cirrus Core
# Zero-dependency Node 22 server. No npm install step.

# Base image pinned by DIGEST (multi-arch manifest list) — supply-chain
# hardening, plan item 8. Known-good: node:22-alpine (alpine 3.24), amd64+arm64.
# Refresh deliberately:  docker buildx imagetools inspect node:22-alpine
FROM node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32

WORKDIR /app

# Server + UI + health probe. Config and device identity persist via volumes
# (docker-compose.yml).
COPY portal-server.js portal.html setup.html nexus.html branding.json healthcheck.js ./

EXPOSE 18800

# NOTE: no ENV PORT/BIND here on purpose — image-level env overrides beat the
# config file in loadConfig() (env is applied after the file). Port/bind come
# from portal-config.json; ad-hoc `docker run -e` still works when needed.

# Unprivileged runtime user (plan item 8). Fixed uid:gid so host bind-mounts can
# be chown'd deterministically — install.sh/bootstrap.sh do that. Override with
# --build-arg PORTAL_UID=…/PORTAL_GID=… if the host needs a different id (then
# chown the state files to match).
ARG PORTAL_UID=10001
ARG PORTAL_GID=10001
RUN addgroup -g "$PORTAL_GID" -S portal \
 && adduser -u "$PORTAL_UID" -S -G portal -h /app -s /sbin/nologin portal
USER $PORTAL_UID:$PORTAL_GID

# Liveness probe: loopback GET / — any HTTP response means the server is
# serving (200/3xx normally, 302→/setup and 503 in first-run SETUP mode).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "/app/healthcheck.js"]

CMD ["node", "portal-server.js"]
