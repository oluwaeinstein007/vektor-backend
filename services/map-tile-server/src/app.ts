import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

export interface BuildAppOptions {
  tilesDir: string;
  logger?: boolean;
}

/**
 * @fastify/static handles Range requests (206 Partial Content,
 * Accept-Ranges: bytes) out of the box — that correctness is the entire
 * job of a PMTiles server. The PMTiles *client* (apps/web, via MapLibre's
 * pmtiles:// protocol handler) is what turns those byte ranges into tiles;
 * this service stays a dumb, correct file server on purpose (EDGE-004
 * generates the .pmtiles archives this serves; offline edge deployments
 * point the same client at a local copy of this same server).
 */
export function buildApp(options: BuildAppOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });

  app.register(fastifyStatic, {
    root: options.tilesDir,
    prefix: "/tiles/",
    acceptRanges: true,
    // Archives are large and effectively immutable once published — a new
    // map pack gets a new filename (EDGE-004), not an in-place overwrite —
    // so aggressive client caching is safe and desirable on tactical-link
    // bandwidth budgets.
    cacheControl: true,
    maxAge: "7d",
    immutable: true,
    extensions: ["pmtiles"],
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  return app;
}
