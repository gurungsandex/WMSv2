"use client";
import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { Shell } from "@/components/shell/Shell";
import { Gauge } from "@/components/charts/Gauge";
import { Sparkline } from "@/components/charts/Sparkline";
import { LineChart } from "@/components/charts/LineChart";
import { AnimatedNumber } from "@/components/charts/AnimatedNumber";
import { ActivityPanels } from "@/components/activity/ActivityPanels";
import { workstations as wsApi, type EnrolledWorkstation } from "@/lib/api";
import { useLive } from "@/lib/LiveContext";

interface HistRow {
  time: string;
  avg_cpu: number; avg_cpu_temp: number;
  avg_ram: number;
  avg_disk: number; avg_disk_read: number; avg_disk_write: number;
  avg_gpu: number; avg_gpu_temp: number;
  avg_net_in: number; avg_net_out: number;
  avg_net_down: number; avg_net_up: number;
}

function relTime(iso?: string | null) {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

function uptimeStr(sec?: number | null) {
  if (!sec) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function histSeries(hist: HistRow[], key: keyof HistRow, len = 48): number[] {
  const data = hist.map((r) => Number(r[key]) || 0);
  if (data.length >= len) return data.slice(-len);
  return [...Array(len - data.length).fill(0), ...data];
}

const CHART_LABELS = [
  { at: 0, t: "24h" }, { at: 12, t: "18h" },
  { at: 24, t: "12h" }, { at: 36, t: "6h" }, { at: 47, t: "now" },
];

interface HealthFactor { label: string; delta: number; sev: string }

export default function WorkstationDetailPage({ params }: { params: { id: string } }) {
  const { id } = params;
  const { fleetData } = useLive();

  // Try to find the workstation in already-loaded fleet data first
  const liveRow = fleetData.rows.find((r) => r.id === id);

  const [ws, setWs] = useState<EnrolledWorkstation | null>(liveRow ?? null);
  const [hist, setHist] = useState<HistRow[]>([]);
  const [loading, setLoading] = useState(!liveRow);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const [detail, history] = await Promise.all([
        wsApi.get(id),
        fetch(
          (process.env.NEXT_PUBLIC_API_URL ?? "/api") + `/metrics/${id}/history`,
          { credentials: "include" }
        ).then((r) => r.ok ? r.json() : []),
      ]);
      setWs(detail);
      setHist(history as HistRow[]);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Not found");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // Sync live WS updates from fleet context
  useEffect(() => {
    if (liveRow) setWs(liveRow);
  }, [liveRow]);

  if (loading && !ws) {
    return <Shell title="Workstation"><div style={{ padding: 40, color: "var(--text-dim)", textAlign: "center" }}>Loading…</div></Shell>;
  }
  if (error || !ws) {
    return <Shell title="Workstation"><div style={{ padding: 40, color: "var(--critical)", textAlign: "center" }}>{error || "Not found"}</div></Shell>;
  }

  const cpu  = ws.snap_cpu_usage    ?? 0;
  const ram  = ws.snap_ram_used_pct ?? 0;
  const disk = ws.snap_disk_used_pct?? 0;
  const gpu  = ws.snap_gpu_load     ?? 0;
  const cpuTemp = ws.snap_cpu_temp  ?? 0;
  const gpuTemp = ws.snap_gpu_temp  ?? 0;
  const netDown = ws.snap_net_down_mbps ?? 0;
  const netUp   = ws.snap_net_up_mbps   ?? 0;

  const statusColor = `var(--${ws.status})`;
  const factors: HealthFactor[] = Array.isArray(ws.health_factors)
    ? ws.health_factors as HealthFactor[]
    : [];

  const cpuHist  = histSeries(hist, "avg_cpu");
  const ramHist  = histSeries(hist, "avg_ram");
  const diskHist = histSeries(hist, "avg_disk");
  const gpuHist  = histSeries(hist, "avg_gpu");
  const netInHist  = histSeries(hist, "avg_net_in");
  const netOutHist = histSeries(hist, "avg_net_out");

  return (
    <Shell
      title={ws.hostname}
      subtitle={[ws.dept, ws.owner_name, ws.ip].filter(Boolean).join(" · ")}
    >
      <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 20 }}>

        {/* Back + status bar */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Link href="/workstations" style={{ color: "var(--text-dim)", fontSize: 12, textDecoration: "none" }}>
            ← Workstations
          </Link>
          <span style={{ color: "var(--border)" }}>|</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: statusColor, fontSize: 12, textTransform: "capitalize" }}>
            <span className={`dot ${ws.status}`} />{ws.status}
          </span>
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700, color: statusColor }}>
            Score {ws.health_score}
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Last seen {relTime(ws.last_seen_at)}</span>
          <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Up {uptimeStr(ws.uptime_sec)}</span>
          <span style={{ fontSize: 11, color: "var(--text-faint)", fontFamily: "var(--font-mono)" }}>Agent {ws.agent_version ?? "—"}</span>
        </div>

        {/* Gauge row */}
        <div className="grid" style={{ gridTemplateColumns: "repeat(6, 1fr)" }}>
          {[
            { label: "CPU", value: cpu, unit: "%", spark: cpuHist, color: undefined },
            { label: "RAM", value: ram, unit: "%", spark: ramHist, color: undefined },
            { label: "Disk", value: disk, unit: "%", spark: diskHist, color: undefined },
            { label: "GPU", value: gpu, unit: "%", spark: gpuHist, color: "var(--gpu)" },
            { label: "CPU Temp", value: cpuTemp, unit: "°C", max: 100, spark: Array(20).fill(cpuTemp), color: cpuTemp > 85 ? "var(--critical)" : cpuTemp > 70 ? "var(--warning)" : "var(--healthy)" },
            { label: "GPU Temp", value: gpuTemp, unit: "°C", max: 100, spark: Array(20).fill(gpuTemp), color: gpuTemp > 80 ? "var(--warning)" : "var(--healthy)" },
          ].map(({ label, value, unit, spark, color, max }) => (
            <MiniGaugeCard key={label} label={label} value={value} unit={unit} spark={spark} color={color} max={max} />
          ))}
        </div>

        {/* Charts + health factors */}
        <div className="grid" style={{ gridTemplateColumns: "2fr 1fr" }}>
          {/* 24h line chart */}
          <div className="card">
            <div className="card-head">
              <div className="card-title">Resource usage · last 24 hours</div>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                {[["CPU", "var(--info)"], ["RAM", "var(--gpu)"], ["Disk", "var(--warning)"]].map(([l, c]) => (
                  <span key={l} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-dim)" }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: c }} />{l}
                  </span>
                ))}
              </div>
            </div>
            <LineChart
              series={[
                { name: "CPU %",  data: cpuHist,  color: "var(--info)" },
                { name: "RAM %",  data: ramHist,  color: "var(--gpu)" },
                { name: "Disk %", data: diskHist, color: "var(--warning)" },
              ]}
              yMax={100}
              labels={CHART_LABELS}
            />
          </div>

          {/* Health factors */}
          <div className="card" style={{ display: "flex", flexDirection: "column" }}>
            <div className="card-head"><div className="card-title">Health factors</div></div>
            {factors.length === 0 ? (
              <div style={{ padding: "20px 0", color: "var(--healthy)", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                <span className="dot healthy" />No active health issues
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {factors.map((f, i) => (
                  <div key={i} style={{
                    display: "flex", alignItems: "center", gap: 8,
                    padding: "8px 10px", borderRadius: 6,
                    background: f.sev === "critical" ? "rgba(255,77,125,0.08)" : "rgba(255,176,32,0.08)",
                    border: `1px solid ${f.sev === "critical" ? "rgba(255,77,125,0.2)" : "rgba(255,176,32,0.2)"}`,
                  }}>
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: `var(--${f.sev})`, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 12, color: "var(--text)" }}>{f.label}</span>
                    <span className="mono" style={{ fontSize: 12, color: `var(--${f.sev})`, fontWeight: 600 }}>
                      {f.delta > 0 ? `+${f.delta}` : f.delta}
                    </span>
                  </div>
                ))}
                <div style={{ marginTop: 8, padding: "6px 10px", borderRadius: 6, background: "var(--card-2)", display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 12, color: "var(--text-dim)" }}>Health score</span>
                  <span className="mono" style={{ fontWeight: 700, color: statusColor }}>{ws.health_score}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Network chart + system info */}
        <div className="grid" style={{ gridTemplateColumns: "2fr 1fr" }}>
          {/* Network 24h */}
          <div className="card">
            <div className="card-head">
              <div className="card-title">Network throughput · last 24 hours</div>
              <div style={{ display: "flex", gap: 12 }}>
                {[["In", "var(--network)"], ["Out", "var(--info)"]].map(([l, c]) => (
                  <span key={l} style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: "var(--text-dim)" }}>
                    <span style={{ width: 8, height: 8, borderRadius: 2, background: c }} />{l}
                  </span>
                ))}
              </div>
            </div>
            <LineChart
              series={[
                { name: "In MB/s",  data: netInHist,  color: "var(--network)" },
                { name: "Out MB/s", data: netOutHist, color: "var(--info)" },
              ]}
              labels={CHART_LABELS}
            />
          </div>

          {/* System info */}
          <div className="card">
            <div className="card-head"><div className="card-title">System info</div></div>
            <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
              {[
                ["Hostname",    ws.hostname],
                ["OS",          ws.os_name ?? ws.os_family ?? "—"],
                ["IP Address",  ws.ip ?? "—"],
                ["MAC",         ws.mac ?? "—"],
                ["CPU",         ws.cpu_model ?? "—"],
                ["Cores",       ws.cpu_cores != null ? String(ws.cpu_cores) : "—"],
                ["RAM Total",   ws.ram_total_gb != null ? `${ws.ram_total_gb.toFixed(1)} GB` : "—"],
                ["Dept",        ws.dept ?? "—"],
                ["Owner",       ws.owner_name ?? "—"],
                ["Enrolled",    relTime(ws.enrolled_at)],
                ["Net ↓",       netDown > 0 ? `${netDown.toFixed(1)} Mbps` : "—"],
                ["Net ↑",       netUp   > 0 ? `${netUp.toFixed(1)} Mbps`   : "—"],
              ].map(([label, value]) => (
                <div key={label as string} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "baseline",
                  padding: "7px 0", borderBottom: "1px solid var(--border)",
                  fontSize: 12,
                }}>
                  <span style={{ color: "var(--text-dim)" }}>{label}</span>
                  <span style={{ color: "var(--text)", fontFamily: (label as string).includes("IP") || (label as string).includes("MAC") ? "var(--font-mono)" : undefined, fontSize: (label as string).includes("IP") || (label as string).includes("MAC") ? 11 : 12 }}>
                    {value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Endpoint activity */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 4 }}>
          <span className="label">Endpoint activity</span>
          <span style={{ flex: 1, height: 1, background: "var(--border)" }} />
        </div>
        <ActivityPanels workstationId={id} />

      </div>
    </Shell>
  );
}

// ── MiniGaugeCard ─────────────────────────────────────────────────────────────

function MiniGaugeCard({ label, value, unit, spark, color, max = 100 }: {
  label: string; value: number; unit: string; spark: number[];
  color?: string; max?: number;
}) {
  return (
    <div className="card" style={{ display: "flex", flexDirection: "column", gap: 6, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="label">{label}</span>
        <span className="mono" style={{ fontSize: 18, fontWeight: 700, color: color ?? "var(--text)" }}>
          <AnimatedNumber value={value} decimals={unit === "%" ? 0 : 1} />{unit}
        </span>
      </div>
      <Gauge value={value} max={max} size={52} style="ring" color={color} />
      <div style={{ marginTop: 4 }}>
        <Sparkline data={spark} h={22} color={color ?? "var(--info)"} />
      </div>
    </div>
  );
}
