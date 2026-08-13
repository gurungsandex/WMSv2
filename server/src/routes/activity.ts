import type { FastifyInstance } from "fastify";
import { query } from "../db";
import { requireAuth } from "../auth/middleware";

export async function activityRoutes(app: FastifyInstance) {
  // GET /api/activity/:id/processes — current process inventory for one host
  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>(
    "/api/activity/:id/processes",
    { preHandler: [requireAuth] },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? "25"), 200);
      const rows = await query(
        `SELECT pid, name, username, exe,
                cpu_pct, mem_pct, mem_rss_mb,
                io_read_mbs, io_write_mbs,
                started_at, updated_at
           FROM host_processes
          WHERE workstation_id = $1
          ORDER BY cpu_pct DESC, mem_rss_mb DESC
          LIMIT $2`,
        [req.params.id, limit]
      );
      return rows;
    }
  );

  // GET /api/activity/:id/ports — current listening sockets for one host
  app.get<{ Params: { id: string } }>(
    "/api/activity/:id/ports",
    { preHandler: [requireAuth] },
    async (req) => {
      return query(
        `SELECT proto, laddr, lport, pid, process_name, updated_at
           FROM host_ports
          WHERE workstation_id = $1
          ORDER BY lport ASC`,
        [req.params.id]
      );
    }
  );

  // GET /api/activity/:id/events — recent activity for one host
  app.get<{ Params: { id: string }; Querystring: { limit?: string; kind?: string } }>(
    "/api/activity/:id/events",
    { preHandler: [requireAuth] },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? "50"), 500);
      const params: unknown[] = [req.params.id];
      let where = "workstation_id = $1";
      if (req.query.kind) {
        params.push(req.query.kind);
        where += ` AND kind = $${params.length}`;
      }
      params.push(limit);
      return query(
        `SELECT time, kind, severity, subject, detail
           FROM endpoint_events
          WHERE ${where}
          ORDER BY time DESC
          LIMIT $${params.length}`,
        params
      );
    }
  );

  // GET /api/activity/events — fleet-wide recent activity
  app.get<{ Querystring: { limit?: string; kind?: string; severity?: string } }>(
    "/api/activity/events",
    { preHandler: [requireAuth] },
    async (req) => {
      const limit = Math.min(parseInt(req.query.limit ?? "100"), 500);
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (req.query.kind) {
        params.push(req.query.kind);
        conditions.push(`e.kind = $${params.length}`);
      }
      if (req.query.severity && req.query.severity !== "all") {
        params.push(req.query.severity);
        conditions.push(`e.severity = $${params.length}`);
      }

      const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(limit);

      return query(
        `SELECT e.time, e.kind, e.severity, e.subject, e.detail,
                e.workstation_id, w.hostname
           FROM endpoint_events e
           JOIN workstations w ON w.id = e.workstation_id
           ${where}
          ORDER BY e.time DESC
          LIMIT $${params.length}`,
        params
      );
    }
  );
}
