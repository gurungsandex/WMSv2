"use client";
import React, { createContext, useCallback, useContext, useState } from "react";
import { useWebSocket, type WsEvent } from "./useWebSocket";
import { useFleetData, mergeMetric, type FleetData } from "./useFleetData";
import type { FleetStats } from "./api";

interface LiveCtx {
  live: boolean;
  setLive: (v: boolean) => void;
  fleetData: FleetData;
  alertBadge: number; // count of unresolved critical alerts received over WS
  /** Per-workstation counter bumped whenever endpoint activity arrives. */
  activityTick: Record<string, number>;
}

const Ctx = createContext<LiveCtx>({
  live: true,
  setLive: () => {},
  fleetData: { fleet: null, rows: [], history: [], loading: true, error: "", lastUpdated: null },
  alertBadge: 0,
  activityTick: {},
});

export function LiveProvider({ children }: { children: React.ReactNode }) {
  const [live, setLive] = useState(true);
  const [tickCount, setTickCount] = useState(0);
  const [alertBadge, setAlertBadge] = useState(0);
  const [activityTick, setActivityTick] = useState<Record<string, number>>({});
  const { data: fleetData, setData } = useFleetData(tickCount);

  const handleEvent = useCallback((e: WsEvent) => {
    if (e.type === "metric") {
      // Merge live metric into rows for instant table/gauge updates
      setData((prev) => {
        const rows = mergeMetric(prev.rows, e.workstation_id, e.data as Record<string, number>, e.status, e.score);

        // Recompute fleet aggregate from updated rows
        const online = rows.filter((r) => r.status !== "offline");
        const counts = {
          healthy:  rows.filter((r) => r.status === "healthy").length,
          warning:  rows.filter((r) => r.status === "warning").length,
          critical: rows.filter((r) => r.status === "critical").length,
          offline:  rows.filter((r) => r.status === "offline").length,
        };
        const avg = (key: keyof typeof rows[0]) =>
          online.length
            ? online.reduce((s, r) => s + ((r[key] as number) ?? 0), 0) / online.length
            : 0;

        const fleet: FleetStats = {
          counts,
          total: rows.length,
          avgCpu:  avg("snap_cpu_usage"),
          avgRam:  avg("snap_ram_used_pct"),
          avgDisk: avg("snap_disk_used_pct"),
          avgGpu:  avg("snap_gpu_load"),
          netIn:   online.reduce((s, r) => s + ((r.snap_net_eth_in as number) ?? 0), 0),
          netOut:  online.reduce((s, r) => s + ((r.snap_net_eth_out as number) ?? 0), 0),
        };
        return { ...prev, rows, fleet, lastUpdated: new Date() };
      });
      // Light tick to drive animated numbers elsewhere
      setTickCount((x) => x + 1);
    } else if (e.type === "alert_open" && e.severity === "critical") {
      setAlertBadge((x) => x + 1);
    } else if (e.type === "alert_resolved") {
      setAlertBadge((x) => Math.max(0, x - 1));
    } else if (
      e.type === "endpoint_event" ||
      e.type === "processes_updated" ||
      e.type === "ports_updated"
    ) {
      // Nudge any mounted activity panel for this host to refetch.
      setActivityTick((prev) => ({
        ...prev,
        [e.workstation_id]: (prev[e.workstation_id] ?? 0) + 1,
      }));
    }
  }, [setData]);

  useWebSocket({ onEvent: handleEvent, enabled: live });

  return (
    <Ctx.Provider value={{ live, setLive, fleetData, alertBadge, activityTick }}>
      {children}
    </Ctx.Provider>
  );
}

export function useLive() {
  return useContext(Ctx);
}
