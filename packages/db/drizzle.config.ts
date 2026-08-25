import { defineConfig } from "drizzle-kit";

export default defineConfig({
  // Explicit table files, not a "*.ts" glob: drizzle-kit's own TS loader
  // requires() each matched file directly and can't resolve schema/index.ts's
  // NodeNext-style "./entities.js" relative import (that only resolves once
  // tsc has actually emitted entities.js — drizzle-kit never runs the
  // compiler). index.ts is a runtime-only barrel for client.ts; drizzle-kit
  // doesn't need it as long as every table file is listed here directly.
  schema: [
    "./src/schema/entities.ts",
    "./src/schema/blueForce.ts",
    "./src/schema/coa.ts",
    "./src/schema/auditLog.ts",
    "./src/schema/geofence.ts",
    "./src/schema/logistics.ts",
    "./src/schema/reporting.ts",
  ],
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://localhost:5432/vektor",
  },
});
