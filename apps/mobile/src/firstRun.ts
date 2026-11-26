// "Has this phone seen the welcome?" One flag in SecureStore (the same store the session uses; no
// personal data in it). Any storage failure counts as already welcomed: never block the app on it.
import * as SecureStore from "expo-secure-store";

const KEY = "aurea.welcomed.v1";

export async function shouldWelcome(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(KEY)) === null;
  } catch {
    return false;
  }
}

export async function markWelcomed(): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, "1");
  } catch {
    // Shown once more next launch at worst.
  }
}
