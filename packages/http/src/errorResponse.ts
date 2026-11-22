import { z } from "zod";

/**
 * Wire shape for every expected (handled) HTTP error across every service —
 * previously redeclared verbatim in ~11 route files. Import this instead of
 * redefining it.
 */
export const ErrorResponse = z.object({ error: z.string() });
export type ErrorResponse = z.infer<typeof ErrorResponse>;
