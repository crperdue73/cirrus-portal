# Screenshots

Real captures of the current build, taken from a throwaway **demo instance**
(a mock gateway with two agents) — never from a production system.

| File | View | Notes |
| --- | --- | --- |
| `01-login.png` | Login | No default credentials; points at `/setup` for first-run |
| `02-agents-chat.png` | Agents + chat | Streaming reply, tool receipts area, live session |
| `03-dashboard.png` | Dashboard | Stat tiles, roster, recent activity (instructor/admin) |
| `04-rooms.png` | Rooms | Panel mode — a room with two agents |
| `05-users.png` | Users | Accounts, roles, assigned agents (admin) |
| `06-gateways.png` | Gateways | Live gateway list + add form (admin) |
| `07-audit.png` | Audit | Filterable audit log (admin) |
| `08-student-view.png` | Agents (student) | Restricted nav + injected course-context strip |

---

## Regenerating the pass

The screenshots are reproducible. `capture.js` drives headless Chromium over the
DevTools Protocol; it has no dependencies beyond **Node 22+** (built-in
WebSocket) and **chromium** on `PATH`.

```bash
# 1. Demo dir + mock gateway (two fake agents: labbot, grader)
DEMO=/tmp/cirrus-demo
mkdir -p "$DEMO" && cd "$DEMO"
cp /path/to/portal/{portal-server.js,portal.html,setup.html,nexus.html} .
cat > portal-config.json <<'JSON'
{ "port": 18890, "bind": "127.0.0.1", "publicBind": false,
  "gateways": [{ "id": "demo", "name": "Demo Fleet",
                 "url": "ws://127.0.0.1:18791", "enabled": true }],
  "tlsMode": "off" }
JSON
chmod 600 portal-config.json
node /path/to/portal-multi/mock-gateway.js 18791 &     # mock gateway
PORTAL_PASSWORD='Demo-Mission-Control-2026' node portal-server.js &

# 2. Seed a little data (admin + instructor + student + one room)
node seed-demo.js http://127.0.0.1:18890                # see docs/screenshots/seed-demo.js

# 3. Capture
cd /path/to/portal/docs/screenshots
node capture.js http://127.0.0.1:18890 .
```

The captures above were produced from a clean instance of the v3.0.0 build with:

- **admin** (`Demo-Mission-Control-2026`) — all views
- **instructor** `casey` (`Instructor-Demo-2026x`) — for the roster views
- **student** `jordan` (`Student-Demo-2026xx`) — restricted agents view
- one room, **Ops Standup** (`labbot` + `grader`)

> These passwords are throwaway demo credentials on a loopback-only instance
> that is torn down after capture. They are not shipped and do not exist in any
> release.
