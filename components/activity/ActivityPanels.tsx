"use client";
import { useCallback, useEffect, useState } from "react";
import {
  activity, policy, exportUrl,
  type ProcessRow, type PortRow, type EventRow,
} from "@/lib/api";
import { useLive } from "@/lib/LiveContext";

function relTime(iso?: string | null) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

const TH: React.CSSProperties = {
  padding: "7px 12px", textAlign: "left", color: "var(--text-dim)",
  fontWeight: 500, fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.06em",
};
const TD: React.CSSProperties = { padding: "7px 12px", fontSize: 12, color: "var(--text)" };

/** Shown when a collector is off, or the agent is too old to support it. */
function CollectorOff({ label, capable }: { label: string; capable: boolean }) {
  return (
    <div style={{ padding: "22px 14px", fontSize: 12.5, color: "var(--text-dim)", lineHeight: 1.6 }}>
      {capable ? (
        <>
          <span style={{ color: "var(--text)" }}>{label} collection is off.</span>
          <br />
          An admin can enable it under <strong>Settings → Collectors</strong>.
        </>
      ) : (
        <>
          <span style={{ color: "var(--text)" }}>This agent does not support {label.toLowerCase()} collection.</span>
          <br />
          Upgrade the agent on this host to enable it.
        </>
      )}
    </div>
  );
}

export function ActivityPanels({ workstationId }: { workstationId: string }) {
  const { activityTick } = useLive();
  const tick = activityTick[workstationId] ?? 0;

  const [caps, setCaps]   = useState<string[]>([]);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [procs, setProcs] = useState<ProcessRow[]>([]);
  const [ports, setPorts] = useState<PortRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);

  const loadPolicy = useCallback(async () => {
    try {
      const p = await policy.forHost(workstationId);
      setCaps(p.capabilities);
      setEnabled(
        Object.fromEntries(Object.entries(p.effective).map(([k, v]) => [k, v.enabled]))
      );
    } catch {
      setCaps([]); setEnabled({});
    }
  }, [workstationId]);

  const loadData = useCallback(async () => {
    try {
      const [pr, po, ev] = await Promise.all([
        activity.processes(workstationId, 15).catch(() => []),
        activity.ports(workstationId).catch(() => []),
        activity.events(workstationId, 40).catch(() => []),
      ]);
      setProcs(pr); setPorts(po); setEvents(ev);
    } finally {
      setLoading(false);
    }
  }, [workstationId]);

  useEffect(() => { loadPolicy(); }, [loadPolicy]);

  // Initial load, then refetch whenever this host reports new activity over the
  // live socket. A slow fallback poll covers the case where the browser socket
  // dropped and reconnected between samples.
  useEffect(() => { loadData(); }, [loadData, tick]);
  useEffect(() => {
    const t = setInterval(loadData, 60_000);
    return () => clearInterval(t);
  }, [loadData]);

  const procEnabled  = enabled.process === true;
  const portsEnabled = enabled.ports === true;
  const anyEnabled   = procEnabled || portsEnabled;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Top processes */}
      <div className="grid" style={{ gridTemplateColumns: "2fr 1fr" }}>
        <div className="card" style={{ overflow: "auto" }}>
          <div className="card-head">
            <div className="card-title">Top processes</div>
            {procEnabled && procs.length > 0 && (
              <a href={exportUrl("processes", "csv", workstationId)}
                 className="label" style={{ color: "var(--info)", textDecoration: "none" }}>
                Export CSV
              </a>
            )}
          </div>
          {!procEnabled ? (
            <CollectorOff label="Process" capable={caps.includes("process")} />
          ) : loading ? (
            <div style={{ padding: 20, fontSize: 12.5, color: "var(--text-dim)" }}>Loading…</div>
          ) : procs.length === 0 ? (
            <div style={{ padding: 20, fontSize: 12.5, color: "var(--text-dim)" }}>
              No sample yet — the agent reports on its next collection interval.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Process", "User", "PID", "CPU", "RAM", "I/O R/W"].map((h) => (
                    <th key={h} style={TH}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {procs.map((p) => (
                  <tr key={p.pid} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ ...TD, fontWeight: 500 }} title={p.exe ?? p.name}>{p.name}</td>
                    <td style={{ ...TD, color: "var(--text-dim)" }}>{p.username ?? "—"}</td>
                    <td style={{ ...TD, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-faint)" }}>{p.pid}</td>
                    <td style={{ ...TD, fontFamily: "var(--font-mono)", color: p.cpu_pct > 50 ? "var(--warning)" : "var(--text)" }}>
                      {Number(p.cpu_pct ?? 0).toFixed(1)}%
                    </td>
                    <td style={{ ...TD, fontFamily: "var(--font-mono)" }}>
                      {Number(p.mem_rss_mb ?? 0).toFixed(0)} MB
                    </td>
                    <td style={{ ...TD, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-dim)" }}>
                      {Number(p.io_read_mbs ?? 0).toFixed(1)}/{Number(p.io_write_mbs ?? 0).toFixed(1)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Listening ports */}
        <div className="card" style={{ overflow: "auto" }}>
          <div className="card-head">
            <div className="card-title">Listening ports</div>
            {portsEnabled && ports.length > 0 && (
              <span className="label">{ports.length}</span>
            )}
          </div>
          {!portsEnabled ? (
            <CollectorOff label="Port" capable={caps.includes("ports")} />
          ) : loading ? (
            <div style={{ padding: 20, fontSize: 12.5, color: "var(--text-dim)" }}>Loading…</div>
          ) : ports.length === 0 ? (
            <div style={{ padding: 20, fontSize: 12.5, color: "var(--text-dim)" }}>
              No listening sockets reported.
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  {["Port", "Proto", "Process"].map((h) => <th key={h} style={TH}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {ports.map((p) => (
                  <tr key={`${p.proto}-${p.laddr}-${p.lport}`} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ ...TD, fontFamily: "var(--font-mono)", fontWeight: 600 }}>{p.lport}</td>
                    <td style={{ ...TD, color: "var(--text-dim)", textTransform: "uppercase", fontSize: 11 }}>{p.proto}</td>
                    <td style={{ ...TD }} title={p.laddr}>{p.process_name ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Activity timeline */}
      <div className="card" style={{ overflow: "auto" }}>
        <div className="card-head">
          <div className="card-title">Recent activity</div>
          {events.length > 0 && (
            <a href={exportUrl("events", "csv", workstationId)}
               className="label" style={{ color: "var(--info)", textDecoration: "none" }}>
              Export CSV
            </a>
          )}
        </div>
        {events.length === 0 ? (
          <div style={{ padding: "22px 14px", fontSize: 12.5, color: "var(--text-dim)" }}>
            {anyEnabled
              ? "No activity recorded yet."
              : "Enable a collector under Settings → Collectors to start recording activity."}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {events.map((e, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "8px 12px", borderBottom: "1px solid var(--border)", fontSize: 12,
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
                  background: e.severity === "critical" ? "var(--critical)"
                            : e.severity === "warning"  ? "var(--warning)"
                            : "var(--info)",
                }} />
                <span className="mono" style={{ fontSize: 11, color: "var(--text-dim)", minWidth: 116 }}>
                  {e.kind}
                </span>
                <span style={{ flex: 1, color: "var(--text)" }}>{e.subject ?? "—"}</span>
                <span style={{ fontSize: 11, color: "var(--text-faint)", whiteSpace: "nowrap" }}>
                  {relTime(e.time)}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
