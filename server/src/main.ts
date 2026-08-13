import Fastify from "fastify";
import fastifyJwt from "@fastify/jwt";
import fastifyCookie from "@fastify/cookie";
import fastifyCors from "@fastify/cors";
import fastifyWebsocket from "@fastify/websocket";
import fastifyRateLimit from "@fastify/rate-limit";
import fs from "fs";
import path from "path";
import { config, assertProductionSecrets } from "./config";
import { bashInstaller, powershellInstaller } from "./services/installer";
import { authRoutes } from "./routes/auth";
import { enrollmentRoutes } from "./routes/enrollment";
import { metricsRoutes } from "./routes/metrics";
import { workstationRoutes } from "./routes/workstations";
import { alertRoutes } from "./routes/alerts";
import { discoveryRoutes } from "./routes/discovery";
import { deployRoutes } from "./routes/deploy";
import { activityRoutes } from "./routes/activity";
import { policyRoutes } from "./routes/policy";
import { exportRoutes } from "./routes/export";
import { agentWsRoutes } from "./ws/agentHandler";
import { browserWsRoutes } from "./ws/browserHandler";
import { raiseHeartbeatAlert } from "./services/alertEngine";
import { pruneEndpointEvents } from "./services/activity";
import { query } from "./db";

const app = Fastify({ logger: { level: "info" } });

async function main() {
  // Refuse to start a production deployment with placeholder or shared secrets.
  assertProductionSecrets();

  // Plugins
  await app.register(fastifyCors, {
    origin: config.cors.origin,
    credentials: true,
  });

  await app.register(fastifyRateLimit, {
    max: parseInt(process.env.RATE_LIMIT_MAX ?? "600"),
    timeWindow: "1 minute",
  });

  await app.register(fastifyCookie);

  await app.register(fastifyJwt, {
    secret: config.jwt.secret,
    cookie: { cookieName: "wms_token", signed: false },
  });

  // Agent credentials are signed with their own secret, so a stolen agent
  // token is not a valid user token. Exposed as app.jwt.agent / agentJwtVerify.
  await app.register(fastifyJwt, {
    secret:    config.agentJwt.secret,
    namespace: "agent",
  });

  await app.register(fastifyWebsocket);

  // Routes (each route file declares full /api/... paths)
  await app.register(authRoutes);
  await app.register(enrollmentRoutes);
  await app.register(metricsRoutes);
  await app.register(workstationRoutes);
  await app.register(alertRoutes);
  await app.register(discoveryRoutes);
  await app.register(deployRoutes);
  await app.register(activityRoutes);
  await app.register(policyRoutes);
  await app.register(exportRoutes);

  // WebSocket routes
  await app.register(agentWsRoutes);
  await app.register(browserWsRoutes);

  // Health check
  app.get("/health", async () => ({ ok: true }));

  // ── Pre-built binary downloads ────────────────────────────────────────────
  const BINARIES_DIR = path.join(__dirname, "..", "binaries");

  app.get<{ Params: { file: string } }>("/download/:file", async (req, reply) => {
    const file = req.params.file.replace(/[^a-z0-9.\-_]/gi, "");
    const filePath = path.join(BINARIES_DIR, file);
    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: "Binary not found. Run: npm run build:agent" });
    }
    reply.header("Content-Disposition", `attachment; filename="${file}"`);
    reply.type("application/octet-stream");
    return reply.send(fs.createReadStream(filePath));
  });

  // ── Agent install scripts ─────────────────────────────────────────────────
  // Two delivery shapes, one script body (see services/installer.ts):
  //   /q/:token     token embedded in the URL (copy-paste from the admin UI)
  //   /install/:os  token read from WMS_ENROLL_TOKEN (SSH push-deploy)
  const installerUrls = (req: { protocol: string; headers: Record<string, unknown> }) => {
    const host = (req.headers["host"] as string) ?? `localhost:${config.port}`;
    const serverBase = `${req.protocol}://${host}`;
    return { serverBase, wsUrl: serverBase.replace(/^http/, "ws") + "/ws/agent" };
  };

  app.get<{ Params: { token: string } }>("/q/:token", async (req, reply) => {
    const token = req.params.token.replace(/[^a-f0-9]/gi, "");
    reply.type("text/plain");
    return bashInstaller({ token, ...installerUrls(req) });
  });

  app.get<{ Params: { token: string } }>("/q/:token/windows", async (req, reply) => {
    const token = req.params.token.replace(/[^a-f0-9]/gi, "");
    reply.type("text/plain");
    return powershellInstaller({ token, ...installerUrls(req) });
  });

  // Token-less variants: the caller exports WMS_ENROLL_TOKEN and pipes through
  // `sudo -E bash`. This is what routes/deploy.ts invokes over SSH.
  // A trailing ".sh" is accepted so documented URLs work either way.
  app.get<{ Params: { os: string } }>("/install/:os", async (req, reply) => {
    const os = req.params.os.toLowerCase().replace(/\.(sh|ps1)$/, "");
    reply.type("text/plain");
    if (os === "windows") {
      return powershellInstaller({ token: null, ...installerUrls(req) });
    }
    if (os === "linux" || os === "macos" || os === "darwin") {
      return bashInstaller({ token: null, ...installerUrls(req) });
    }
    return reply.code(404).send("Unknown platform. Use linux, macos, or windows.");
  });

  // Start heartbeat watchdog
  startHeartbeatWatchdog();

  // Start endpoint-event retention job
  startEventPruner();

  await app.listen({ port: config.port, host: "0.0.0.0" });
  app.log.info(`Server listening on port ${config.port}`);
}

// Detect agents that haven't sent a metric in >5 minutes
function startHeartbeatWatchdog() {
  setInterval(async () => {
    try {
      const stale = await query<{ id: string }>(
        `SELECT id FROM workstations
         WHERE status != 'offline'
           AND last_seen_at < NOW() - INTERVAL '5 minutes'`
      );
      for (const ws of stale) {
        await raiseHeartbeatAlert(ws.id);
      }
    } catch (err) {
      app.log.error({ err }, "Heartbeat watchdog error");
    }
  }, config.alerts.intervalMs);
}

// Trim endpoint_events beyond the retention window.
//
// TimescaleDB applies its own retention policy from migration 004; this job is
// what keeps vanilla PostgreSQL bounded. Running both is harmless.
function startEventPruner() {
  const run = async () => {
    try {
      const removed = await pruneEndpointEvents(config.events.retentionDays);
      if (removed > 0) {
        app.log.info({ removed }, "Pruned endpoint events past retention");
      }
    } catch (err) {
      app.log.error({ err }, "Endpoint event pruner error");
    }
  };
  run();
  setInterval(run, 6 * 60 * 60 * 1000); // every 6 hours
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
