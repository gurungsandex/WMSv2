// Central config from environment variables — no secrets in code
export const config = {
  port:       parseInt(process.env.PORT ?? "4000"),
  host:       process.env.HOST ?? "0.0.0.0",

  db: {
    url: process.env.DATABASE_URL ?? "postgresql://wms:wms@localhost:5432/wms",
  },

  jwt: {
    secret:     process.env.JWT_SECRET ?? "CHANGE_ME_IN_PRODUCTION_min32chars!!",
    expiresSec: parseInt(process.env.JWT_EXPIRES_SEC ?? String(60 * 60 * 24 * 7)), // 7 days
  },

  agentJwt: {
    secret: process.env.AGENT_JWT_SECRET ?? "CHANGE_ME_AGENT_SECRET_min32chars!!",
  },

  cors: {
    origin: process.env.CORS_ORIGIN ?? "http://localhost:3000",
  },

  scan: {
    // Comma-separated CIDR ranges to scan. e.g. "192.168.1.0/24,10.0.0.0/24"
    cidrs:        (process.env.SCAN_CIDRS ?? "192.168.1.0/24").split(",").map(s => s.trim()),
    timeoutMs:    parseInt(process.env.SCAN_TIMEOUT_MS ?? "1500"),
    concurrency:  parseInt(process.env.SCAN_CONCURRENCY ?? "50"),
  },

  alerts: {
    // Evaluation interval in ms
    intervalMs: parseInt(process.env.ALERT_INTERVAL_MS ?? "15000"),
  },

  events: {
    // How long endpoint activity events are kept before being pruned.
    retentionDays: parseInt(process.env.EVENT_RETENTION_DAYS ?? "30"),
  },
};
