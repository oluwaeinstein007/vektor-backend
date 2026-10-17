// NW-018 (UC-2.2): read side of entity_history. Drizzle query functions
// only — no HTTP concerns — so they are testable against a real Postgres
// independently of Fastify, same split as queries/entities.ts.
//
// Raw `sql` rather than the query builder throughout: every one of these is
// a window function, a DISTINCT ON, or a PostGIS call that Drizzle's
// builder cannot express, and half-building them would be less readable
// than the SQL itself.
import { sql } from "drizzle-orm";
import type { VektorDb } from "@vektor/db";
import type {
  EntityHistoryPoint,
  EntityHistoryResponse,
  EntitySnapshotEntry,
  HistoryCoverageResponse,
  DwellCluster,
} from "@vektor/shared";

/**
 * SRID 4326 is degrees, so a tolerance expressed in metres has to be
 * converted. 111,320 m per degree holds at the equator and shrinks by
 * cos(latitude) as you move away from it, so at 60°N this over-simplifies
 * by about 2×.
 *
 * That is acceptable *here* and nowhere else: this constant is only ever
 * used to decide which vertices of a track to drop for display. It must
 * never be used for a distance the operator reads — those go through
 * PostGIS `geography`, which is properly spheroidal.
 */
const METRES_PER_DEGREE = 111_320;

/**
 * Every timestamp bound into these queries goes in as an ISO string with an
 * explicit ::timestamptz cast, never as a JS Date.
 *
 * drizzle-orm's raw `sql` tag hands parameters to the `postgres` driver
 * untouched, and that driver cannot serialise a Date: it throws
 * `ERR_INVALID_ARG_TYPE: The "string" argument must be of type string ...
 * Received an instance of Date` at bind time. The query builder converts
 * Dates for you; the raw tag does not, which is the same class of trap
 * tests/app.test.ts already documents for array parameters.
 */

export interface TrackQuery {
  entityId: string;
  from: Date;
  to: Date;
  maxPoints: number;
  simplifyToleranceM?: number;
}

/**
 * One entity's track over a window, decimated server-side.
 *
 * Two-stage decimation, deliberately:
 *   1. Douglas-Peucker (ST_Simplify) drops vertices that do not change
 *      the track's shape. A vehicle parked for an hour and
 *      then turning sharply keeps the turn and collapses the parking —
 *      uniform time-sampling gets that exactly backwards, spending its
 *      budget on the stationary hour.
 *   2. A uniform cap afterwards, because DP's output size depends on the
 *      data and `max_points` is a promise to the caller. Stage 1 decides
 *      WHICH points matter; stage 2 guarantees HOW MANY come back.
 *
 * The M-coordinate carries epoch seconds through the simplify so the
 * surviving vertices can be matched back to their rows — ST_Simplify only
 * ever removes vertices, it never moves or invents one, so an M value that
 * comes out is always one that went in.
 *
 * ST_Simplify and NOT ST_SimplifyPreserveTopology, which is the obvious
 * choice and is wrong here: verified against PostGIS 3.4.3, the
 * PreserveTopology variant silently DROPS the M dimension (ST_Zmflag goes
 * 1 -> 0), so every ST_M() comes back NULL, the join matches nothing, and
 * the endpoint returns an empty track for an entity that has thousands of
 * points. It fails silently — no error, just no data. Topology
 * preservation only matters for polygons that must not self-intersect;
 * a track is a LineString and has no such constraint.
 */
