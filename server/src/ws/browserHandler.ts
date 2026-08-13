import type { FastifyInstance } from "fastify";
import { registerClient } from "./hub";

export async function browserWsRoutes(app: FastifyInstance) {
  // ws://server:4000/ws/live  — browser dashboard connection
  app.get(
    "/ws/live",
    { websocket: true },
    async (socket, req) => {
      // Verify user JWT from cookie or ?token= query param
      const tokenFromQuery = (req.query as Record<string, string>).token;
      if (tokenFromQuery) {
        (req.headers as Record<string, string>).authorization = `Bearer ${tokenFromQuery}`;
      }
      try {
        await req.jwtVerify();
      } catch {
        socket.close(4001, "Unauthorized");
        return;
      }
      // The live fleet feed is user-facing: an agent credential must not be
      // able to subscribe to it.
      if ((req.user as { type?: string } | null)?.type === "agent") {
        socket.close(4003, "Agent credentials cannot subscribe to the live feed");
        return;
      }
      registerClient(socket);
      app.log.info({ ip: req.ip }, "Browser WS client connected");
    }
  );
}
