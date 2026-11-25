export interface WithRoles { roles: string[] }

/**
 * Roles that are not the team: a customer's (or supplier's) sign-in reaches the panel through the shared
 * IdP session (the app's login and the phone's browser share it), and must stop at the door. The API
 * still scopes every read to what the role may see; this keeps the panel itself for staff.
 */
const NOT_STAFF = new Set(["guest", "customer", "supplier", "offline_access", "uma_authorization"]);
export const isStaff = (me: WithRoles) => me.roles.some((r) => !NOT_STAFF.has(r) && !r.startsWith("default-roles-"));
