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

export function Viewer({ glb, color, label, height = 300, emptyText, errorText, loadingText }: {
  glb: string | null; color: string; label: string; height?: number; emptyText: string; errorText: string; loadingText: string;
}) {
  const ref = useRef<WebViewHandle>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<ViewerState>("starting");

  useEffect(() => {
    if (!ready) return;
    if (!glb) { setState("empty"); return; }
    setState("loading");
    ref.current?.postMessage(JSON.stringify({ type: "show", glb, color }));
  }, [ready, glb, color]);

  const onMessage = (e: WebViewMessageEvent) => {
    let msg: { type?: string };
    try { msg = JSON.parse(e.nativeEvent.data) as { type?: string }; } catch { return; }
    if (msg.type === "ready") setReady(true);
    else if (msg.type === "shown") setState("shown");
    else if (msg.type === "error") setState("error");
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
