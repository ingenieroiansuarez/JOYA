// Generates, from 21_SECURITY/roles.reference.json (the source of truth):
//   infra/keycloak/realm-aurea-local.json   local/CI Keycloak realm (roles, clients, dev users)
//   infra/keycloak-demo/realm-aurea-demo.json  demo realm (hito 600): synthetic personas, no CI client
//   apps/api/src/identity/roles.generated.ts role -> permission map the API enforces
//   node scripts/identity-gen.mjs          # write
//   node scripts/identity-gen.mjs --check  # exit 1 if a committed file is stale
// The realm is LOCAL/CI ONLY. Its secrets are Keycloak import placeholders (${VAR}) filled
// from .env at import time; no secret value is ever written here.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const REALM_FILE = `${ROOT}infra/keycloak/realm-aurea-local.json`;
export const ROLES_TS_FILE = `${ROOT}apps/api/src/identity/roles.generated.ts`;
export const MOBILE_REDIRECT = "com.aurea.customer.dev:/oauthredirect";
export const WEB_ORIGIN = "http://127.0.0.1:3100";
export const DEMO_REALM_FILE = `${ROOT}infra/keycloak-demo/realm-aurea-demo.json`;
export const DEMO_MOBILE_REDIRECT = "com.aurea.customer.demo:/oauthredirect";
export const DEMO_WEB_ORIGIN = "http://127.0.0.1:3101";

const audience = {
  name: "audience aurea-api",
  protocol: "openid-connect",
  protocolMapper: "oidc-audience-mapper",
  config: { "included.custom.audience": "aurea-api", "access.token.claim": "true", "id.token.claim": "false" },
};

const person = (username, firstName, lastName, passwordVar, realmRoles) => ({
  username,
  enabled: true,
  email: `${username}@aurea.invalid`, // reserved TLD (RFC 2606): no real mailbox
  emailVerified: true,
  firstName,
  lastName,
  credentials: [{ type: "password", value: `\${${passwordVar}}`, temporary: false }],
  realmRoles,
});

/**
 * Realm profiles. `local` is the developer realm (with the CI client); `demo` is the isolated demo
 * stack of hito 600 (compose.demo.yaml): its own app id, panel port and synthetic personas, and no
 * CI client ("never in demo or production"). Passwords are ${VAR} placeholders filled from .env.demo.
 */
export const PROFILES = {
  local: {
    realm: "aurea-local",
    displayName: "AUREA local (no producción)",
    mobileRedirect: MOBILE_REDIRECT,
    webOrigin: WEB_ORIGIN,
    ciClient: true,
    users: [
      person("dev.cliente", "Cliente", "Demo", "KC_DEV_USER_PASSWORD", ["customer"]),
      // Local staff for the web panel (hito 500): quotes, stock and payments of the demo store.
      person("dev.equipo", "Equipo", "Demo", "KC_DEV_STAFF_PASSWORD", ["advisor", "stockkeeper", "finance"]),
    ],
  },
  demo: {
    realm: "aurea-demo",
    displayName: "AUREA Demo (datos sintéticos, no producción)",
    mobileRedirect: DEMO_MOBILE_REDIRECT,
    webOrigin: DEMO_WEB_ORIGIN,
    ciClient: false,
    users: [
      person("demo.cliente", "Cliente", "Demo", "KC_DEMO_CUSTOMER_PASSWORD", ["customer"]),
      // The presenter uses one staff account in the panel; the single-role personas show segregation.
      person("demo.equipo", "Equipo", "Demo", "KC_DEMO_STAFF_PASSWORD", ["advisor", "stockkeeper", "finance"]),
      person("demo.asesor", "Asesor", "Demo", "KC_DEMO_STAFF_PASSWORD", ["advisor"]),
      person("demo.disenador", "Diseñador", "Demo", "KC_DEMO_STAFF_PASSWORD", ["designer"]),
      person("demo.almacen", "Almacén", "Demo", "KC_DEMO_STAFF_PASSWORD", ["stockkeeper"]),
      person("demo.inspector", "Inspector", "Demo", "KC_DEMO_STAFF_PASSWORD", ["inspector"]),
    ],
  },
};

