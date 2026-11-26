// The cover: the first thing the customer sees. Android draws the native splash (obsidian ground, the
// ring mark from assets/brand/splash.png) before any JavaScript runs; this view takes over on the very
// first frame with the same mark at the same place, so the hand-off is invisible, then lifts the mark,
// sets the wordmark under it and opens onto the app. About a second and a half, a tap skips it, and
// with "remove animations" on it shows the finished cover and fades straight out. Only opacity and
// transforms are animated (native driver), so it never blocks the JS thread the app is starting on.
import tokens from "@aurea/tokens";
import * as SplashScreen from "expo-splash-screen";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo, Animated, Easing, Image, Pressable, StyleSheet, Text, View } from "react-native";
import { c, fonts, s, type } from "./ui";

/** Must match the expo-splash-screen `imageWidth` in app.json: the mark does not move at hand-off. */
export const MARK_DP = 120;
const LIFT_DP = 40;
/** Timeline (ms): the mark lifts and the wordmark settles, a short hold, then the cover opens. */
export const T = { enter: 520, line: 360, hold: 560, exit: 320 } as const;
const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1); // exponential ease-out: quick start, long soft landing

/** Keep the native splash up until the cover has drawn its first frame. Called once at startup. */
export function holdNativeSplash(): void {
  SplashScreen.setOptions({ duration: 180, fade: true });
  SplashScreen.preventAutoHideAsync().catch(() => undefined);
}

export function Cover({ tagline, onDone }: { tagline: string; onDone: () => void }) {
  const progress = useRef(new Animated.Value(0)).current; // 0 → 1: the mark lifts, words settle
  const line = useRef(new Animated.Value(0)).current; // the gold hairline draws out
  const exit = useRef(new Animated.Value(1)).current; // the whole cover fades away
  const [leaving, setLeaving] = useState(false);
  const done = useRef(false);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    setLeaving(true);
    Animated.timing(exit, { toValue: 0, duration: T.exit, easing: Easing.out(Easing.quad), useNativeDriver: true }).start(() => onDone());
  };

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    AccessibilityInfo.isReduceMotionEnabled().catch(() => false).then((reduce) => {
      if (cancelled) return;
      if (reduce) {
        // No travel: the finished cover, a moment to read it, then a plain fade.
        progress.setValue(1);
        line.setValue(1);
        timer = setTimeout(finish, T.hold);
        return;
      }
      Animated.sequence([
        Animated.parallel([
          Animated.timing(progress, { toValue: 1, duration: T.enter, easing: EASE_OUT, useNativeDriver: true }),
          Animated.timing(line, { toValue: 1, delay: T.enter / 2, duration: T.line, easing: EASE_OUT, useNativeDriver: true }),
        ]),
        Animated.delay(T.hold),
      ]).start(({ finished }) => { if (finished) finish(); });
    });
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lift = progress.interpolate({ inputRange: [0, 1], outputRange: [0, -LIFT_DP] });
  const words = progress.interpolate({ inputRange: [0, 0.35, 1], outputRange: [0, 0, 1] });
  const settle = progress.interpolate({ inputRange: [0, 1], outputRange: [s[2], 0] });

  return (
    <Animated.View style={[StyleSheet.absoluteFill, cover.root, { opacity: exit }]} pointerEvents={leaving ? "none" : "auto"} testID="cover"
      // The native splash fades out only once this frame is on screen, so there is never a black flash.
      onLayout={() => SplashScreen.hideAsync().catch(() => undefined)}>
      <Pressable style={StyleSheet.absoluteFill} onPress={finish} accessibilityRole="button" accessibilityLabel="AUREA"
        accessibilityHint={tagline}>
        <View style={cover.center} pointerEvents="none">
          <Animated.View style={{ transform: [{ translateY: lift }] }}>
            <Image source={require("../assets/brand/mark.png")} style={cover.mark} accessibilityIgnoresInvertColors />
          </Animated.View>
          <Animated.View style={[cover.words, { opacity: words, transform: [{ translateY: Animated.add(lift, settle) }] }]}>
            <Text style={cover.wordmark} allowFontScaling={false}>AUREA</Text>
            <Animated.View style={[cover.line, { transform: [{ scaleX: line }] }]} />
            <Animated.Text style={[cover.tagline, { opacity: line }]}>{tagline}</Animated.Text>
          </Animated.View>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const cover = StyleSheet.create({
  root: { backgroundColor: tokens.palette.obsidian, zIndex: 10, elevation: 10 },
  // The mark sits dead centre, where the native splash drew it; the words hang below it.
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  mark: { width: MARK_DP, height: MARK_DP },
  words: { position: "absolute", top: "50%", marginTop: MARK_DP / 2 - s[2], alignItems: "center", gap: s[2] },
  // Wide tracking pulls the five capitals into a single lockup; the trailing space it adds on the
  // last letter is cancelled so the word stays optically centred under the mark.
  wordmark: { fontFamily: fonts.display, color: c.text, fontSize: type[6], letterSpacing: 14, marginRight: -14 },
  line: { width: s[6], height: StyleSheet.hairlineWidth * 2, backgroundColor: c.accent },
  tagline: { color: c.textMuted, fontSize: type[1], letterSpacing: 1 },
});
