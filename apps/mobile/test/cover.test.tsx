// The cover: it hands off from the native splash, shows the brand, opens onto the app on its own or
// on a tap, and honours "remove animations".
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import { act, fireEvent, render, screen } from "@testing-library/react-native";
import { AccessibilityInfo } from "react-native";

jest.mock("expo-splash-screen", () => ({
  setOptions: jest.fn(), preventAutoHideAsync: jest.fn(async () => true), hideAsync: jest.fn(async () => undefined),
}));
import * as mockSplash from "expo-splash-screen";
import { Cover, holdNativeSplash, T } from "../src/Cover";
import es from "../src/messages/es.json";

const TAGLINE = es.coverTagline;
const motion = (reduce: boolean) => jest.spyOn(AccessibilityInfo, "isReduceMotionEnabled").mockResolvedValue(reduce);
const settle = async (ms: number) => { await act(async () => { jest.advanceTimersByTime(ms); }); };

describe("cover", () => {
  beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); });
  afterEach(() => { jest.useRealTimers(); });

  it("keeps the native splash until its first frame, with a short fade", () => {
    holdNativeSplash();
    expect(mockSplash.preventAutoHideAsync).toHaveBeenCalledTimes(1);
    expect(mockSplash.setOptions).toHaveBeenCalledWith({ duration: 180, fade: true });
  });

  it("shows the wordmark and tagline, hides the native splash on layout, then opens by itself", async () => {
    motion(false);
    const onDone = jest.fn();
    await render(<Cover tagline={TAGLINE} onDone={onDone} />);
    expect(screen.getByText("AUREA")).toBeTruthy();
    expect(screen.getByText(TAGLINE)).toBeTruthy();
    await fireEvent(screen.getByTestId("cover"), "layout", { nativeEvent: { layout: {} } });
    expect(mockSplash.hideAsync).toHaveBeenCalled();
    // (The test renderer runs animations on its own clock, so only the outcome is checked, not timing.)
    await settle(T.enter + T.hold + T.exit + 200);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("a tap skips it, once", async () => {
    motion(false);
    const onDone = jest.fn();
    await render(<Cover tagline={TAGLINE} onDone={onDone} />);
    await fireEvent.press(screen.getByRole("button", { name: "AUREA" }));
    await fireEvent.press(screen.getByRole("button", { name: "AUREA" }));
    await settle(T.exit + 50);
    expect(onDone).toHaveBeenCalledTimes(1);
    await settle(T.enter + T.hold + T.exit);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("with remove animations on, holds the finished cover briefly and fades out", async () => {
    motion(true);
    const onDone = jest.fn();
    await render(<Cover tagline={TAGLINE} onDone={onDone} />);
    await settle(T.hold + T.exit + 50);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
