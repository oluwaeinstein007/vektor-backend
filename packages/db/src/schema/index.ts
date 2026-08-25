// Barrel of every table, re-exported so client.ts can build one Drizzle
// `schema` object (needed for the query-builder's relational typing) without
// every new table file having to also edit client.ts.
export * from "./entities.js";
export * from "./blueForce.js";
export * from "./coa.js";
export * from "./auditLog.js";
export * from "./geofence.js";
export * from "./logistics.js";
export * from "./reporting.js";
