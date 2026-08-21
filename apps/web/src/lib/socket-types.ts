// VEKTOR-PRD.md §13.2 — the typed Socket.io event maps, derived from the
// same Zod schemas every backend emitter validates against
// (@vektor/proto's ServerToClientEvents/ClientToServerEvents), not
// hand-typed here. A field added to a payload schema shows up in these
// types automatically; nothing in apps/web has its own copy of the shape.
import { z } from "zod";
import { ServerToClientEvents as S2CSchemas, ClientToServerEvents as C2SSchemas } from "@vektor/shared";

export type ServerToClientEvents = {
  [K in keyof typeof S2CSchemas]: (payload: z.infer<(typeof S2CSchemas)[K]>) => void;
};
export type ClientToServerEvents = {
  [K in keyof typeof C2SSchemas]: (payload: z.infer<(typeof C2SSchemas)[K]>) => void;
};

export { S2CSchemas, C2SSchemas };
