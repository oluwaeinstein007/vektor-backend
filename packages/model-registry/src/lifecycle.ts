// packages/model-registry/src/lifecycle.ts — NW-021.
//
// The training job state machine, and the registration of what a job
// produced. Kept apart from the promotion step (promote.ts) because they
// fail differently and at different times: a job fails during training,
// hours in and unattended, while a promotion fails at an operator's
// keystroke against a specific deployment.
import { sql } from "drizzle-orm";
import type { VektorDb } from "@vektor/db";
import { z } from "zod";

export const TRAINING_JOB_STATES = ["QUEUED", "TRAINING", "EXPORTING", "SUCCEEDED", "FAILED", "CANCELLED"] as const;
export type TrainingJobState = (typeof TRAINING_JOB_STATES)[number];

export class TrainingJobError extends Error {}

/**
 * Legal transitions.
 *
 * Explicit rather than "anything to anything", because the states a job
 * can be in are the only thing standing between an operator and a
 * resurrected job: without this, a stray late callback from a worker that
 * died hours ago can move a CANCELLED job to SUCCEEDED and publish a model
 * nobody asked for.
 *
 * QUEUED and TRAINING can be cancelled; EXPORTING cannot. By then the
 * expensive part is already paid for and the export takes seconds — a
 * cancel there wastes the GPU hours it was meant to save.
 */
