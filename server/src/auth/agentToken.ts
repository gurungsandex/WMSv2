import type { FastifyInstance } from "fastify";
import { config } from "../config";

export interface AgentTokenResult {
  workstationId: string;
  /** True when the token was only accepted via the legacy user-secret path. */
  legacy: boolean;
}

interface AgentClaims {
  sub:  string;
  type: string;
}

/**
 * Verify an agent token.
 *
 * Agent tokens are signed with AGENT_JWT_SECRET (the "agent" JWT namespace).
 * Tokens issued before that secret was wired up were signed with the user
 * secret instead; those are still accepted while config.agentJwt.allowLegacy
 * is on, so upgrading the server does not knock the existing fleet offline.
 *
 * Either way the token must carry type === "agent", and user-facing routes
 * reject that type outright — so a legacy agent token can still only be used
 * to submit telemetry, never to read fleet data.
 */
export function verifyAgentToken(
  app: FastifyInstance,
  token: string
): AgentTokenResult | null {
  // Preferred path: dedicated agent secret.
  try {
    const claims = app.jwt.agent.verify(token) as AgentClaims;
    if (claims.type === "agent" && claims.sub) {
      return { workstationId: claims.sub, legacy: false };
    }
    return null;
  } catch {
    // fall through to the legacy check
  }

  if (!config.agentJwt.allowLegacy) return null;

  try {
    const claims = app.jwt.verify(token) as AgentClaims;
    if (claims.type === "agent" && claims.sub) {
      return { workstationId: claims.sub, legacy: true };
    }
  } catch {
    return null;
  }

  return null;
}
