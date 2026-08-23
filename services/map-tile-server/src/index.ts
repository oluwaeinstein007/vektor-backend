import { buildApp } from "./app.js";

// 3006 collides with cv-inference-svc's default PORT (found 2026-08-23) — a
// same-machine dev run of both needs distinct ports. 3008 to leave 3007 for
// fusion-svc.
const PORT = Number(process.env.PORT ?? 3008);
const TILES_DIR = process.env.TILES_DIR ?? "/data/tiles";

const app = buildApp({ tilesDir: TILES_DIR });

app
  .listen({ port: PORT, host: "0.0.0.0" })
  .then(() => app.log.info(`map-tile-server serving ${TILES_DIR} on :${PORT}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

process.on("SIGTERM", () => void app.close().then(() => process.exit(0)));
process.on("SIGINT", () => void app.close().then(() => process.exit(0)));
