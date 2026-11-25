// The app opens SQLite only through DesignProvider's default; tests pass their own store.
export async function openDatabaseAsync(): Promise<never> {
  throw new Error("expo-sqlite is not available in tests; pass openStore to DesignProvider");
}
