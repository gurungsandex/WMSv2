import type { FastifyInstance } from "fastify";
import { query } from "../db";
import { broadcast } from "../ws/hub";
import { evaluateAlerts } from "../services/alertEngine";
import { computeHealthScore } from "../services/healthScore";
import { requireAuth } from "../auth/middleware";
import { verifyAgentToken } from "../auth/agentToken";

export interface MetricPayload {
  workstation_id: string;
  // CPU
  cpu_usage:    number;
  cpu_temp:     number;
  cpu_per_core: number[];
  // RAM
  ram_used_pct: number;
  // Disk
  disk_used_pct:  number;
  disk_read_mbs:  number;
  disk_write_mbs: number;
  // GPU
  gpu_load: number;
  gpu_temp: number;
  // Network
  net_eth_in:    number;
  net_eth_out:   number;
  net_down_mbps: number;
  net_up_mbps:   number;
  // System
  uptime_sec:   number;
}

export async function metricsRoutes(app: FastifyInstance) {
  // POST /api/metrics  — agent posts a metric batch (REST fallback from WS)
  app.post<{ Body: MetricPayload }>(
    "/api/metrics",
    async (req, reply) => {
      // Auth: bearer token from agent
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) return reply.code(401).send({ error: "Unauthorized" });

      const verified = verifyAgentToken(app, authHeader.slice(7));
      if (!verified) return reply.code(401).send({ error: "Invalid agent token" });

      await ingestMetric(verified.workstationId, req.body);
      return { ok: true };
    }
  );

  // GET /api/metrics/:id/history  — 24h history in 30-min buckets
  app.get<{ Params: { id: string }; Querystring: { hours?: string } }>(
    "/api/metrics/:id/history",
    { preHandler: [requireAuth] },
    async (req) => {
      const hours = Math.min(parseInt(req.query.hours ?? "24"), 168);
      return query(
        `SELECT bucket as time, avg_cpu, avg_ram, avg_disk, avg_gpu,
                avg_net_in, avg_net_out, avg_net_down, avg_net_up,
                avg_cpu_temp, avg_gpu_temp, avg_disk_read, avg_disk_write
         FROM metrics_30m
         WHERE workstation_id = $1 AND bucket > NOW() - INTERVAL '${hours} hours'
         ORDER BY bucket ASC`,
        [req.params.id]
      );
    }
  );

  // GET /api/metrics/fleet/history  — fleet-average 24h in 30-min buckets
  app.get<{ Querystring: { hours?: string } }>(
    "/api/metrics/fleet/history",
    { preHandler: [requireAuth] },
    async (req) => {
      const hours = Math.min(parseInt(req.query.hours ?? "24"), 168);
      return query(
        `SELECT bucket as time,
                AVG(avg_cpu)  AS avg_cpu,
                AVG(avg_ram)  AS avg_ram,
                AVG(avg_disk) AS avg_disk
         FROM metrics_30m
         WHERE bucket > NOW() - INTERVAL '${hours} hours'
         GROUP BY bucket ORDER BY bucket ASC`,
        []
      );
    }
  );
}

// Shared ingest logic (called from both REST endpoint + WS handler)
export async function ingestMetric(workstationId: string, m: MetricPayload): Promise<void> {
  // 1. Insert raw metric
  await query(
    `INSERT INTO metrics (
       time, workstation_id,
       cpu_usage, cpu_temp, cpu_per_core,
       ram_used_pct,
       disk_used_pct, disk_read_mbs, disk_write_mbs,
       gpu_load, gpu_temp,
       net_eth_in, net_eth_out, net_down_mbps, net_up_mbps,
       uptime_sec
     ) VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
    [
      workstationId,
      m.cpu_usage, m.cpu_temp, JSON.stringify(m.cpu_per_core),
      m.ram_used_pct,
      m.disk_used_pct, m.disk_read_mbs, m.disk_write_mbs,
      m.gpu_load, m.gpu_temp,
      m.net_eth_in, m.net_eth_out, m.net_down_mbps, m.net_up_mbps,
      m.uptime_sec,
    ]
  );

  // 2. Compute health score
  const { score, factors, status } = computeHealthScore(m);

  // 3. Update snapshot + status on workstation row
  await query(
    `UPDATE workstations SET
       last_seen_at      = NOW(),
       status            = $2,
       health_score      = $3,
       health_factors    = $4,
       uptime_sec        = $5,
       snap_cpu_usage    = $6,  snap_cpu_temp     = $7,
       snap_ram_used_pct = $8,
       snap_disk_used_pct= $9,  snap_disk_read_mbs= $10, snap_disk_write_mbs = $11,
       snap_gpu_load     = $12, snap_gpu_temp      = $13,
       snap_net_eth_in   = $14, snap_net_eth_out   = $15,
       snap_net_down_mbps= $16, snap_net_up_mbps   = $17
     WHERE id = $1`,
    [
      workstationId, status, score, JSON.stringify(factors), m.uptime_sec,
      m.cpu_usage, m.cpu_temp,
      m.ram_used_pct,
      m.disk_used_pct, m.disk_read_mbs, m.disk_write_mbs,
      m.gpu_load, m.gpu_temp,
      m.net_eth_in, m.net_eth_out, m.net_down_mbps, m.net_up_mbps,
    ]
  );

  // 4. Alert evaluation
  await evaluateAlerts(workstationId, m, score);

  // 5. Broadcast live update to browser WebSocket subscribers
  broadcast({ type: "metric", workstation_id: workstationId, data: m, status, score, factors });
}
