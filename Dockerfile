# Agent Portal 🐯 — browser chat bridge to OpenClaw agents
# Zero-dependency Node 22 server. No npm install step.

FROM node:22-alpine

WORKDIR /app

# Server + UI. Config and device identity persist via volumes (docker-compose.yml).
COPY portal-server.js portal.html nexus.html ./

EXPOSE 18800

# NOTE: no ENV PORT/BIND here on purpose — image-level env overrides beat the
# config file in loadConfig() (env is applied after the file). Port/bind come
# from portal-config.json; ad-hoc `docker run -e` still works when needed.

CMD ["node", "portal-server.js"]
