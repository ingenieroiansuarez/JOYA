// First-run welcome: shown once, every action ends it and says where to go, and the flag lives in
// SecureStore (a storage failure never blocks the app).
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { Api } from "../src/api";
import en from "../src/messages/en.json";

jest.mock("../src/auth", () => ({
  discover: async () => ({ authorizationEndpoint: "a", tokenEndpoint: "t" }),
  refresh: async () => null,
  isFresh: () => false,
  signIn: async () => null,
  signOut: async () => undefined,
  fetchMe: async () => ({ subject: "s", roles: ["customer"], permissions: [] }),
  rememberSubject: async () => undefined,
  rememberedSubject: async () => null,
}));
const mockStore = new Map<string, string>();
let mockFail = false;
jest.mock("expo-secure-store", () => ({
  getItemAsync: async (k: string) => { if (mockFail) throw new Error("keystore"); return mockStore.get(k) ?? null; },
  setItemAsync: async (k: string, v: string) => { if (mockFail) throw new Error("keystore"); mockStore.set(k, v); },
  deleteItemAsync: async (k: string) => { mockStore.delete(k); },
}));
import { markWelcomed, shouldWelcome } from "../src/firstRun";
import { SessionProvider } from "../src/session";
import { WelcomeScreen, type WelcomeChoice } from "../src/screens/WelcomeScreen";

const config = { env: "ci" as const, issuer: "http://127.0.0.1:8080/realms/aurea-local", apiUrl: "http://127.0.0.1:3000" };

describe("first-run flag", () => {
  beforeEach(() => { mockStore.clear(); mockFail = false; });
  it("welcomes a new phone once", async () => {
    expect(await shouldWelcome()).toBe(true);
    await markWelcomed();
    expect(await shouldWelcome()).toBe(false);
  });
  it("never blocks the app when the keystore fails", async () => {
    mockFail = true;
    expect(await shouldWelcome()).toBe(false);
    await expect(markWelcomed()).resolves.toBeUndefined();
  });
});

describe("welcome screen", () => {
  const show = async () => {
    const chosen: WelcomeChoice[] = [];
    await render(
      <SafeAreaProvider initialMetrics={{ frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 40, left: 0, right: 0, bottom: 24 } }}>
        <SessionProvider config={config} apiOverride={new Api(config, "es")}><WelcomeScreen onChoose={(c) => chosen.push(c)} /></SessionProvider>
      </SafeAreaProvider>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: en.signIn })).toBeTruthy());
    return chosen;
  };

  it("says what AUREA is, with the main action first", async () => {
    await show();
    expect(screen.getByRole("header", { name: en.welcomeTitle })).toBeTruthy();
    expect(screen.getByText(en.welcomeBody)).toBeTruthy();
    for (const k of ["welcomeBoutique", "welcomeDesign", "welcomeQuote"] as const) expect(screen.getByText(en[k])).toBeTruthy();
    expect(screen.getByRole("image", { name: en.welcomeArtLabel })).toBeTruthy();
    const buttons = screen.getAllByRole("button").map((b) => b.props.accessibilityLabel);
    expect(buttons).toEqual([en.welcomeExplore, en.welcomeCreate, en.signIn]);
  });

  it("each action reports where the customer wants to go", async () => {
    const chosen = await show();
    await fireEvent.press(screen.getByRole("button", { name: en.welcomeExplore }));
    await fireEvent.press(screen.getByRole("button", { name: en.welcomeCreate }));
    await fireEvent.press(screen.getByRole("button", { name: en.signIn }));
    expect(chosen).toEqual(["explore", "create", "signIn"]);
  });
});