const CI_CLIENT = {
  clientId: "aurea-ci",
  name: "CI only: client credentials to exercise the API (never in demo or production)",
  enabled: true,
  publicClient: false,
  clientAuthenticatorType: "client-secret",
  secret: "${KC_CI_CLIENT_SECRET}",
  standardFlowEnabled: false,
  implicitFlowEnabled: false,
  directAccessGrantsEnabled: false,
  serviceAccountsEnabled: true,
  protocolMappers: [audience],
};

export function buildRealm(rolesDoc, profile = PROFILES.local) {
  const roles = Object.keys(rolesDoc.roles);
  const { mobileRedirect, webOrigin } = profile;
  return {
    realm: profile.realm,
    displayName: profile.displayName,
    enabled: true,
    sslRequired: "external",
    registrationAllowed: false,
    loginWithEmailAllowed: false,
    duplicateEmailsAllowed: false,
    resetPasswordAllowed: false,
    bruteForceProtected: true,
    accessTokenLifespan: 300,
    ssoSessionIdleTimeout: 1800,
    revokeRefreshToken: true,
    refreshTokenMaxReuse: 0,
    roles: { realm: roles.map((name) => ({ name, description: `AUREA role ${name} (roles.reference.json)` })) },
    clients: [
      {
        clientId: "aurea-api",
        name: "AUREA API (audience only)",
        enabled: true,
        bearerOnly: true,
        publicClient: false,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false,
      },
      {
        clientId: "aurea-mobile",
        name: "AUREA mobile (public, Authorization Code + PKCE S256)",
        enabled: true,
        publicClient: true,
        standardFlowEnabled: true,
        implicitFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
        redirectUris: [mobileRedirect],
        webOrigins: [],
        attributes: { "pkce.code.challenge.method": "S256", "post.logout.redirect.uris": mobileRedirect },
        protocolMappers: [audience],
      },
      {
        clientId: "aurea-web",
        name: "AUREA web command center (BFF: confidential, Authorization Code + PKCE S256; local only)",
        enabled: true,
        publicClient: false,
        clientAuthenticatorType: "client-secret",
        secret: "${KC_WEB_CLIENT_SECRET}",
        standardFlowEnabled: true,
        implicitFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
        redirectUris: [`${webOrigin}/auth/callback`],
        webOrigins: [],
        attributes: { "pkce.code.challenge.method": "S256", "post.logout.redirect.uris": `${webOrigin}/` },
        protocolMappers: [audience],
      },
      ...(profile.ciClient ? [CI_CLIENT] : []),
    ],
    users: [
      ...(profile.ciClient
        ? [{ username: "service-account-aurea-ci", enabled: true, serviceAccountClientId: "aurea-ci", realmRoles: ["auditor"] }]
        : []),
      ...profile.users,
    ],
  };
}

export function render(rolesDoc, profile = PROFILES.local) {
  return `${JSON.stringify(buildRealm(rolesDoc, profile), null, 2)}\n`;
}

export function renderRolesTs(rolesDoc) {
  const grants = Object.fromEntries(Object.entries(rolesDoc.roles).map(([role, perms]) => [role, [...perms].sort()]));
  return [
    "// GENERATED by scripts/identity-gen.mjs from 21_SECURITY/roles.reference.json. Do not edit.",
    `export const ROLE_GRANTS: Readonly<Record<string, readonly string[]>> = ${JSON.stringify(grants, null, 2)};`,
    `export const SCOPES: Readonly<Record<string, Readonly<Record<string, string>>>> = ${JSON.stringify(rolesDoc.scopes, null, 2)};`,
    "",
  ].join("\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const rolesDoc = JSON.parse(readFileSync(`${ROOT}21_SECURITY/roles.reference.json`, "utf8"));
  const outputs = [
    [REALM_FILE, render(rolesDoc, PROFILES.local)],
    [DEMO_REALM_FILE, render(rolesDoc, PROFILES.demo)],
    [ROLES_TS_FILE, renderRolesTs(rolesDoc)],
  ];
  if (process.argv.includes("--check")) {
    const stale = outputs.filter(([file, text]) => {
      try { return readFileSync(file, "utf8") !== text; } catch { return true; }
    });
    for (const [file] of stale) console.error(`${file.slice(ROOT.length)} is stale: run node scripts/identity-gen.mjs`);
    if (stale.length) process.exit(1);
    console.log("identity outputs OK");
  } else {
    for (const [file, text] of outputs) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
      console.log(`wrote ${file.slice(ROOT.length)}`);
    }
  }
}
