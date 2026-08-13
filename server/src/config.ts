// Central config from environment variables — no secrets in code

// Placeholder values that must never reach a real deployment. docker-compose
// already refuses to start without real secrets; this covers bare-metal runs
// (dev.sh, `npm start`) which previously fell back to a public constant.
const PLACEHOLDER_SECRETS = [
  "CHANGE_ME_IN_PRODUCTION_min32chars!!",
  "CHANGE_ME_AGENT_SECRET_min32chars!!",
];

export function assertProductionSecrets(): void {
  if (process.env.NODE_ENV !== "production") return;

  const offenders: string[] = [];
  for (const [name, value] of [
    ["JWT_SECRET", config.jwt.secret],
    ["AGENT_JWT_SECRET", config.agentJwt.secret],
  ] as const) {
    if (PLACEHOLDER_SECRETS.includes(value)) offenders.push(`${name} is still the built-in placeholder`);
    else if (value.length < 32)              offenders.push(`${name} is shorter than 32 characters`);
  }
  if (config.jwt.secret === config.agentJwt.secret) {
    offenders.push("JWT_SECRET and AGENT_JWT_SECRET must differ");
  }

  if (offenders.length > 0) {
    throw new Error(
      "Refusing to start in production with insecure secrets:\n  - " +
        offenders.join("\n  - ") +
        "\nGenerate each with: openssl rand -hex 32"
    );
  }
}

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
    // Agent tokens issued before agent JWTs got their own signing key were
    // signed with the *user* secret. Keep accepting them so already-deployed
    // agents survive the upgrade, then set this to "false" once the fleet has
    // re-enrolled. Such tokens are still barred from user-facing routes.
    allowLegacy: (process.env.ALLOW_LEGACY_AGENT_TOKENS ?? "true") !== "false",
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
