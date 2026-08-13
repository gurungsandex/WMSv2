import type { WebSocket } from "@fastify/websocket";

// In-memory set of connected browser WebSocket clients
const clients = new Set<WebSocket>();

export function registerClient(ws: WebSocket): void {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
}

export function broadcast(payload: unknown): void {
  const msg = JSON.stringify(payload);
  for (const ws of clients) {
    try {
      if (ws.readyState === 1 /* OPEN */) ws.send(msg);
    } catch { /* skip closed */ }
  }
}

// ── Agent sockets ─────────────────────────────────────────────────────────────
// Connected agents, keyed by workstation id, so the server can push collector
// policy down the same socket the agent already uses for metrics.

const agents = new Map<string, WebSocket>();

export function registerAgent(workstationId: string, ws: WebSocket): void {
  agents.set(workstationId, ws);
  ws.on("close", () => {
    // Only drop the entry if it is still this socket — a reconnect may have
    // already replaced it.
    if (agents.get(workstationId) === ws) agents.delete(workstationId);
  });
}

/** Send a frame to one agent. Returns false if it is not connected. */
export function sendToAgent(workstationId: string, payload: unknown): boolean {
  const ws = agents.get(workstationId);
  if (!ws || ws.readyState !== 1 /* OPEN */) return false;
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

export function isAgentConnected(workstationId: string): boolean {
  const ws = agents.get(workstationId);
  return !!ws && ws.readyState === 1;
}
