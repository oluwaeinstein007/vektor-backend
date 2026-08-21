import { buildApp } from "./app.js";

const PORT = Number(process.env.PORT ?? 3006);
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