const ALLOWED: Record<TrainingJobState, readonly TrainingJobState[]> = {
  QUEUED: ["TRAINING", "CANCELLED", "FAILED"],
  TRAINING: ["EXPORTING", "FAILED", "CANCELLED"],
  EXPORTING: ["SUCCEEDED", "FAILED"],
  SUCCEEDED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransition(from: TrainingJobState, to: TrainingJobState): boolean {
  return ALLOWED[from].includes(to);
}

export function isTerminal(state: TrainingJobState): boolean {
  return ALLOWED[state].length === 0;
}

export const createJobInput = z.object({
  org_id: z.string().uuid(),
  name: z.string().min(1),
  dataset_uri: z.string().min(1),
  classes: z.array(z.string().min(1)).min(1, "a detector with no classes cannot be trained"),
  base_model: z.string().default("yolov8n.pt"),
  epochs: z.number().int().positive().max(1000).default(100),
  imgsz: z.number().int().positive().default(640),
  requested_by: z.string().min(1),
});
export type CreateJobInput = z.input<typeof createJobInput>;

export interface TrainingJob {
  job_id: string;
  org_id: string;
  name: string;
  state: TrainingJobState;
  dataset_uri: string;
  classes: string[];
  error: string | null;
}

export async function createTrainingJob(db: VektorDb, input: CreateJobInput): Promise<TrainingJob> {
  const v = createJobInput.parse(input);
  const rows = (await db.execute(sql`
    INSERT INTO training_jobs (org_id, name, dataset_uri, base_model, epochs, imgsz, classes, requested_by)
    VALUES (${v.org_id}::uuid, ${v.name}, ${v.dataset_uri}, ${v.base_model}, ${v.epochs}, ${v.imgsz},
            ${sql.raw(`ARRAY[${v.classes.map((c) => `'${c.replace(/'/g, "''")}'`).join(",")}]::text[]`)},
            ${v.requested_by})
    RETURNING job_id, org_id, name, state, dataset_uri, classes, error
  `)) as unknown as TrainingJob[];
  return rows[0]!;
}

export async function getTrainingJob(db: VektorDb, jobId: string): Promise<TrainingJob | undefined> {
  const rows = (await db.execute(sql`
    SELECT job_id, org_id, name, state, dataset_uri, classes, error
    FROM training_jobs WHERE job_id = ${jobId}::uuid
  `)) as unknown as TrainingJob[];
  return rows[0];
}

/**
 * Moves a job, refusing illegal transitions.
 *
 * The guard is in the UPDATE's WHERE clause, not a read-then-write: two
 * workers reporting on the same job concurrently would both read QUEUED
 * and both write TRAINING, and the second would reset `started_at`. Making
 * the current state part of the WHERE means exactly one wins and the
 * loser's zero-row result is reported as what it is.
 */
export async function transitionJob(
  db: VektorDb,
  jobId: string,
  to: TrainingJobState,
  options: { error?: string } = {},
): Promise<TrainingJob> {
  const job = await getTrainingJob(db, jobId);
  if (!job) throw new TrainingJobError(`no such training job: ${jobId}`);
  if (!canTransition(job.state, to)) {
    throw new TrainingJobError(`illegal transition ${job.state} -> ${to} for job ${jobId}`);
  }
  if (to === "FAILED" && !options.error) {
    // A failure with no reason is a failure nobody can act on, and the
    // reason is never easier to find than at the moment of failing.
    throw new TrainingJobError("transition to FAILED requires an error message");
  }

  const rows = (await db.execute(sql`
    UPDATE training_jobs SET
      state = ${to},
      error = ${options.error ?? null},
      started_at  = CASE WHEN ${to} = 'TRAINING' THEN now() ELSE started_at END,
      finished_at = CASE WHEN ${to} IN ('SUCCEEDED','FAILED','CANCELLED') THEN now() ELSE finished_at END
    WHERE job_id = ${jobId}::uuid AND state = ${job.state}
    RETURNING job_id, org_id, name, state, dataset_uri, classes, error
  `)) as unknown as TrainingJob[];

  if (!rows[0]) {
    throw new TrainingJobError(`job ${jobId} changed state concurrently; ${job.state} -> ${to} not applied`);
  }
  return rows[0];
}

export const registerVersionInput = z.object({
  job_id: z.string().uuid(),
  artifact_uri: z.string().min(1),
  artifact_sha256: z.string().regex(/^[0-9a-f]{64}$/, "expected a hex sha256"),
  size_bytes: z.number().int().positive(),
  metrics: z.record(z.number()).default({}),
});
export type RegisterVersionInput = z.input<typeof registerVersionInput>;

export interface ModelVersion {
  version_id: string;
  org_id: string;
  job_id: string;
  version: number;
  artifact_uri: string;
  artifact_sha256: string;
  size_bytes: number;
  classes: string[];
  deployed_to: string[];
}

/**
 * Records what a job produced.
 *
 * The version number is allocated inside the same statement that inserts
 * the row (`SELECT max(version)+1 ... FROM model_versions WHERE org_id =`),
 * so two concurrent registrations for one organisation cannot both take
 * the same number — the unique index on (org_id, version) is what makes
 * the loser fail loudly instead of silently overwriting.
 *
 * Classes come from the JOB, not from the caller: the exported model's
 * class order is determined by what it was trained on, and letting a
 * caller re-state them is an invitation to a mislabelled detector that
 * reports "person" for every vehicle.
 */
export async function registerModelVersion(db: VektorDb, input: RegisterVersionInput): Promise<ModelVersion> {
  const v = registerVersionInput.parse(input);
  const job = await getTrainingJob(db, v.job_id);
  if (!job) throw new TrainingJobError(`no such training job: ${v.job_id}`);
  if (job.state !== "EXPORTING" && job.state !== "SUCCEEDED") {
    throw new TrainingJobError(`job ${v.job_id} is ${job.state}; a version can only come from EXPORTING or SUCCEEDED`);
  }

  const rows = (await db.execute(sql`
    INSERT INTO model_versions (org_id, job_id, version, artifact_uri, artifact_sha256, size_bytes, classes, metrics)
    SELECT ${job.org_id}::uuid, ${v.job_id}::uuid,
           COALESCE((SELECT max(version) FROM model_versions WHERE org_id = ${job.org_id}::uuid), 0) + 1,
           ${v.artifact_uri}, ${v.artifact_sha256}, ${v.size_bytes},
           (SELECT classes FROM training_jobs WHERE job_id = ${v.job_id}::uuid),
           ${JSON.stringify(v.metrics)}::jsonb
    RETURNING version_id, org_id, job_id, version, artifact_uri, artifact_sha256, size_bytes, classes, deployed_to
  `)) as unknown as ModelVersion[];
  return rows[0]!;
}

export async function listModelVersions(db: VektorDb, orgId: string): Promise<ModelVersion[]> {
  return (await db.execute(sql`
    SELECT version_id, org_id, job_id, version, artifact_uri, artifact_sha256, size_bytes, classes, deployed_to
    FROM model_versions WHERE org_id = ${orgId}::uuid AND retired_at IS NULL
    ORDER BY version DESC
  `)) as unknown as ModelVersion[];
}
