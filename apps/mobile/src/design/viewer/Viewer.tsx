// The 3D preview: a WebView that only ever loads the inlined viewer page (no network, no files, no
// navigation). It shows the GLB_PREVIEW mesh; the label says it is a preview, not the technical solid.
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import WebView, { type WebViewMessageEvent, type WebViewProps } from "react-native-webview";
import { c, s, styles } from "../../ui";
import { VIEWER_HTML } from "./viewer.generated";

// react-native-webview 14 declares `WebView<P = undefined>` with props `WebViewProps & P`, which is
// `never` for P = undefined under strict TypeScript; this alias restores the real prop types.
interface WebViewHandle { postMessage(data: string): void }
const Web = WebView as unknown as React.ComponentType<WebViewProps & { ref?: React.Ref<WebViewHandle> }>;

export type ViewerState = "starting" | "empty" | "loading" | "shown" | "error";

/** A snapshot is a small JPEG data URL from the viewer page; anything else is dropped. */
export const SNAPSHOT_PREFIX = "data:image/jpeg;base64,";
export const SNAPSHOT_MAX = 120_000;
export const validSnapshot = (d: unknown): d is string =>
  typeof d === "string" && d.startsWith(SNAPSHOT_PREFIX) && d.length <= SNAPSHOT_MAX && /^[A-Za-z0-9+/=]+$/.test(d.slice(SNAPSHOT_PREFIX.length));

export function Viewer({ glb, color, label, height = 300, emptyText, errorText, loadingText, onSnapshot }: {
  glb: string | null; color: string; label: string; height?: number; emptyText: string; errorText: string; loadingText: string;
  /** Called with a picture once a mesh is shown: the mesh and colour it was taken with, and the JPEG data URL. */
  onSnapshot?: (shown: { glb: string; color: string }, jpeg: string) => void;
}) {
  const shown = useRef<{ glb: string; color: string; seq: number } | null>(null);
  const snap = useRef(onSnapshot);
  snap.current = onSnapshot;
  const ref = useRef<WebViewHandle>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<ViewerState>("starting");

  useEffect(() => {
    if (!ready) return;
    if (!glb) { setState("empty"); return; }
    setState("loading");
    const seq = (shown.current?.seq ?? 0) + 1;
    shown.current = { glb, color, seq };
    ref.current?.postMessage(JSON.stringify({ type: "show", glb, color, snap: !!snap.current, seq }));
  }, [ready, glb, color]);

  const onMessage = (e: WebViewMessageEvent) => {
    let msg: { type?: string; data?: unknown; seq?: unknown };
    try { msg = JSON.parse(e.nativeEvent.data) as typeof msg; } catch { return; }
    if (msg.type === "ready") setReady(true);
    else if (msg.type === "shown") setState("shown");
    else if (msg.type === "error") setState("error");
    // Only the picture of the mesh shown now: one of an earlier mesh (seq behind) is dropped.
    else if (msg.type === "snapshot" && shown.current && msg.seq === shown.current.seq && validSnapshot(msg.data)) snap.current?.({ glb: shown.current.glb, color: shown.current.color }, msg.data);
  };

  const overlay = state === "error" ? errorText : state === "empty" ? emptyText : state === "shown" ? null : loadingText;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={overlay ? `${label}. ${overlay}` : label} style={[v.box, { height }]}>
      <Web
        ref={ref}
        source={{ html: VIEWER_HTML }}
        originWhitelist={["about:blank"]}
        onShouldStartLoadWithRequest={(r: { url: string }) => r.url === "about:blank"}
        onMessage={onMessage}
        onError={() => setState("error")}
        javaScriptEnabled
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        setSupportMultipleWindows={false}
        cacheEnabled={false}
        incognito
        style={v.web}
        importantForAccessibility="no-hide-descendants"
      />
      {overlay && (
        <View style={v.overlay} pointerEvents="none">
          <Text accessibilityLiveRegion="polite" style={[styles.muted, { color: state === "error" ? c.danger : c.textMuted }]}>{overlay}</Text>
        </View>
      )}
    </View>
  );
}

const v = StyleSheet.create({
  box: { borderRadius: 12, overflow: "hidden", backgroundColor: c.surface },
  web: { flex: 1, backgroundColor: "#0c0c0d" },
  overlay: { ...StyleSheet.absoluteFill, alignItems: "center", justifyContent: "center", padding: s[4] },
});
