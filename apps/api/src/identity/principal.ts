import { ROLE_GRANTS } from "./roles.generated";

export interface Principal {
  subject: string;
  roles: string[];
  permissions: string[];
}

/**
 * Roles come from the IdP (`realm_access.roles`); permissions come only from roles.reference.json.
 * Roles the contract does not know (Keycloak defaults such as offline_access) are dropped.
 */
export function principalFrom(claims: { sub?: unknown; realm_access?: unknown }): Principal {
  const raw = (claims.realm_access as { roles?: unknown } | undefined)?.roles;
  const roles = Array.isArray(raw) ? Object.keys(ROLE_GRANTS).filter((r) => raw.includes(r)) : [];
  const permissions = [...new Set(roles.flatMap((r) => ROLE_GRANTS[r]))].sort();
  return { subject: String(claims.sub), roles, permissions };
}
