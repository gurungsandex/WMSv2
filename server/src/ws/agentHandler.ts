import type { FastifyInstance } from "fastify";
import { ingestMetric } from "../routes/metrics";
import type { MetricPayload } from "../routes/metrics";
import { query } from "../db";
import { verifyAgentToken } from "../auth/agentToken";
import { registerAgent } from "./hub";
import { pushPolicy, COLLECTORS } from "../services/policy";
import {
  ingestProcesses, ingestPorts, recordEvent,
  type ProcessPayload, type PortPayload,
} from "../services/activity";

interface HelloPayload {
  type:          "hello";
  agent_version: string;
  capabilities:  string[];
}

export async function agentWsRoutes(app: FastifyInstance) {
  // ws://server:4000/ws/agent  — persistent agent connection
  app.get(
    "/ws/agent",
    { websocket: true },
    async (socket, req) => {
      // Verify agent JWT from query param or Authorization header
      const token = (req.query as Record<string, string>).token ??
                    req.headers.authorization?.slice(7);
      if (!token) {
        socket.close(4001, "Unauthorized");
        return;
      }

      const verified = verifyAgentToken(app, token);
      if (!verified) {
        socket.close(4001, "Invalid token");
        return;
      }

      const workstationId = verified.workstationId;
      if (verified.legacy) {
        app.log.warn(
          { workstationId },
          "Agent authenticated with a legacy token signed by the user secret — " +
            "re-enroll this host, then set ALLOW_LEGACY_AGENT_TOKENS=false"
        );
      }
      app.log.info({ workstationId }, "Agent connected");
      registerAgent(workstationId, socket);

      socket.on("message", async (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString()) as Record<string, unknown>;

          // Message routing, backwards compatible by construction:
          // agents built before this feature send a bare metric snapshot with
          // no "type" field, so an absent type means "metric", exactly as the
          // server has always assumed.
          const kind = typeof msg.type === "string" ? msg.type : "metric";

          switch (kind) {
            case "metric": {
              const payload = msg as unknown as MetricPayload;
              payload.workstation_id = workstationId; // enforce from token, not message
              await ingestMetric(workstationId, payload);
              break;
            }

            case "hello":
              await handleHello(app, workstationId, msg as unknown as HelloPayload);
              break;

            case "processes":
              await ingestProcesses(workstationId, msg as unknown as ProcessPayload);
              break;

            case "ports":
              await ingestPorts(workstationId, msg as unknown as PortPayload);
              break;

            default:
              app.log.debug({ workstationId, kind }, "Ignoring unknown agent message type");
          }
        } catch (err) {
          app.log.error({ err }, "Agent WS message error");
        }
      });

      socket.on("close", () => {
        app.log.info({ workstationId }, "Agent disconnected");
      });

      // Send ack
      socket.send(JSON.stringify({ type: "connected", workstation_id: workstationId }));
    }
  );
}

/**
 * Record what the agent says it can do, flag version drift, and push the
 * collector policy that applies to it.
 */
async function handleHello(
  app: FastifyInstance,
  workstationId: string,
  hello: HelloPayload
): Promise<void> {
  // Only accept capability names this server actually understands.
  const caps = Array.isArray(hello.capabilities)
    ? hello.capabilities.filter((c) => (COLLECTORS as readonly string[]).includes(c))
    : [];

  const [prev] = await query<{ agent_version: string | null }>(
    "SELECT agent_version FROM workstations WHERE id = $1",
    [workstationId]
  );

  await query(
    `UPDATE workstations SET
       agent_capabilities  = $2,
       agent_version       = COALESCE($3, agent_version),
       agent_last_hello_at = NOW()
     WHERE id = $1`,
    [workstationId, JSON.stringify(caps), hello.agent_version ?? null]
  );

  // Version drift: the agent on this host is not the version we last saw.
  // Worth surfacing — an unexpected downgrade is a tamper signal.
  if (prev?.agent_version && hello.agent_version && prev.agent_version !== hello.agent_version) {
    await recordEvent(
      workstationId, "agent_version_changed", hello.agent_version,
      { from: prev.agent_version, to: hello.agent_version },
      "warning"
    );
  }

  await recordEvent(
    workstationId, "agent_reconnected", hello.agent_version ?? "unknown",
    { capabilities: caps }
  );

  app.log.info({ workstationId, caps, version: hello.agent_version }, "Agent hello");

  await pushPolicy(workstationId);
}
