// SVC-014/015/016 — the BullMQ Worker consuming fusion-svc's per-entity
// geofence-check jobs (§9.7: "alert-svc: BullMQ worker -> Geofence check
// ... -> Anomaly scoring ... -> Fires alert"). One job = one entity
// position update; this runs both checks and dispatches any alerts that
// fire, all within the same job so a job's success/failure reflects
// whether the *checks* completed, not whether every notification channel
// succeeded (a bounced email shouldn't make BullMQ retry the whole
// geofence/anomaly evaluation — see dispatchAlert's per-channel try/catch).
import { Worker, type ConnectionOptions } from "bullmq";
import type { Redis } from "ioredis";
import type { VektorDb } from "@vektor/db";
import { GEOFENCE_CHECK_QUEUE, GeofenceCheckJob, type AlertType, type AlertSeverity } from "@vektor/shared";
import { checkGeofenceTransitions } from "../geofence/checkZones.js";
import { EwmaAnomalyDetector } from "../anomaly/ewmaDetector.js";
import { createAlert, setDispatchLog } from "../db/alerts.js";
import { dispatchAlert, type ChannelSenders } from "../dispatch/channels.js";

export interface WorkerDeps {
  db: VektorDb;
  redis: Redis;
  senders: ChannelSenders;
  detector: EwmaAnomalyDetector;
  onAlert?: (alertId: string, type: AlertType) => void;
}

async function processJob(deps: WorkerDeps, job: GeofenceCheckJob): Promise<{ alertsFired: number }> {
  let alertsFired = 0;

  const transitions = await checkGeofenceTransitions(deps.db, deps.redis, job.entity_id, job.position, job.affiliation);
  for (const { zone, event } of transitions) {
    const message = `Entity ${job.entity_id} ${event === "ENTRY" ? "entered" : "exited"} geofence "${zone.name}"`;
    const alert = await createAlert(deps.db, {
      type: "GEOFENCE",
      entity_id: job.entity_id,
      severity: zone.severity as AlertSeverity,
      message,
    });
    const results = await dispatchAlert(deps.senders, zone.channels, zone.notify, {
      alertId: alert.alert_id,
      severity: alert.severity as AlertSeverity,
      message,
    });
    await setDispatchLog(deps.db, alert.alert_id, results);
    deps.onAlert?.(alert.alert_id, "GEOFENCE");
    alertsFired++;
  }

  const anomaly = deps.detector.update(job.entity_id, job.speed_kmh, job.heading_deg);
  if (anomaly.isAnomalous) {
    const message = `Entity ${job.entity_id} anomalous kinematics: speed z=${anomaly.speedZScore.toFixed(2)}, heading z=${anomaly.headingZScore.toFixed(2)}`;
    const alert = await createAlert(deps.db, {
      type: "ANOMALY",
      entity_id: job.entity_id,
      severity: "MEDIUM",
      message,
    });
    // Anomaly alerts are in-app only by design (REQ-5.2 has no per-alert
    // channel config the way a geofence zone does) — no NotifyConfig exists
    // to dispatch through, so this is deliberately not routed through
    // dispatchAlert the way a GEOFENCE alert is.
    await setDispatchLog(deps.db, alert.alert_id, [{ channel: "IN_APP", target: "queue", delivered: true }]);
    deps.onAlert?.(alert.alert_id, "ANOMALY");
    alertsFired++;
  }

  return { alertsFired };
}

export function startAlertWorker(deps: WorkerDeps, connection: ConnectionOptions): Worker<GeofenceCheckJob> {
  return new Worker<GeofenceCheckJob>(
    GEOFENCE_CHECK_QUEUE,
    async (job) => {
      const payload = GeofenceCheckJob.parse(job.data);
      return processJob(deps, payload);
    },
    { connection },
  );
}

export { processJob };