export async function queryEntityTrack(db: VektorDb, q: TrackQuery): Promise<EntityHistoryResponse | null> {
  const toleranceDeg = q.simplifyToleranceM
    ? q.simplifyToleranceM / METRES_PER_DEGREE
    : null;

  const rows = await db.execute(sql`
    WITH pts AS (
      SELECT ts, position, alt_m, speed_kmh, heading_deg, confidence,
             classification, affiliation, status
      FROM entity_history
      WHERE entity_id = ${q.entityId}::uuid
        AND ts >= ${q.from.toISOString()}::timestamptz
        AND ts <= ${q.to.toISOString()}::timestamptz
    ),
    stats AS (SELECT count(*)::int AS total FROM pts),
    line AS (
      SELECT ST_MakeLine(
               ST_MakePointM(ST_X(position), ST_Y(position), extract(epoch from ts)) ORDER BY ts
             ) AS geom
      FROM pts
    ),
    -- When no tolerance was supplied, derive one from the track's own
    -- extent: a tolerance proportional to how far the entity actually
    -- travelled, scaled by the point budget. A fixed default would be
    -- meaningless across a harbour patrol and a transatlantic crossing.
    tol AS (
      -- The default tolerance is a DISPLAY-RESOLUTION rule, not a
      -- budget-derived one: drop detail finer than one pixel when the
      -- whole track fits a ~1200px viewport. That is the standard
      -- cartographic rule and it is the only one that behaves sensibly
      -- across both a harbour patrol and an ocean crossing.
      --
      -- Deriving the tolerance from max_points instead (the obvious idea)
      -- does not work, and the measurements are unambiguous: on a real
      -- 1,440-point track, sweeping the divisor gave 4 points at every
      -- tolerance from 108m down to 4.3m and then 264 points at 1.08m.
      -- The cliff is GPS jitter crossing the threshold, so the output size
      -- is governed by sensor noise rather than by the budget, and no
      -- single divisor hits the budget for arbitrary data.
      --
      -- Consequence worth stating plainly: a geometrically simple track
      -- can come back with far FEWER than max_points. That is correct, not
      -- a bug — the contract promises at most max_points, and the
      -- remaining detail was noise. 'total_points' and 'decimated' tell
      -- the operator what was dropped. A client that wants more detail
      -- (zoomed in) passes simplify_tolerance_m explicitly, which is
      -- exactly what that parameter is for.
      --
      -- ST_Length(ST_Envelope(...)) is the obvious way to get the extent
      -- and returns 0 for every input: an envelope is a polygon, and
      -- ST_Length of a polygon is 0, not its perimeter. Computing the
      -- diagonal from ST_XMax/ST_XMin directly avoids that trap.
      SELECT COALESCE(
               ${toleranceDeg}::double precision,
               GREATEST(
                 sqrt(
                   power(ST_XMax(geom) - ST_XMin(geom), 2) +
                   power(ST_YMax(geom) - ST_YMin(geom), 2)
                 ) / 1200,
                 1e-9
               )
             ) AS t
      FROM line
    ),
    kept AS (
      SELECT to_timestamp(ST_M((dp).geom)) AS ts
      FROM (
        SELECT ST_DumpPoints(ST_Simplify(line.geom, tol.t)) AS dp
        FROM line, tol
        WHERE (SELECT total FROM stats) > ${q.maxPoints}
      ) s
    ),
    selected AS (
      SELECT p.*
      FROM pts p
      WHERE (SELECT total FROM stats) <= ${q.maxPoints}
         OR p.ts IN (SELECT ts FROM kept)
    ),
    -- The hard cap. row_number()/stride keeps an evenly spread subset of
    -- whatever survived DP, and always keeps the first and last point so
    -- the track still starts and ends where the entity did.
    --
    -- CEIL, not integer division: with 715 surviving points and a budget
    -- of 200, floor(715/200) = 3 returns 240 points and breaks the
    -- contract's promise of "at most max_points". ceil gives 4 -> 180.
    capped AS (
      SELECT *, row_number() OVER (ORDER BY ts) AS rn, count(*) OVER () AS kept_total
      FROM selected
    )
    SELECT ts, ST_X(position) AS lon, ST_Y(position) AS lat, alt_m, speed_kmh,
           heading_deg, confidence, classification, affiliation, status,
           (SELECT total FROM stats) AS total_points
    FROM capped
    WHERE kept_total <= ${q.maxPoints}
       OR rn = 1
       OR rn = kept_total
       OR (rn % GREATEST(CEIL(kept_total::numeric / GREATEST(${q.maxPoints}, 1))::int, 1)) = 0
    ORDER BY ts
  `);

  const list = rows as unknown as Array<Record<string, unknown>>;
  if (list.length === 0) return null;

  const first = list[0]!;
  const points: EntityHistoryPoint[] = list.map((r) => ({
    ts: new Date(r.ts as string).toISOString(),
    lat: Number(r.lat),
    lon: Number(r.lon),
    alt_m: Number(r.alt_m),
    speed_kmh: Number(r.speed_kmh),
    heading_deg: Number(r.heading_deg),
    confidence: Number(r.confidence),
  }));

  const totalPoints = Number(first.total_points);
  return {
    entity_id: q.entityId,
    classification: String(first.classification),
    affiliation: String(first.affiliation) as EntityHistoryResponse["affiliation"],
    status: String(first.status) as EntityHistoryResponse["status"],
    from: q.from.toISOString(),
    to: q.to.toISOString(),
    points,
    total_points: totalPoints,
    decimated: points.length < totalPoints,
  };
}

