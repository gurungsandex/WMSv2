import type { FastifyInstance } from "fastify";
import { query } from "../db";
import { requireAuth, requireAdmin } from "../auth/middleware";
import type { JwtPayload } from "../auth/middleware";
import { audit } from "../services/audit";
import {
  COLLECTORS, effectivePolicyFor, pushPolicy, pushPolicyToAll,
} from "../services/policy";

export async function policyRoutes(app: FastifyInstance) {
  // GET /api/policy/collectors — fleet defaults + per-host overrides (read-only)
  app.get("/api/policy/collectors", { preHandler: [requireAuth] }, async () => {
    const rows = await query(
      `SELECT cp.workstation_id, cp.collector, cp.enabled, cp.interval_sec,
              cp.updated_at, w.hostname
         FROM collector_policy cp
         LEFT JOIN workstations w ON w.id = cp.workstation_id
        ORDER BY cp.workstation_id NULLS FIRST, cp.collector`
    );

    // How many enrolled agents actually advertise each collector — an admin
    // toggling something on wants to know how many hosts can honour it.
    const support = await query<{ collector: string; count: string }>(
      `SELECT c.collector, COUNT(*) AS count
         FROM workstations w
         CROSS JOIN LATERAL jsonb_array_elements_text(
           COALESCE(w.agent_capabilities, '[]'::jsonb)
         ) AS c(collector)
        WHERE w.enrolled_at IS NOT NULL
        GROUP BY c.collector`
    );

    return {
      collectors: COLLECTORS,
      rows,
      capableHosts: Object.fromEntries(support.map((s) => [s.collector, parseInt(s.count)])),
    };
  });

  // GET /api/policy/collectors/:id — effective policy for one workstation
  app.get<{ Params: { id: string } }>(
    "/api/policy/collectors/:id",
    { preHandler: [requireAuth] },
    async (req) => {
      const [ws] = await query<{ agent_capabilities: string[] | null }>(
        "SELECT agent_capabilities FROM workstations WHERE id = $1",
        [req.params.id]
      );
      return {
        effective:    await effectivePolicyFor(req.params.id),
        capabilities: Array.isArray(ws?.agent_capabilities) ? ws.agent_capabilities : [],
      };
    }
  );

  // PUT /api/policy/collectors — admin sets a fleet default or host override
  //
  // Body: { collector, enabled, interval_sec?, workstation_id? }
  // workstation_id omitted / null → fleet-wide default.
  app.put<{
    Body: {
      collector:       string;
      enabled:         boolean;
      interval_sec?:   number;
      workstation_id?: string | null;
    };
  }>(
    "/api/policy/collectors",
    { preHandler: [requireAdmin] },
    async (req, reply) => {
      const me = req.user as JwtPayload;
      const { collector, enabled, interval_sec = 60, workstation_id = null } = req.body;

      if (!(COLLECTORS as readonly string[]).includes(collector)) {
        return reply.code(400).send({ error: `Unknown collector: ${collector}` });
      }
      if (typeof enabled !== "boolean") {
        return reply.code(400).send({ error: "enabled must be a boolean" });
      }
      if (interval_sec < 15 || interval_sec > 3600) {
        return reply.code(400).send({ error: "interval_sec must be between 15 and 3600" });
      }

      if (workstation_id) {
        const [ws] = await query<{ id: string }>(
          "SELECT id FROM workstations WHERE id = $1", [workstation_id]
        );
        if (!ws) return reply.code(404).send({ error: "Workstation not found" });

        await query(
          `INSERT INTO collector_policy (workstation_id, collector, enabled, interval_sec, updated_by, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW())
           ON CONFLICT (workstation_id, collector) WHERE workstation_id IS NOT NULL
           DO UPDATE SET enabled = EXCLUDED.enabled,
                         interval_sec = EXCLUDED.interval_sec,
                         updated_by = EXCLUDED.updated_by,
                         updated_at = NOW()`,
          [workstation_id, collector, enabled, interval_sec, me.sub]
        );
      } else {
        await query(
          `INSERT INTO collector_policy (workstation_id, collector, enabled, interval_sec, updated_by, updated_at)
           VALUES (NULL, $1, $2, $3, $4, NOW())
           ON CONFLICT (collector) WHERE workstation_id IS NULL
           DO UPDATE SET enabled = EXCLUDED.enabled,
                         interval_sec = EXCLUDED.interval_sec,
                         updated_by = EXCLUDED.updated_by,
                         updated_at = NOW()`,
          [collector, enabled, interval_sec, me.sub]
        );
      }

      await audit({
        userId:     me.sub,
        action:     enabled ? "enable_collector" : "disable_collector",
        entityType: "collector_policy",
        entityId:   workstation_id ?? "fleet",
        metadata:   { collector, enabled, interval_sec, workstation_id },
        ip:         req.ip,
      });

      // Apply immediately to connected agents.
      if (workstation_id) await pushPolicy(workstation_id);
      else                await pushPolicyToAll();

      return { ok: true };
    }
  );

  // DELETE /api/policy/collectors/:workstationId/:collector — drop a host
  // override so the host falls back to the fleet default.
  app.delete<{ Params: { workstationId: string; collector: string } }>(
    "/api/policy/collectors/:workstationId/:collector",
    { preHandler: [requireAdmin] },
    async (req) => {
      const me = req.user as JwtPayload;
      await query(
        "DELETE FROM collector_policy WHERE workstation_id = $1 AND collector = $2",
        [req.params.workstationId, req.params.collector]
      );
      await audit({
        userId:     me.sub,
        action:     "clear_collector_override",
        entityType: "collector_policy",
        entityId:   req.params.workstationId,
        metadata:   { collector: req.params.collector },
        ip:         req.ip,
      });
      await pushPolicy(req.params.workstationId);
      return { ok: true };
    }
  );
}
