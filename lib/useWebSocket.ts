"use client";
import { useEffect, useRef, useCallback } from "react";

const WS_URL =
  typeof window !== "undefined"
    ? (process.env.NEXT_PUBLIC_WS_URL ?? (() => {
        // Mirror the page's protocol/host so it works behind Caddy (wss://)
        // and in plain dev (ws://localhost:PORT). Override via NEXT_PUBLIC_WS_URL.
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        return `${proto}//${window.location.host}/ws/live`;
      })())
    : "";

export type WsEvent =
  | { type: "metric"; workstation_id: string; data: Record<string, number>; status: string; score: number; factors: unknown[] }
  | { type: "alert_open"; alert_id: string; workstation_id: string; metric: string; severity: string }
  | { type: "alert_resolved"; alert_id: string; workstation_id: string }
  | { type: "endpoint_event"; workstation_id: string; kind: string; severity: string; subject?: string }
  | { type: "processes_updated"; workstation_id: string; total: number }
  | { type: "ports_updated"; workstation_id: string; count: number };

interface Options {
  onEvent: (e: WsEvent) => void;
  enabled: boolean;
}

export function useWebSocket({ onEvent, enabled }: Options) {
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(1000);

  const connect = useCallback(() => {
    if (!WS_URL || !enabled) return;
    try {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => { backoffRef.current = 1000; };

      ws.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data as string) as WsEvent;
          onEvent(parsed);
        } catch { /* ignore malformed */ }
      };

      ws.onclose = () => {
        if (!enabled) return;
        retryRef.current = setTimeout(() => {
          backoffRef.current = Math.min(backoffRef.current * 2, 30_000);
          connect();
        }, backoffRef.current);
      };

      ws.onerror = () => ws.close();
    } catch { /* SSR / restricted env */ }
  }, [onEvent, enabled]);

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [connect]);
}
