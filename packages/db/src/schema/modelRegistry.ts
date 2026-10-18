// packages/db/src/schema/modelRegistry.ts — NW-021.
//
// `cv-train-svc` already does real YOLOv8 training and INT8 ONNX export.
// `cv-inference-svc` already has a verified hot-swap upload endpoint that
// validates a model by loading it before touching the live session. Both
// halves of "we'll train a detector on YOUR objects and ship it to your
// deployment" exist, and nothing joins them: no record of which customer
// asked for what, no version history, no way to answer "which model is
// actually running at site 3 and what was it trained on".
//
// That join is what makes it a product surface rather than two tools, and
// it is where the margin is — 19-commercialization.md rates this one of the
// highest-margin services available, and a service you cannot audit after
// the fact is one you cannot charge for twice.
import { pgTable, pgPolicy, uuid, text, integer, real, jsonb, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { vektorAppRole } from "./auditLog.js";
import { DEFAULT_ORG_ID } from "./orgConstants.js";

/**
 * Training job lifecycle.
 *
 * `EXPORTING` is a separate state from `TRAINING` because they fail for
 * genuinely different reasons and the distinction is the first thing you
 * want when a job fails: training fails on data (bad labels, empty class,
 * diverged loss), export fails on the INT8 size budget or an opset the
 * edge runtime cannot load. Collapsing them into "FAILED" throws away the
 * only cheap signal about which half to look at.
 */
export const TRAINING_JOB_STATES = [
  "QUEUED",
  "TRAINING",
  "EXPORTING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;
export type TrainingJobState = (typeof TRAINING_JOB_STATES)[number];

export const trainingJobs = pgTable(
  "training_jobs",
  {
    job_id: uuid("job_id").primaryKey().defaultRandom(),
    org_id: uuid("org_id").notNull().default(DEFAULT_ORG_ID),
    /** Operator-facing label. */
    name: text("name").notNull(),
    state: text("state").notNull().default("QUEUED"),
    /**
     * Where the labelled dataset lives — an object-store URI, not the data.
     * A customer's training imagery is their most sensitive asset and the
     * thing most likely to be subject to a retention agreement; copying it
     * into VEKTOR's own database would make every backup a copy of it.
     */
    dataset_uri: text("dataset_uri").notNull(),
    base_model: text("base_model").notNull().default("yolov8n.pt"),
    epochs: integer("epochs").notNull().default(100),
    imgsz: integer("imgsz").notNull().default(640),
    /** Class names, in the order the exported model emits them. */
    classes: text("classes").array().notNull(),
    requested_by: text("requested_by").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    started_at: timestamp("started_at", { withTimezone: true }),
    finished_at: timestamp("finished_at", { withTimezone: true }),
    /** Set on FAILED. Null on every other state. */
    error: text("error"),
  },
  () => [
    pgPolicy("training_jobs_org_isolation", {
      for: "all",
      to: vektorAppRole,
      using: sql`org_id = current_setting('vektor.org_id')::uuid`,
      withCheck: sql`org_id = current_setting('vektor.org_id')::uuid`,
    }),
  ],
).enableRLS();

/**
 * A model artifact produced by a job, and where it has been deployed.
 *
 * Separate from the job because one job can legitimately produce several
 * versions (a re-export at a different image size, a re-quantisation), and
 * because a version outlives its job: the question "what is running at
 * site 3" must stay answerable long after the job row is of any interest.
 */
export const modelVersions = pgTable(
  "model_versions",
  {
    version_id: uuid("version_id").primaryKey().defaultRandom(),
    org_id: uuid("org_id").notNull().default(DEFAULT_ORG_ID),
    job_id: uuid("job_id").notNull(),
    /** Monotonic per organisation; what an operator says out loud. */
    version: integer("version").notNull(),
    artifact_uri: text("artifact_uri").notNull(),
    /**
     * SHA-256 of the .onnx. The only way to answer "is the model running
     * at site 3 the one we think we shipped" — a path and a filename
     * answer where it came from, not what it is.
     */
    artifact_sha256: text("artifact_sha256").notNull(),
    size_bytes: integer("size_bytes").notNull(),
    classes: text("classes").array().notNull(),
    /** mAP50-95, precision, recall — whatever the trainer reported. */
    metrics: jsonb("metrics").notNull().default({}),
    /** Null until measured on real hardware; see NW-012. */
    latency_ms_p95: real("latency_ms_p95"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Deployment targets this version is live on, newest first. */
    deployed_to: text("deployed_to").array().notNull().default([]),
    /**
     * Soft retirement, not deletion. A retired model that was running when
     * an incident happened is evidence; a deleted row cannot be produced
     * in an after-action review.
     */
    retired_at: timestamp("retired_at", { withTimezone: true }),
  },
  () => [
    pgPolicy("model_versions_org_isolation", {
      for: "all",
      to: vektorAppRole,
      using: sql`org_id = current_setting('vektor.org_id')::uuid`,
      withCheck: sql`org_id = current_setting('vektor.org_id')::uuid`,
    }),
  ],
).enableRLS();
