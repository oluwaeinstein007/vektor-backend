// §5.1's six RBAC roles, spelled exactly as 01-users-scope.md's RBAC Role
// column and the live Keycloak "vektor" realm's role names have them —
// "Field Operator" and "Logistics Officer" carry a literal space, unlike
// the other four. (Systems Integrator, persona 7, deliberately has no RBAC
// role — it authenticates via a scoped API key instead, out of scope here.)
export const ROLES = [
  "Viewer",
  "Field Operator",
  "Analyst",
  "Logistics Officer",
  "Commander",
  "SuperAdmin",
] as const;

export type Role = (typeof ROLES)[number];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

// 07-data-api.md §13.1's auth column uses shorthand ("Analyst+", "Logistics+",
// "All roles") rather than an exhaustive role list per endpoint. §5.1 doesn't
// define what "+" means precisely (Analyst and Logistics Officer are parallel
// tracks, not a single total order), so this is a documented interpretation,
// not a spec transcription:
//   - "+" means "this role, or a role empowered to act as this role's
//     superior in the mission hierarchy" — Commander (owns the COP) and
//     SuperAdmin (owns the platform) satisfy every "+" requirement.
//   - Requirements that aren't "+" (Commander-only, SuperAdmin-only) are
//     exact, except SuperAdmin still satisfies every requirement (it's the
//     platform owner, per persona 5's "RBAC policy" responsibility).
//   - "all" means "any authenticated role" (not "unauthenticated") — per
//     §14.3, INTERNAL/SENSITIVE data always requires auth; only OPEN data
//     (map tiles, weather) is genuinely unauthenticated, and no service this
//     module is wired into serves OPEN data.
export type RoleRequirement = "all" | "analyst+" | "logistics+" | "commander" | "superadmin";

const REQUIREMENT_ALLOWS: Record<RoleRequirement, ReadonlySet<Role>> = {
  all: new Set(ROLES),
  "analyst+": new Set<Role>(["Analyst", "Commander", "SuperAdmin"]),
  "logistics+": new Set<Role>(["Logistics Officer", "Commander", "SuperAdmin"]),
  commander: new Set<Role>(["Commander", "SuperAdmin"]),
  superadmin: new Set<Role>(["SuperAdmin"]),
};

export function satisfiesRequirement(role: Role, requirement: RoleRequirement): boolean {
  return REQUIREMENT_ALLOWS[requirement].has(role);
}
