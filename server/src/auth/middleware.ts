import type { FastifyRequest, FastifyReply } from "fastify";
import { verifyAgentToken } from "./agentToken";

export interface JwtPayload {
  sub: string;   // user id
  email: string;
  role: "admin" | "viewer";
}

export interface AgentJwtPayload {
  sub: string;   // workstation id
  type: "agent";
}

/**
 * Agent tokens must never authenticate a user-facing request.
 *
 * Agent tokens were historically signed with the same secret as user tokens,
 * which meant jwtVerify() accepted them and any enrolled workstation could
 * read the whole fleet's data. Signing is now separated, but this check is the
 * guarantee that does not depend on key separation: a token declaring
 * type === "agent" is rejected here regardless of which key signed it.
 */
function isAgentToken(user: unknown): boolean {
  return (user as { type?: string } | null)?.type === "agent";
}

// Require a valid user JWT (cookie or Authorization header)
export async function requireAuth(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  if (isAgentToken(req.user)) {
    return reply.code(403).send({ error: "Forbidden — agent credentials cannot access this API" });
  }
}

// Require admin role
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  if (isAgentToken(req.user)) {
    return reply.code(403).send({ error: "Forbidden — agent credentials cannot access this API" });
  }
  const user = req.user as JwtPayload;
  if (user.role !== "admin") {
    return reply.code(403).send({ error: "Forbidden — admin only" });
  }
}

// Require an agent JWT (separate signing key, with legacy fallback)
export async function requireAgent(req: FastifyRequest, reply: FastifyReply) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "Missing agent token" });
  }
  const result = verifyAgentToken(req.server, header.slice(7));
  if (!result) {
    return reply.code(401).send({ error: "Invalid agent token" });
  }
  (req as FastifyRequest & { agentWorkstationId?: string }).agentWorkstationId =
    result.workstationId;
}
