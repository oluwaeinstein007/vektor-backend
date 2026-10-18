// packages/model-registry/src/promote.ts — NW-021.
//
// The step that makes this a workflow rather than two tools: take a
// registered model version and put it into a running cv-inference-svc via
// its existing `POST /api/v1/models/upload` hot-swap endpoint (ML-006,
// SuperAdmin-only, validates by loading before touching the live session).
//
// Nothing here re-implements validation. cv-inference-svc already refuses
// a model it cannot load, and that refusal is the real gate — a second,
// weaker check here would only create a way for the two to disagree.
import { sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { VektorDb } from "@vektor/db";
import { TrainingJobError } from "./lifecycle.js";

export class PromotionError extends Error {}

export interface PromotionTarget {
  /** Operator-facing name, recorded in `deployed_to` — e.g. "site-3-edge". */
  name: string;
  /** Base URL of that deployment's cv-inference-svc. */
  baseUrl: string;
  /** A SuperAdmin JWT or an API key. The endpoint is SuperAdmin-gated. */
  token: string;
}

export interface PromoteOptions {
  /** Reads the artifact. Injected so this works against S3, disk or a test. */
  fetchArtifact(uri: string): Promise<Buffer>;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/**
 * Promotes a version to one deployment.
 *
 * Order of operations matters and is the opposite of convenient:
 *
 *  1. fetch the artifact
 *  2. verify its SHA-256 against what the registry recorded
 *  3. upload
 *  4. only then record the deployment
 *
 * The hash check is step 2 and not optional. The registry's whole claim is
 * that it can answer "is the model running at site 3 the one we think we
 * shipped", and that claim is worth nothing if the artifact is uploaded
 * without being compared to the hash recorded when it was produced. Object
 * stores are eventually consistent, paths get reused, and a half-written
 * upload is a real thing.
 *
 * `deployed_to` is written AFTER the upload succeeds. Recording it first
 * would mean a failed upload leaves the registry claiming a deployment
 * that never happened — and the registry being wrong in that direction is
 * worse than it being silent, because it is the thing an operator consults
 * when deciding whether they still need to act.
 */
export async function promoteModelVersion(
  db: VektorDb,
  versionId: string,
  target: PromotionTarget,
  options: PromoteOptions,
): Promise<{ version: number; deployed_to: string[]; executionProvider?: string }> {
  const rows = (await db.execute(sql`
    SELECT version_id, org_id, version, artifact_uri, artifact_sha256, deployed_to, retired_at
    FROM model_versions WHERE version_id = ${versionId}::uuid
  `)) as unknown as {
    version_id: string;
    org_id: string;
    version: number;
    artifact_uri: string;
    artifact_sha256: string;
    deployed_to: string[];
    retired_at: Date | null;
  }[];
  const version = rows[0];
  if (!version) throw new TrainingJobError(`no such model version: ${versionId}`);
  if (version.retired_at !== null) {
    // Retired means someone decided this model should stop being used.
    // Promoting it again would quietly undo that decision.
    throw new PromotionError(`model version ${version.version} is retired and cannot be promoted`);
  }

  const artifact = await options.fetchArtifact(version.artifact_uri);
  const actual = sha256(artifact);
  if (actual !== version.artifact_sha256) {
    throw new PromotionError(
      `artifact hash mismatch for version ${version.version}: registry has ${version.artifact_sha256}, fetched ${actual}`,
    );
  }

  const doFetch = options.fetchImpl ?? fetch;
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(artifact)]), `vektor-model-v${version.version}.onnx`);

  let res: Response;
  try {
    res = await doFetch(`${target.baseUrl.replace(/\/$/, "")}/api/v1/models/upload`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.token}` },
      body: form,
    });
  } catch (err) {
    throw new PromotionError(
      `could not reach ${target.name} at ${target.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // cv-inference-svc returns 400 with a reason when a model fails to
    // load. Passing that through verbatim is the difference between "the
    // promotion failed" and "the model declares an opset this runtime
    // cannot run", which is the thing the operator needs.
    throw new PromotionError(`${target.name} rejected the model (HTTP ${res.status}): ${body.slice(0, 300)}`);
  }

  const payload = (await res.json().catch(() => ({}))) as { executionProvider?: string };

  const updated = (await db.execute(sql`
    UPDATE model_versions
    SET deployed_to = (
      SELECT ARRAY(SELECT DISTINCT unnest(array_prepend(${target.name}, deployed_to)))
    )
    WHERE version_id = ${versionId}::uuid
    RETURNING version, deployed_to
  `)) as unknown as { version: number; deployed_to: string[] }[];

  return { version: updated[0]!.version, deployed_to: updated[0]!.deployed_to, executionProvider: payload.executionProvider };
}

/**
 * Retires a version. Does NOT contact any deployment.
 *
 * Deliberate: retiring is a statement about what should be used from now
 * on, not a remote action, and a retire that half-succeeded across five
 * sites would leave the registry unable to say what is running anywhere.
 * Replacing a live model means promoting its successor, which is an
 * operation with a verifiable result.
 */
export async function retireModelVersion(db: VektorDb, versionId: string): Promise<void> {
  await db.execute(sql`
    UPDATE model_versions SET retired_at = now()
    WHERE version_id = ${versionId}::uuid AND retired_at IS NULL
  `);
}
