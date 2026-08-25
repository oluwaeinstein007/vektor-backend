// SVC-019 test/dev fixture — a small synthetic road grid (no real road
// network data exists to seed from in this sandbox), same "genuine
// algorithm, synthetic input" tradeoff as cv-train-svc's synthetic YOLOv8
// training set. Nodes are laid out on an evenly-spaced lat/lon grid near
// (10, 50); edges connect orthogonal neighbors with a real
// geography-distance cost (meters), not a placeholder constant, so
// pgr_dijkstra's shortest-path result is measuring something real.
import type { Sql } from "postgres";

export interface GridOptions {
  size: number; // NxN grid
  spacingDeg: number;
  originLon: number;
  originLat: number;
}

export const DEFAULT_GRID: GridOptions = { size: 4, spacingDeg: 0.01, originLon: 10.0, originLat: 50.0 };

export function nodeId(row: number, col: number, size: number): number {
  return row * size + col + 1;
}

// Nukes and rebuilds the whole road_edges/road_nodes tables — safe for a
// single test process, but two test *files* calling this concurrently
// against the shared routing Postgres instance race each other (one file's
// DELETE can run mid-query in another file's findRoute() call, producing a
// spuriously empty path). This service's package.json test script runs
// with `--test-concurrency=1` specifically because of this — found
// 2026-08-25 when routing.integration.test.ts and routes.test.ts, which
// each call seedGrid() independently, started failing only when run
// together, not individually.
export async function seedGrid(sql: Sql, options: GridOptions = DEFAULT_GRID): Promise<void> {
  await sql`DELETE FROM road_edges`;
  await sql`DELETE FROM road_nodes`;

  const { size, spacingDeg, originLon, originLat } = options;

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const id = nodeId(row, col, size);
      const lon = originLon + col * spacingDeg;
      const lat = originLat + row * spacingDeg;
      await sql`INSERT INTO road_nodes (id, lon, lat) VALUES (${id}, ${lon}, ${lat})`;
    }
  }

  async function insertEdge(aRow: number, aCol: number, bRow: number, bCol: number): Promise<void> {
    const aId = nodeId(aRow, aCol, size);
    const bId = nodeId(bRow, bCol, size);
    const aLon = originLon + aCol * spacingDeg;
    const aLat = originLat + aRow * spacingDeg;
    const bLon = originLon + bCol * spacingDeg;
    const bLat = originLat + bRow * spacingDeg;

    await sql`
      INSERT INTO road_edges (source, target, cost, reverse_cost, blocked, the_geom)
      SELECT ${aId}, ${bId},
        ST_Length(geography(ST_MakeLine(ST_MakePoint(${aLon}, ${aLat}), ST_MakePoint(${bLon}, ${bLat})))),
        ST_Length(geography(ST_MakeLine(ST_MakePoint(${aLon}, ${aLat}), ST_MakePoint(${bLon}, ${bLat})))),
        false,
        ST_SetSRID(ST_MakeLine(ST_MakePoint(${aLon}, ${aLat}), ST_MakePoint(${bLon}, ${bLat})), 4326)
    `;
  }

  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (col + 1 < size) await insertEdge(row, col, row, col + 1); // east neighbor
      if (row + 1 < size) await insertEdge(row, col, row + 1, col); // south neighbor
    }
  }
}
