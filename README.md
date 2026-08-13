# Workstation Monitoring System

A self-hosted, real-time fleet monitoring dashboard for tracking workstation health, performance metrics, alerts, and network discovery — all in one place.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org)
[![Go](https://img.shields.io/badge/Go-1.22-00ADD8)](https://go.dev)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED)](https://docs.docker.com/compose)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

> **Get started in 60 seconds:**
> ```bash
> git clone https://github.com/gurungsandex/Workstation-Monitoring-System.git
> cd Workstation-Monitoring-System
> cp .env.example .env   # edit secrets, then:
> docker compose up -d
> ```
> Open https://localhost — login: `admin@wms.local` / `changeme123`

---

## Overview

Workstation Monitoring System (WMS) is an open-source IT monitoring tool that gives you live visibility into every machine in your fleet. A lightweight Go agent runs on each workstation and streams CPU, RAM, disk, GPU, and network metrics over WebSocket to a central server. The Next.js dashboard visualizes everything in real time with animated charts, health scores, and a configurable alert engine.

**Key features:**

- **Real-time metrics** — CPU, RAM, disk, GPU, and network streamed live via WebSocket
- **Health scoring** — composite health score per workstation with drill-down factors
- **Alert engine** — configurable thresholds with auto-resolve and bulk acknowledge
- **Endpoint activity** — opt-in process inventory and listening-port visibility per host
- **Activity timeline** — new processes, ports opening/closing, and agent version drift
- **Network discovery** — CIDR scan to discover hosts; one-click agent enrollment
- **SSH push-deploy** — install the agent on a remote host directly from the admin UI
- **Role-based access** — admin (full) and viewer (read-only) roles
- **Audit log** — every admin action recorded
- **CSV / JSON export** — pull events, processes, ports, and alerts for investigation
- **Cross-platform agent** — Linux (systemd), macOS (launchd), Windows (PowerShell service)
- **Self-hosted & private** — your data never leaves your infrastructure

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (HTTPS)                     │
│              Next.js 14 dashboard + Recharts            │
└────────────────────────┬────────────────────────────────┘
                         │ REST + WebSocket (via Caddy)
┌────────────────────────▼────────────────────────────────┐
│           Fastify API server  (TypeScript/Node)         │
│   • REST routes: auth, enroll, workstations, alerts     │
│   • WebSocket hub: agent connections + browser fanout   │
│   • Alert engine: evaluates thresholds every N seconds  │
└────────────────────────┬────────────────────────────────┘
                         │ SQL (pg driver)
┌────────────────────────▼────────────────────────────────┐
│            TimescaleDB / PostgreSQL 15                  │
│   workstations, metrics, alerts, audit_log, users,      │
│   endpoint_events, host_processes, host_ports,          │
│   collector_policy                                      │
└─────────────────────────────────────────────────────────┘
                         ▲
       WebSocket /ws/agent│ (per enrolled workstation)
┌──────────────────────── ┤ ───────────────────────────── ┐
│    Go agent (wms-agent)  │                               │
│  gopsutil · 10s interval │  Linux / macOS / Windows      │
└──────────────────────────┘ ───────────────────────────── ┘
```

**Stack:**

| Layer | Technology |
|---|---|
| Dashboard | Next.js 14, React 18, Tailwind CSS, Recharts, Framer Motion |
| API server | Fastify (TypeScript), WebSocket, JWT auth |
| Agent | Go 1.22, gopsutil, gorilla/websocket |
| Database | TimescaleDB (PostgreSQL 15 + time-series extension) |
| Reverse proxy | Caddy 2 (automatic TLS) |
| Deployment | Docker Compose |

---

## Screenshots

> Coming soon — PRs adding screenshots are welcome!

---

## Quick Start (Docker)

### Prerequisites

- Docker 24+ and Docker Compose v2
- Ports 80 and 443 open

### 1. Clone and configure

```bash
git clone https://github.com/gurungsandex/Workstation-Monitoring-System.git
cd Workstation-Monitoring-System
cp .env.example .env
```

Edit `.env`:

```bash
# Generate strong secrets
openssl rand -hex 32   # use for JWT_SECRET
openssl rand -hex 32   # use for AGENT_JWT_SECRET
```

| Variable | Description |
|---|---|
| `DB_PASSWORD` | Strong postgres password |
| `JWT_SECRET` | 32+ char random string (user auth tokens) |
| `AGENT_JWT_SECRET` | 32+ char random string (agent auth tokens) |
| `CADDY_HOST` | Your domain (e.g. `monitor.example.com`) or `localhost` |
| `CORS_ORIGIN` | `https://<your-domain>` |
| `NEXT_PUBLIC_API_URL` | `https://<your-domain>/api` |
| `NEXT_PUBLIC_WS_URL` | `wss://<your-domain>/ws/live` |
| `SCAN_CIDRS` | Comma-separated CIDRs for network discovery |

### 2. Start the stack

```bash
docker compose up -d
```

Services started:
- **TimescaleDB** — metrics storage (migrations run automatically)
- **Server** — Fastify API + WebSocket hub
- **Web** — Next.js dashboard
- **Caddy** — reverse proxy with automatic TLS (Let's Encrypt for real domains, self-signed for `localhost`)

Check health:
```bash
docker compose ps
docker compose logs -f server
```

### 3. First login

Open `https://<your-domain>` and log in with the seeded admin account:

- **Email:** `admin@wms.local`
- **Password:** `changeme123`

**Change the password immediately** via Settings → Change Password.

---

## Installing the Agent

### Generate an enrollment token

In the UI: **Network → Discover & Enroll → Generate Token**, or via API:

```bash
curl -s -X POST https://<domain>/api/enroll/token \
  -H "Cookie: wms_token=<admin-jwt>" \
  -H "Content-Type: application/json" \
  -d '{"hostname":"my-workstation","dept":"Engineering"}' | jq .
```

The response includes ready-to-run one-liner install commands for all platforms.

### Linux (systemd) and macOS (launchd)

The simplest path embeds the token in the URL — this is exactly the command the
API returns and the admin UI shows:

```bash
curl -fsSL https://<domain>/q/<token> | sudo bash
```

The script detects the OS and architecture, downloads the matching binary, and
registers a systemd unit or launchd daemon.

If you would rather not put the token in a URL, use the token-less variant and
supply it through the environment (`-E` preserves it through `sudo`):

```bash
export WMS_ENROLL_TOKEN=<token>
curl -fsSL https://<domain>/install/linux | sudo -E bash
# or /install/macos — the script body is identical and auto-detects the OS
```

### Windows (PowerShell, run as Administrator)

```powershell
iex (irm https://<domain>/q/<token>/windows)
```

Or the token-less variant:

```powershell
$env:WMS_ENROLL_TOKEN = "<token>"
iex (irm https://<domain>/install/windows)
```

The agent will:
1. Exchange the enrollment token for a permanent per-agent JWT
2. Persist credentials to disk (`/etc/wms-agent/state.json` on Linux/macOS, `%PROGRAMDATA%\wms-agent\state.json` on Windows)
3. Register as a system service and start streaming metrics every 10 seconds

### SSH Push-Deploy (admin UI)

Alternatively, from the admin UI: **Network → Discovered Hosts → Push Deploy**. Enter the target IP and SSH credentials — WMS will SSH in and run the install script automatically.

---

## Alert Thresholds

Alerts are evaluated automatically by the server every minute (configurable via `ALERT_INTERVAL_MS`).

| Metric | Condition | Severity |
|---|---|---|
| CPU Load | > 95% sustained 5 min | Critical |
| RAM Usage | > 90% sustained 10 min | Critical |
| Disk Capacity | > 85% | Warning |
| CPU Temperature | > 85 °C | Critical |
| GPU Temperature | > 80 °C | Warning |
| Internet Downlink | < 30 Mbps | Warning |
| Agent Heartbeat | No signal > 5 min | Critical |

Alerts auto-resolve when the condition clears. Acknowledge alerts in bulk on the **Alerts Center** page.

---

## Endpoint Activity

Beyond resource metrics, the agent can report what is actually running on a workstation. Every collector is **off by default** and must be switched on by an admin under **Settings → Collectors**.

### Available collectors

| Collector | What it reports | Measured agent cost |
|---|---|---|
| **Process inventory** | Top processes by CPU, memory and I/O; an event when a new process appears | ~0.15 ms per process per sample (~15 ms on a 100-process host) |
| **Listening ports** | Listening TCP/UDP sockets attributed to the owning process; events when a port opens or closes | ~3 ms per sample; scales with open file descriptors |

At the default 60-second interval both collectors together stay well under 0.1% of one CPU core. Agent memory footprint is roughly 14 MB resident with both enabled.

### How it works

1. On connect, the agent sends a `hello` frame advertising which collectors its build supports.
2. The server replies with the collector policy that applies to that host — the fleet default, or a per-host override.
3. The agent runs only the collectors that are both **advertised** and **enabled**, on the interval the server specifies.
4. Changing a setting pushes the new policy to connected agents immediately; no restart or redeploy.

Collector state is per-workstation, so you can enable process inventory fleet-wide and switch it off for a single sensitive host, or the reverse.

### Where to see it

- **Workstations → (any host) → Endpoint activity** — top processes, listening ports, and a recent-activity feed, all updating live over the existing WebSocket.
- **Settings → Collectors** — enable/disable, set intervals, review per-host overrides, and download exports.

### Event types

| Kind | Severity | Meaning |
|---|---|---|
| `process_start` | info | A process appeared that was not in the previous sample |
| `port_opened` | warning | A new listening socket appeared |
| `port_closed` | info | A listening socket went away |
| `agent_version_changed` | warning | The agent reported a different version than last seen |
| `agent_reconnected` | info | The agent re-established its WebSocket |

Events are retained for 30 days (`EVENT_RETENTION_DAYS`). On TimescaleDB this is enforced by a retention policy; on vanilla PostgreSQL a pruning job runs every six hours.

### What this deliberately does not collect

This is a monitoring tool, not a surveillance tool. It does **not** capture keystrokes, screenshots, clipboard contents, browser history, webcam or microphone input, or the contents of any file.

Process **command-line arguments are deliberately excluded** — `argv` routinely contains passwords, tokens and document paths, which is user content. The agent records process name, executable path, owner and PID, which is enough to identify what is running.

### Data export

Download CSV or JSON from **Settings → Collectors → Export data**, or directly:

```
GET /api/export/events?format=csv
GET /api/export/processes?format=json&workstation_id=<uuid>
GET /api/export/ports?format=csv
GET /api/export/alerts?format=csv
```

### Older agents

Agents built before this feature send no `hello`, so the server records no capabilities for them and never requests a collector. They keep streaming metrics exactly as before — no upgrade required, nothing breaks.

---

## Network Discovery

Go to **Network → Run Scan** and enter a CIDR range (e.g. `192.168.1.0/24`). WMS performs a fast concurrent port scan and lists discovered hosts with IP, hostname, MAC address, and open ports. Click **Enroll** on any host to generate an install command.

---

## Local Development

### Prerequisites

- Node.js 20+
- Go 1.22+
- Docker (for TimescaleDB)

### Start the database

```bash
docker compose -f docker-compose.dev.yml up -d
```

### Start the API server

```bash
cd server
cp .env.example .env   # already done — edit DATABASE_URL if needed
npm install
npm run dev
```

### Start the Next.js frontend

```bash
npm install
npm run dev
```

Dashboard is available at `http://localhost:3000`. API runs at `http://localhost:4000`.

### Build the agent

```bash
cd agent
./build-all.sh   # cross-compiles for linux/amd64, linux/arm64, darwin/amd64, darwin/arm64, windows/amd64
```

Binaries are output to `server/binaries/`.

For Docker deployments this is not needed — `server/Dockerfile` cross-compiles the
agent binaries during the image build, so `/download/*` works out of the box.

### Run the tests

CI runs these on every push and pull request (`.github/workflows/ci.yml`).

```bash
# Web + agent
npm run typecheck && npm run lint && npm run build
cd agent && go build ./... && go vet ./...

# Server smoke test — point it at a running server backed by a throwaway database
cd server
DATABASE_URL=postgresql://wms:wms@localhost:5432/wms npm run migrate
DATABASE_URL=postgresql://wms:wms@localhost:5432/wms npm run dev &
API_URL=http://127.0.0.1:4000 JWT_SECRET=<same as the server> npm run test:smoke
```

The smoke test covers the auth boundary (including that agent credentials cannot
read fleet data), the agent protocol and its backwards compatibility, the
collectors, and the agent bootstrap endpoints. Passing `JWT_SECRET` enables the
legacy-token regression checks; without it those are skipped.

---

## Project Structure

```
.
├── agent/                  # Go agent (cross-platform)
│   ├── collector/          # gopsutil metrics + process/port collectors
│   ├── config/             # config + credential persistence
│   ├── transport/          # WebSocket client, enrollment, policy handling
│   ├── install/            # OS-specific install scripts
│   └── build-all.sh        # cross-compile script
├── app/                    # Next.js App Router pages
│   ├── workstations/       # Fleet list + detail views (incl. endpoint activity)
│   ├── alerts/             # Alert center
│   ├── network/            # Discovery + enrollment
│   ├── settings/           # Users, collectors, password, audit log
│   └── login/              # Auth page
├── components/             # Reusable React components
│   ├── activity/           # Process, port, and activity-feed panels
│   ├── charts/             # Animated charts (Gauge, Sparkline, LineChart…)
│   ├── dashboard/          # Dashboard cards
│   ├── network/            # Enroll modal
│   └── shell/              # Layout (sidebar, topbar)
├── db/migrations/          # SQL migrations (run in order on startup)
├── lib/                    # Shared frontend utilities + hooks
├── server/                 # Fastify API server
│   ├── src/
│   │   ├── routes/         # REST endpoints
│   │   ├── services/       # Alert engine, discovery, health scoring,
│   │   │                   #   collector policy, activity ingest, audit
│   │   ├── ws/             # WebSocket hub + handlers
│   │   └── auth/           # JWT middleware
│   └── scripts/migrate.js  # Migration runner
├── docker-compose.yml      # Production stack
├── docker-compose.dev.yml  # Local dev stack (DB only)
├── Dockerfile.web          # Next.js container
├── server/Dockerfile       # Fastify container
├── Caddyfile               # Reverse proxy + TLS config
└── .env.example            # Environment variable template
```

---

## Security

- All cookies are `HttpOnly`, `SameSite=Strict`, and `Secure` in production
- Agent JWTs are signed with `AGENT_JWT_SECRET`, separate from `JWT_SECRET`, and are
  rejected outright on every user-facing route — a stolen agent credential can submit
  that host's telemetry and nothing else
- In production the server refuses to start if either secret is missing, shorter than
  32 characters, still the built-in placeholder, or if the two match
- Caddy provisions Let's Encrypt certificates automatically for real domains
- All admin actions are written to the audit log (Settings → Audit Log), including enabling or disabling any collector
- The database is isolated inside the Docker network (not exposed externally)
- Enrollment tokens are one-time-use and exchange for a long-lived agent credential on first contact
- Endpoint collectors are off by default, admin-only to change, and never capture user content (see [Endpoint Activity](#endpoint-activity))

---

## Updating

```bash
git pull
docker compose build --no-cache
docker compose up -d
```

Migrations run automatically on server startup — new migrations are applied, existing ones skipped.

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

---

## License

MIT — see [LICENSE](LICENSE) for details.
