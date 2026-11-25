import type { DiscoveryDocument } from "expo-auth-session";

export type LoginState = { kind: "signedOut" } | { kind: "busy" } | { kind: "failed" } | { kind: "signedIn" };

/** Sign-in is pressable once discovery is known, and also after a failure so Retry can fetch it again. */
export function canPressSignIn(discovery: DiscoveryDocument | null, state: LoginState): boolean {
  if (state.kind === "busy") return false;
  return discovery !== null || state.kind === "failed";
}

/** Reuses the discovery document when it is known, otherwise fetches it (the offline-at-launch case). */
export async function ensureDiscovery(
  current: DiscoveryDocument | null,
  fetchDiscovery: () => Promise<DiscoveryDocument>,
): Promise<DiscoveryDocument> {
  return current ?? (await fetchDiscovery());
}