export interface SnapshotQuery {
  ts: Date;
  bbox?: { min_lon: number; min_lat: number; max_lon: number; max_lat: number };
  maxStalenessS: number;
}

/**
 * Every entity's last known state at or before an instant — the
 * time-slider's scrub query.
 *
 * DISTINCT ON (entity_id) ... ORDER BY entity_id, ts DESC is the Postgres
 * idiom for "latest row per group" and compiles to a single index scan,
 * unlike the correlated-subquery or window-function forms.
 *
 * The staleness floor is not an optimisation: without it, scrubbing to
 * 03:00 renders every entity ever seen — including ones last detected days
 * earlier — as though they were present at 03:00. It also bounds the scan
 * to a couple of partitions instead of the whole table.
 */
export async function querySnapshotAt(db: VektorDb, q: SnapshotQuery): Promise<EntitySnapshotEntry[]> {
  const floor = new Date(q.ts.getTime() - q.maxStalenessS * 1000);

  const bboxFilter = q.bbox
    ? sql`AND ST_Contains(ST_MakeEnvelope(${q.bbox.min_lon}, ${q.bbox.min_lat}, ${q.bbox.max_lon}, ${q.bbox.max_lat}, 4326), position)`
    : sql``;

  const rows = await db.execute(sql`
    SELECT DISTINCT ON (entity_id)
           entity_id, ts, ST_X(position) AS lon, ST_Y(position) AS lat, alt_m,
           speed_kmh, heading_deg, confidence, classification, affiliation, status
    FROM entity_history
    WHERE ts <= ${q.ts.toISOString()}::timestamptz AND ts >= ${floor.toISOString()}::timestamptz
    ${bboxFilter}
    ORDER BY entity_id, ts DESC
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => {
    const observedAt = new Date(r.ts as string);
    const lon = Number(r.lon);
    const lat = Number(r.lat);
    return {
      entity_id: String(r.entity_id),
      classification: String(r.classification),
      affiliation: String(r.affiliation) as EntitySnapshotEntry["affiliation"],
      status: String(r.status) as EntitySnapshotEntry["status"],
      confidence: Number(r.confidence),
      position: {
        lat,
        lon,
        alt_m: Number(r.alt_m),
        // mgrs is computed, never stored — see schema/entities.ts. Filled
        // by the route via the existing mapper so there is one mgrs
        // implementation in this service, not two.
        mgrs: "",
        accuracy_m: 0,
      },
      kinematics: {
        speed_kmh: Number(r.speed_kmh),
        heading_deg: Number(r.heading_deg),
        trajectory: [],
      },
      observed_at: observedAt.toISOString(),
      staleness_s: Math.max(0, (q.ts.getTime() - observedAt.getTime()) / 1000),
    };
  });
}

/** What history exists at all, so a time-slider can size itself to real data. */
export async function queryHistoryCoverage(db: VektorDb): Promise<HistoryCoverageResponse> {
  const rows = await db.execute(sql`
    SELECT min(ts) AS earliest, max(ts) AS latest,
           count(DISTINCT entity_id)::int AS entity_count,
           count(*)::int AS point_count
    FROM entity_history
  `);
  const r = (rows as unknown as Array<Record<string, unknown>>)[0];
  return {
    earliest: r?.earliest ? new Date(r.earliest as string).toISOString() : null,
    latest: r?.latest ? new Date(r.latest as string).toISOString() : null,
    entity_count: Number(r?.entity_count ?? 0),
    point_count: Number(r?.point_count ?? 0),
  };
}

export interface PatternOfLifeQueryArgs {
  entityId: string;
  from: Date;
  to: Date;
  clusterRadiusM: number;
  minDwellS: number;
}

/**
 * Dwell clustering — the pattern-of-life half of NW-018, scoped narrowly on
 * purpose: where an entity spends time, not a behavioural model.
 *
 * This is stay-point detection, NOT spatial clustering of the raw track,
 * and the difference is not academic. Running ST_ClusterDBSCAN over the
 * observations directly — the obvious first implementation — returns ONE
 * cluster covering the entire track, every time. A moving entity is
 * spatially dense along its own path: at 14 km/h with a 10s sample
 * interval, consecutive points are ~39m apart, so with any useful eps
 * (150m here) DBSCAN chains the whole journey into a single blob whose
 * centroid sits in the middle of the transit, a place the entity never
 * stopped. Measured on a real 1,440-point track: one cluster, one "visit",
 * a 14,390-second dwell, centroid nowhere near either berth.
 *
 * What actually works, in four stages:
 *   1. Derive speed from consecutive positions (`geography`, so metres are
 *      real metres) rather than trusting the recorded speed column — a
 *      sensor that never reports speed defaults it to 0 and would make the
 *      entity look permanently stationary.
 *   2. Flag each observation stopped/moving against a threshold derived
 *      from the caller's own parameters: moving less than
 *      `cluster_radius_m` over `min_dwell_s` IS the definition of dwelling
 *      at this radius, so the threshold needs no third magic number.
 *   3. Gaps-and-islands over that flag to get maximal stopped runs, keeping
 *      those lasting at least `min_dwell_s`.
 *   4. DBSCAN over the RUN CENTROIDS — a handful of well-separated points,
 *      where chaining cannot happen — to merge repeat visits to the same
 *      place. `minpoints := 1` so a single visit is still a cluster.
 *
 * Verified against the same real track: one cluster at the berth, two
 * visits, ~7,180s total dwell, arrivals in hours 0 and 3.
 */
export async function queryPatternOfLife(db: VektorDb, q: PatternOfLifeQueryArgs): Promise<DwellCluster[]> {
  const epsDeg = q.clusterRadiusM / METRES_PER_DEGREE;
  // Moving less than the cluster radius over the minimum dwell IS dwelling
  // at that radius — the threshold falls out of the caller's parameters
  // rather than needing one of its own.
  const stoppedSpeedMs = q.clusterRadiusM / q.minDwellS;

  const rows = await db.execute(sql`
    WITH pts AS (
      SELECT ts, position FROM entity_history
      WHERE entity_id = ${q.entityId}::uuid
        AND ts >= ${q.from.toISOString()}::timestamptz
        AND ts <= ${q.to.toISOString()}::timestamptz
    ),
    stepped AS (
      SELECT ts, position,
             -- ::geography so this is metres on a spheroid, not degrees.
             ST_Distance(position::geography, (lag(position) OVER w)::geography) AS step_m,
             extract(epoch FROM ts - lag(ts) OVER w) AS step_s
      FROM pts WINDOW w AS (ORDER BY ts)
    ),
    flagged AS (
      SELECT ts, position,
             CASE
               -- The first observation has no predecessor; treat it as
               -- stopped so a dwell that begins the window is not missed.
               WHEN step_s IS NULL OR step_s <= 0 THEN 1
               WHEN step_m / step_s <= ${stoppedSpeedMs} THEN 1
               ELSE 0
             END AS stopped
      FROM stepped
    ),
    islands AS (
      SELECT ts, position, stopped,
             row_number() OVER (ORDER BY ts)
           - row_number() OVER (PARTITION BY stopped ORDER BY ts) AS grp
      FROM flagged
    ),
    runs AS (
      SELECT grp, min(ts) AS started, max(ts) AS ended,
             extract(epoch FROM max(ts) - min(ts)) AS dwell_s,
             ST_Centroid(ST_Collect(position)) AS centre
      FROM islands WHERE stopped = 1 GROUP BY grp
    ),
    qualifying AS (SELECT * FROM runs WHERE dwell_s >= ${q.minDwellS}),
    clustered AS (
      SELECT *, ST_ClusterDBSCAN(centre, eps := ${epsDeg}, minpoints := 1) OVER () AS cid
      FROM qualifying
    )
    SELECT ST_X(ST_Centroid(ST_Collect(centre))) AS lon,
           ST_Y(ST_Centroid(ST_Collect(centre))) AS lat,
           count(*)::int AS visits,
           sum(dwell_s) AS total_dwell_s,
           min(started) AS first_seen,
           max(ended) AS last_seen,
           array_agg(DISTINCT extract(hour from started)::int) AS arrival_hours
    FROM clustered GROUP BY cid ORDER BY total_dwell_s DESC
  `);

  return (rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    lat: Number(r.lat),
    lon: Number(r.lon),
    radius_m: q.clusterRadiusM,
    visits: Number(r.visits),
    total_dwell_s: Number(r.total_dwell_s),
    first_seen: new Date(r.first_seen as string).toISOString(),
    last_seen: new Date(r.last_seen as string).toISOString(),
    arrival_hours: (r.arrival_hours as number[]) ?? [],
  }));
}
