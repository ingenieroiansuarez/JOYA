// A WebView stand-in: records what the app posts and lets a test answer as the viewer page would.
import { forwardRef, useImperativeHandle } from "react";
import { View } from "react-native";

export const posted: string[] = [];
let handler: ((e: { nativeEvent: { data: string } }) => void) | null = null;
export function fromPage(msg: unknown) {
  handler?.({ nativeEvent: { data: JSON.stringify(msg) } });
}

const WebView = forwardRef<{ postMessage(d: string): void }, { onMessage?: typeof handler; testID?: string }>(function WebView(props, ref) {
  handler = props.onMessage ?? null;
  useImperativeHandle(ref, () => ({ postMessage: (d: string) => { posted.push(d); } }));
  return <View testID="webview" />;
});
export default WebView;
