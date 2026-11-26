/**
 * RP-initiated logout. Without id_token_hint Keycloak stops on a "Do you want to log out?" page and,
 * if that is left, the SSO session lives on and the next panel visit signs straight back in (seen on
 * the phone). With the hint it ends the IdP session and returns.
 */
export function logoutQuery(clientId: string, origin: string, idToken?: string): URLSearchParams {
  const q = new URLSearchParams({ client_id: clientId, post_logout_redirect_uri: `${origin}/` });
  if (idToken) q.set("id_token_hint", idToken);
  return q;
}
