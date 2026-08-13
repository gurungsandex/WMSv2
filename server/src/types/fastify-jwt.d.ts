import "@fastify/jwt";

/**
 * Type surface for the "agent" JWT namespace registered in main.ts.
 *
 * @fastify/jwt creates fastify.jwt[namespace] and a <namespace>JwtVerify
 * request decorator at runtime, but the namespace is a runtime option so
 * TypeScript cannot infer the shape — it has to be declared.
 */
declare module "@fastify/jwt" {
  interface JWT {
    agent: {
      sign(payload: object, options?: object): string;
      verify<T = unknown>(token: string, options?: object): T;
      decode<T = unknown>(token: string, options?: object): T;
    };
  }
}

declare module "fastify" {
  interface FastifyRequest {
    agentJwtVerify<T = unknown>(): Promise<T>;
  }
}
