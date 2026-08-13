import type { FastifyInstance } from "fastify";
import { randomBytes } from "crypto";
import bcrypt from "bcrypt";
import { query, queryOne } from "../db";
import { requireAdmin, requireAuth } from "../auth/middleware";
import type { JwtPayload, AgentJwtPayload } from "../auth/middleware";
import { config } from "../config";

// Generate a cryptographically random token
function genToken(bytes = 24): string {
  return randomBytes(bytes).toString("hex");
}

export async function enrollmentRoutes(app: FastifyInstance) {
  // POST /api/enroll/token  — admin generates an enrollment token for a workstation
  // Body: { hostname?, ip?, dept?, owner? }
  app.post<{ Body: { hostname?: string; ip?: string; dept?: string; owner?: string } }>(
    "/api/enroll/token",
    { preHandler: [requireAdmin] },
    async (req, reply) => {
      const me = req.user as JwtPayload;
      const { hostname = "unknown", ip, dept, owner } = req.body;

      const token = genToken();

      const [ws] = await query<{ id: string; enrollment_token: string }>(
        `INSERT INTO workstations (hostname, ip, dept, owner_name, enrollment_token, status)
         VALUES ($1, $2, $3, $4, $5, 'offline')
         RETURNING id, enrollment_token`,
        [hostname, ip ?? null, dept ?? null, owner ?? null, token]
      );

      await query(
        "INSERT INTO audit_log (user_id, action, entity_type, entity_id, metadata) VALUES ($1, 'generate_token', 'workstation', $2, $3)",
        [me.sub, ws.id, JSON.stringify({ hostname, ip, dept })]
      );

      // Build install instructions.
      // Use req.headers.host (includes port) to avoid doubling the port when
      // req.hostname already contains it (e.g. "localhost:4000" → "localhost:4000:4000").
      const host       = req.headers["host"] ?? `localhost:${config.port}`;
      const serverBase = `${req.protocol}://${host}`;

      return {
        workstation_id:   ws.id,
        enrollment_token: token,
        install: {
          macos:   `curl -fsSL ${serverBase}/q/${token} | sudo bash`,
          linux:   `curl -fsSL ${serverBase}/q/${token} | sudo bash`,
          windows: `iex (irm ${serverBase}/q/${token}/windows)`,
          url:     `${serverBase}/q/${token}`,
        },
      };
    }
  );

  // POST /api/enroll/register  — called by the agent on first boot with enrollment token
  // This exchanges the one-time token for a long-lived agent credential
  app.post<{
    Body: {
      enrollment_token: string;
      hostname: string;
      os_name: string;
      os_short: string;
      os_family: string;
      cpu_model: string;
      cpu_cores: number;
      ram_total_gb: number;
      agent_version: string;
    };
  }>("/api/enroll/register", async (req, reply) => {
    const { enrollment_token, hostname, os_name, os_short, os_family,
            cpu_model, cpu_cores, ram_total_gb, agent_version } = req.body;

    const ws = await queryOne<{ id: string; enrollment_token: string; agent_secret_hash: string }>(
      "SELECT id, enrollment_token, agent_secret_hash FROM workstations WHERE enrollment_token = $1",
      [enrollment_token]
    );
    if (!ws) return reply.code(400).send({ error: "Invalid or expired enrollment token" });
    if (ws.agent_secret_hash) return reply.code(400).send({ error: "Token already used" });

    // Generate a long-lived secret for this agent
    const agentSecret = genToken(32);
    const secretHash  = await bcrypt.hash(agentSecret, 10);

    await query(
      `UPDATE workstations SET
        hostname = $1, os_name = $2, os_short = $3, os_family = $4,
        cpu_model = $5, cpu_cores = $6, ram_total_gb = $7,
        agent_secret_hash = $8, agent_version = $9,
        enrolled_at = NOW(), last_seen_at = NOW(), status = 'offline'
       WHERE id = $10`,
      [hostname, os_name, os_short, os_family, cpu_model, cpu_cores, ram_total_gb,
       secretHash, agent_version, ws.id]
    );

    // Issue a long-lived agent JWT, signed with the dedicated agent secret so
    // it can never be presented as a user token.
    const payload: AgentJwtPayload = { sub: ws.id, type: "agent" };
    const agentJwt = app.jwt.agent.sign(payload);

    return {
      workstation_id: ws.id,
      agent_token:    agentJwt,
      agent_secret:   agentSecret,
    };
  });

  // DELETE /api/enroll/:id  — unenroll a workstation
  app.delete<{ Params: { id: string } }>(
    "/api/enroll/:id",
    { preHandler: [requireAdmin] },
    async (req, reply) => {
      const me = req.user as JwtPayload;
      await query(
        "UPDATE workstations SET agent_secret_hash = NULL, enrollment_token = NULL WHERE id = $1",
        [req.params.id]
      );
      await query(
        "INSERT INTO audit_log (user_id, action, entity_type, entity_id) VALUES ($1, 'unenroll', 'workstation', $2)",
        [me.sub, req.params.id]
      );
      return { ok: true };
    }
  );

  // GET /api/enroll/list  — list all workstations with enrollment status
  app.get("/api/enroll/list", { preHandler: [requireAuth] }, async () => {
    return query(
      `SELECT id, hostname, ip, mac, dept, owner_name, os_family, status,
              enrolled_at, last_seen_at, agent_version,
              CASE WHEN agent_secret_hash IS NOT NULL THEN true ELSE false END AS is_enrolled
       FROM workstations ORDER BY hostname`
    );
  });
}
