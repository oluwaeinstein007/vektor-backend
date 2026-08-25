// SVC-013 — coa-svc's client for audit-svc's internal write endpoint. Every
// other service in this codebase that reaches across a service boundary
// does it over REST, not gRPC (gRPC is reserved for the TS<->Python
// boundary — Pitfall 3), so this is a plain fetch POST, same as
// context/fetchNoStrikeZones.ts's read-side equivalent.
import { z } from "zod";
import { AuditEntry } from "@vektor/shared";

export interface AuditWriteParams {
  actor_user_id: string;
  actor_role: string;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata?: Record<string, unknown>;
}

export interface AuditClient {
  write(entry: AuditWriteParams): Promise<AuditEntry>;
}

export function createAuditClient(auditSvcUrl: string): AuditClient {
  return {
    async write(entry) {
      const res = await fetch(`${auditSvcUrl}/api/v1/audit`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(entry),
      });
      if (!res.ok) {
        throw new Error(`audit-svc write failed: ${res.status} ${await res.text()}`);
      }
      const body: unknown = await res.json();
      return AuditEntry.parse(body);
    },
  };
}
