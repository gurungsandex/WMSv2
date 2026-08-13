import { query } from "../db";
import { sendToAgent } from "../ws/hub";

// Collectors this server knows about. Kept in sync with the CHECK constraint
// on collector_policy.collector and with the agent's advertised capabilities.
export const COLLECTORS = ["process", "ports"] as const;
export type CollectorName = (typeof COLLECTORS)[number];

export interface CollectorSetting {
  enabled:      boolean;
  interval_sec: number;
}

export type EffectivePolicy = Record<string, CollectorSetting>;

interface PolicyRow {
  workstation_id: string | null;
  collector:      string;
  enabled:        boolean;
  interval_sec:   number;
}

/**
 * Resolve the policy that actually applies to one workstation:
 * a per-host row wins over the fleet-wide default (workstation_id IS NULL).
 *
 * A collector with no row anywhere is treated as disabled. Off is always the
 * default — a collector never starts running because a row went missing.
 */
export async function effectivePolicyFor(workstationId: string): Promise<EffectivePolicy> {
  const rows = await query<PolicyRow>(
    `SELECT workstation_id, collector, enabled, interval_sec
       FROM collector_policy
      WHERE workstation_id IS NULL OR workstation_id = $1`,
    [workstationId]
  );

  const result: EffectivePolicy = {};
  for (const c of COLLECTORS) {
    result[c] = { enabled: false, interval_sec: 60 };
  }

  // Apply globals first, then let host-specific rows overwrite them.
  for (const r of rows.filter((r) => r.workstation_id === null)) {
    result[r.collector] = { enabled: r.enabled, interval_sec: r.interval_sec };
  }
  for (const r of rows.filter((r) => r.workstation_id !== null)) {
    result[r.collector] = { enabled: r.enabled, interval_sec: r.interval_sec };
  }

  return result;
}

/**
 * Push the effective policy to a workstation's agent, if it is connected.
 *
 * Only collectors the agent actually advertised are sent. An agent that never
 * sent a hello has no capabilities recorded, so it receives an empty set and
 * keeps behaving exactly as it did before this feature existed.
 */
export async function pushPolicy(workstationId: string): Promise<void> {
  const [ws] = await query<{ agent_capabilities: string[] | null }>(
    "SELECT agent_capabilities FROM workstations WHERE id = $1",
    [workstationId]
  );
  if (!ws) return;

  const caps: string[] = Array.isArray(ws.agent_capabilities) ? ws.agent_capabilities : [];
  if (caps.length === 0) return; // legacy agent — nothing to negotiate

  const policy = await effectivePolicyFor(workstationId);
  const collectors: EffectivePolicy = {};
  for (const c of caps) {
    if (policy[c]) collectors[c] = policy[c];
  }

  sendToAgent(workstationId, { type: "policy", collectors });
}

/** Push the current policy to every connected agent. */
export async function pushPolicyToAll(): Promise<void> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM workstations
      WHERE enrolled_at IS NOT NULL
        AND jsonb_array_length(COALESCE(agent_capabilities, '[]'::jsonb)) > 0`
  );
  for (const r of rows) {
    await pushPolicy(r.id);
  }
}
