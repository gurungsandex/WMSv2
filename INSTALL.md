# Workstation Monitoring System — Installation Guide

## Prerequisites

- Docker 24+ and Docker Compose v2
- A domain name (or use `localhost` for local dev)
- Ports 80 and 443 open (Caddy handles TLS automatically)

---

## 1. Clone and configure

```bash
git clone https://github.com/gurungsandex/workstation-monitoring-system.git
cd workstation-monitoring-system
cp .env.example .env
```

Edit `.env` and set:

| Variable | Description |
|---|---|
| `DB_PASSWORD` | Strong postgres password |
| `JWT_SECRET` | 32+ char random string (user auth) |
| `AGENT_JWT_SECRET` | 32+ char random string (agent auth) |
| `CADDY_HOST` | Your domain (e.g. `monitor.example.com`) or `localhost` |
| `CORS_ORIGIN` | Same as your domain with `https://` prefix |
| `NEXT_PUBLIC_API_URL` | `https://<domain>/api` |
| `NEXT_PUBLIC_WS_URL` | `wss://<domain>/ws/live` |
| `SCAN_CIDRS` | Comma-separated CIDRs for network discovery |

Generate secrets quickly:
```bash
openssl rand -hex 32   # run twice — one for JWT_SECRET, one for AGENT_JWT_SECRET
```

---

## 2. Start the stack

```bash
docker compose up -d
```

The stack starts:
- **TimescaleDB** on internal port 5432 (migrations run automatically on first start)
- **Server** (Fastify API + WebSocket) on internal port 4000
- **Web** (Next.js dashboard) on internal port 3000
- **Caddy** (reverse proxy + automatic TLS) on ports 80/443

Check everything is healthy:
```bash
docker compose ps
docker compose logs -f server
```

---

## 3. First admin login

Open `https://<your-domain>` in your browser. You'll be redirected to the login page.

The default admin account is seeded by `db/migrations/003_seed.sql`:

- **Email:** `admin@wms.local`
- **Password:** `changeme123`

**Change the password immediately** after first login via **Settings → Change Password**.

---

## 4. Create additional users

In the web UI: **Settings → Users → Add user**

- **Admin** — full access: can create/delete users, run network scans, enroll/revoke agents, view audit log
- **Viewer** — read-only access to all dashboards and alerts

Or via the API:
```bash
curl -s -X POST https://<domain>/api/auth/users \
  -H "Cookie: wms_token=<your-admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"email":"ops@example.com","password":"SecurePass1!","role":"viewer"}'
```

---

## 5. Enroll a workstation agent

### Generate an enrollment token

In the web UI: **Network → Discover & Enroll → Generate Token**

Or via the API:
```bash
curl -s -X POST https://<domain>/api/enroll/token \
  -H "Cookie: wms_token=<your-admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"hostname":"my-workstation","dept":"Engineering"}' | jq .
```

The response includes ready-to-run install commands for Linux, macOS, and Windows.

### Install the agent

**Linux (systemd) and macOS (launchd):**
```bash
# Copy the install command from the UI — it looks like:
curl -fsSL https://<domain>/q/<token> | sudo bash
```

The same script serves both platforms and auto-detects the OS and architecture.
To keep the token out of the URL, pass it through the environment instead
(`-E` preserves it through `sudo`):

```bash
export WMS_ENROLL_TOKEN=<token>
curl -fsSL https://<domain>/install/linux | sudo -E bash
```

**Windows (PowerShell as Administrator):**
```powershell
.\agent\install\windows\install.ps1 `
  -WmsServerUrl "wss://<domain>/ws/agent" `
  -WmsEnrollToken "<token>"
```

The agent will:
1. Exchange the enrollment token for a permanent per-agent JWT
2. Persist credentials to `/etc/wms-agent/state.json` (Linux/macOS) or `%PROGRAMDATA%\wms-agent\state.json` (Windows)
3. Register as a system service and start sending metrics every 10 seconds

---

## 6. Network discovery scan

In the UI: **Network → Run Scan**

Or via the API:
```bash
curl -X POST https://<domain>/api/discover \
  -H "Cookie: wms_token=<admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"cidrs": ["192.168.1.0/24"]}'
```

Discovered hosts appear under the **Discovered Hosts** tab. Click **Enroll** on any host to generate an install command for it.

---

## 7. Alert thresholds

Alerts are evaluated automatically by the server every minute (configurable via `ALERT_INTERVAL_MS`).

Default rules:

| Metric | Condition | Severity |
|---|---|---|
| CPU Load | > 95% sustained 5 min | Critical |
| RAM Usage | > 90% sustained 10 min | Critical |
| Disk Capacity | > 85% | Warning |
| CPU Temperature | > 85 °C | Critical |
| GPU Temperature | > 80 °C | Warning |
| Internet Downlink | < 30 Mbps | Warning |
| Agent Heartbeat | No signal > 5 min | Critical |

Active alerts are shown on the **Alerts Center** page. Acknowledge alerts in bulk. Alerts auto-resolve when the condition clears.

---

## 8. Updating

```bash
git pull
docker compose build --no-cache
docker compose up -d
```

Migrations run automatically on server startup — new migrations are applied, existing ones are skipped.

---

## 9. Revoking an agent

In the UI: **Network → Enrolled → Revoke**

This marks the workstation offline and invalidates its agent JWT. The agent will stop reporting immediately on next reconnect.

---

## 10. Security notes

- All cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` in production
- Agent JWTs are separate from user JWTs (different `AGENT_JWT_SECRET`)
- Caddy automatically provisions a Let's Encrypt TLS certificate for real domains; uses a self-signed cert for `localhost`
- All admin actions (login, user creation/deletion, ack, token generation) are written to the audit log — visible at **Settings → Audit Log**
- The database is not exposed outside the Docker network

---

## 11. Troubleshooting

```bash
# Check all service health
docker compose ps

# Server logs (includes alert engine + WS events)
docker compose logs -f server

# Migration errors
docker compose logs server | grep -i migrat

# Caddy TLS errors
docker compose logs caddy

# Reset everything (WARNING: deletes all data)
docker compose down -v
docker compose up -d
```
