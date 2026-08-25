// No-strike zones are polygon geometry that only fusion-svc knows how to
// extract (drizzle-orm's geometry() helper can't parse polygons — see
// packages/db/src/schema/blueForce.ts's header comment — fusion-svc's
// listNoStrikeZones() already owns the raw ST_AsGeoJSON query for this).
// coa-svc fetches the already-mapped wire shape over REST instead of
// forking that query, same as apps/web's no-strike-zone-layer.tsx does.
import { z } from "zod";
import { NoStrikeZone } from "@vektor/shared";

export async function fetchNoStrikeZones(fusionSvcUrl: string): Promise<NoStrikeZone[]> {
  const res = await fetch(`${fusionSvcUrl}/api/v1/no-strike-zones`);
  if (!res.ok) {
    throw new Error(`fusion-svc no-strike-zones fetch failed: ${res.status}`);
  }
  const body: unknown = await res.json();
  return z.array(NoStrikeZone).parse(body);
}
