import { query } from "../db";
import { broadcast } from "../ws/hub";

// ── Payload shapes (mirror the agent's Go structs) ────────────────────────────

export interface ProcessInfo {
  pid:          number;
  name:         string;
  username?:    string;
  exe?:         string;
  cpu_pct?:     number;
  mem_pct?:     number;
  mem_rss_mb?:  number;
  io_read_mbs?: number;
  io_write_mbs?:number;
  started_at?:  number; // unix ms
}

export interface ProcessPayload {
  type:      "processes";
  processes: ProcessInfo[];
  total:     number;
  new?:      ProcessInfo[];
}

export interface PortInfo {
  proto:         string;
  laddr:         string;
  lport:         number;
  pid?:          number;
  process_name?: string;
}

export interface PortPayload {
  type:    "ports";
  ports:   PortInfo[];
  opened?: PortInfo[];
  closed?: PortInfo[];
}

// Bounds so a malformed or hostile agent payload cannot blow up the database.
const MAX_PROCESSES = 200;
const MAX_PORTS     = 500;
const MAX_EVENTS    = 50;

// ── Events ────────────────────────────────────────────────────────────────────

export async function recordEvent(
  workstationId: string,
  kind: string,
  subject: string,
  detail: Record<string, unknown> = {},
  severity: "info" | "warning" | "critical" = "info"
): Promise<void> {
  await query(
    `INSERT INTO endpoint_events (workstation_id, kind, severity, subject, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [workstationId, kind, severity, subject.slice(0, 200), JSON.stringify(detail)]
  );
  broadcast({
    type: "endpoint_event",
    workstation_id: workstationId,
    kind, severity, subject,
  });
}

// ── Process inventory ─────────────────────────────────────────────────────────

export async function ingestProcesses(
  workstationId: string,
  payload: ProcessPayload
): Promise<void> {
  const procs = (payload.processes ?? []).slice(0, MAX_PROCESSES);
  if (procs.length === 0) return;

  // Replace the host's inventory with this sample. host_processes is a
  // "current state" table, not a time series — history lives in endpoint_events.
  await query("DELETE FROM host_processes WHERE workstation_id = $1", [workstationId]);

  for (const p of procs) {
    await query(
      `INSERT INTO host_processes (
         workstation_id, pid, name, username, exe,
         cpu_pct, mem_pct, mem_rss_mb, io_read_mbs, io_write_mbs,
         started_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
       ON CONFLICT (workstation_id, pid) DO UPDATE SET
         name = EXCLUDED.name, username = EXCLUDED.username, exe = EXCLUDED.exe,
         cpu_pct = EXCLUDED.cpu_pct, mem_pct = EXCLUDED.mem_pct,
         mem_rss_mb = EXCLUDED.mem_rss_mb,
         io_read_mbs = EXCLUDED.io_read_mbs, io_write_mbs = EXCLUDED.io_write_mbs,
         updated_at = NOW()`,
      [
        workstationId, p.pid, (p.name ?? "").slice(0, 200),
        p.username ?? null, (p.exe ?? "").slice(0, 500) || null,
        p.cpu_pct ?? 0, p.mem_pct ?? 0, p.mem_rss_mb ?? 0,
        p.io_read_mbs ?? 0, p.io_write_mbs ?? 0,
        p.started_at ? new Date(p.started_at) : null,
      ]
    );
  }

  for (const p of (payload.new ?? []).slice(0, MAX_EVENTS)) {
    await recordEvent(workstationId, "process_start", p.name ?? "unknown", {
      pid: p.pid, username: p.username, exe: p.exe,
    });
  }

  broadcast({
    type: "processes_updated",
    workstation_id: workstationId,
    total: payload.total ?? procs.length,
  });
}

// ── Listening ports ───────────────────────────────────────────────────────────

export async function ingestPorts(
  workstationId: string,
  payload: PortPayload
): Promise<void> {
  const ports = (payload.ports ?? []).slice(0, MAX_PORTS);

  await query("DELETE FROM host_ports WHERE workstation_id = $1", [workstationId]);

  for (const p of ports) {
    await query(
      `INSERT INTO host_ports (workstation_id, proto, laddr, lport, pid, process_name, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6, NOW())
       ON CONFLICT (workstation_id, proto, laddr, lport) DO UPDATE SET
         pid = EXCLUDED.pid,
         process_name = EXCLUDED.process_name,
         updated_at = NOW()`,
      [
        workstationId, (p.proto ?? "tcp").slice(0, 8),
        (p.laddr ?? "").slice(0, 64), p.lport,
        p.pid ?? null, (p.process_name ?? "").slice(0, 200) || null,
      ]
    );
  }

  for (const p of (payload.opened ?? []).slice(0, MAX_EVENTS)) {
    await recordEvent(
      workstationId, "port_opened", `${p.proto}/${p.lport}`,
      { laddr: p.laddr, pid: p.pid, process_name: p.process_name },
      "warning" // a new listening socket is worth a second look
    );
  }
  for (const p of (payload.closed ?? []).slice(0, MAX_EVENTS)) {
    await recordEvent(
      workstationId, "port_closed", `${p.proto}/${p.lport}`,
      { laddr: p.laddr, pid: p.pid, process_name: p.process_name }
    );
  }

  broadcast({
    type: "ports_updated",
    workstation_id: workstationId,
    count: ports.length,
  });
}

// ── Retention ─────────────────────────────────────────────────────────────────

/**
 * Delete endpoint events older than the retention window.
 *
 * On TimescaleDB the retention policy from migration 004 already handles this;
 * this job is what keeps vanilla PostgreSQL from growing without bound. Running
 * both is harmless — whichever gets there first wins.
 */
export async function pruneEndpointEvents(retentionDays = 30): Promise<number> {
  const rows = await query<{ id: string }>(
    `DELETE FROM endpoint_events
      WHERE time < NOW() - ($1 || ' days')::INTERVAL
      RETURNING workstation_id AS id`,
    [String(retentionDays)]
  );
  return rows.length;
}
