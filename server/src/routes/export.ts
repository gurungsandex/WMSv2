import type { FastifyInstance } from "fastify";
import { query } from "../db";
import { requireAuth } from "../auth/middleware";

/** Render rows as CSV, quoting defensively. */
function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const headers = Object.keys(rows[0]);

  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    // Prefix formula-leading characters so spreadsheet apps treat the value as
    // text rather than executing it.
    const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  };

  return [
    headers.join(","),
    ...rows.map((r) => headers.map((h) => cell(r[h])).join(",")),
  ].join("\n");
}

const DATASETS: Record<string, { sql: string; params: (id?: string) => unknown[] }> = {
  events: {
    sql: `SELECT e.time, w.hostname, e.kind, e.severity, e.subject, e.detail
            FROM endpoint_events e
            JOIN workstations w ON w.id = e.workstation_id
           WHERE ($1::uuid IS NULL OR e.workstation_id = $1::uuid)
           ORDER BY e.time DESC LIMIT 10000`,
    params: (id) => [id ?? null],
  },
  processes: {
    sql: `SELECT w.hostname, p.pid, p.name, p.username, p.exe,
                 p.cpu_pct, p.mem_pct, p.mem_rss_mb,
                 p.io_read_mbs, p.io_write_mbs, p.updated_at
            FROM host_processes p
            JOIN workstations w ON w.id = p.workstation_id
           WHERE ($1::uuid IS NULL OR p.workstation_id = $1::uuid)
           ORDER BY w.hostname, p.cpu_pct DESC LIMIT 10000`,
    params: (id) => [id ?? null],
  },
  ports: {
    sql: `SELECT w.hostname, p.proto, p.laddr, p.lport, p.pid, p.process_name, p.updated_at
            FROM host_ports p
            JOIN workstations w ON w.id = p.workstation_id
           WHERE ($1::uuid IS NULL OR p.workstation_id = $1::uuid)
           ORDER BY w.hostname, p.lport LIMIT 10000`,
    params: (id) => [id ?? null],
  },
  alerts: {
    sql: `SELECT a.started_at, a.resolved_at, w.hostname, a.metric, a.value,
                 a.threshold, a.severity, a.is_resolved, a.is_ack, a.ack_by
            FROM alerts a
            JOIN workstations w ON w.id = a.workstation_id
           WHERE ($1::uuid IS NULL OR a.workstation_id = $1::uuid)
           ORDER BY a.started_at DESC LIMIT 10000`,
    params: (id) => [id ?? null],
  },
};

export async function exportRoutes(app: FastifyInstance) {
  // GET /api/export/:dataset?format=csv|json&workstation_id=<uuid>
  app.get<{
    Params: { dataset: string };
    Querystring: { format?: string; workstation_id?: string };
  }>(
    "/api/export/:dataset",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const spec = DATASETS[req.params.dataset];
      if (!spec) {
        return reply.code(404).send({
          error: `Unknown dataset. Available: ${Object.keys(DATASETS).join(", ")}`,
        });
      }

      const rows = await query<Record<string, unknown>>(
        spec.sql,
        spec.params(req.query.workstation_id)
      );

      const stamp = new Date().toISOString().slice(0, 10);
      const name  = `wms-${req.params.dataset}-${stamp}`;

      if ((req.query.format ?? "csv") === "json") {
        reply.header("Content-Disposition", `attachment; filename="${name}.json"`);
        reply.type("application/json");
        return rows;
      }

      reply.header("Content-Disposition", `attachment; filename="${name}.csv"`);
      reply.type("text/csv; charset=utf-8");
      return toCsv(rows);
    }
  );
}
