// packages/db/src/schema/orgConstants.ts — NW-015.
//
// A leaf module on purpose: it imports nothing. `organisations.ts` needs
// `vektorAppRole` from `auditLog.ts` for its RLS policies, and `auditLog.ts`
// needs the default org id for its own `org_id` column — importing the
// constant from `organisations.ts` would close that cycle. ES modules
// tolerate cyclic imports only when the binding isn't read during module
// evaluation, and `DEFAULT_ORG_ID` is read at evaluation time by every
// `.default(...)` call, so the cycle would surface as `undefined` defaults
// rather than as an import error.
export const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";
