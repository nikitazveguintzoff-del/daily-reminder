import { useEffect, useState } from "react";
import { AppState, StyleSheet, View } from "react-native";
import { WebView } from "react-native-webview";
import { completeWebViewPhoto, subscribeWebViewPhotoRequests, type WebViewPhotoRequest } from "./photos";

const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

// La page chargée est l'image elle-même : le canvas n'est donc pas « tainted » et on peut l'exporter.
const EXTRACT_SCRIPT = `
(function () {
  var send = function (value) { window.ReactNativeWebView.postMessage(value); };
  var run = function () {
    var img = document.images[0];
    if (!img || !img.naturalWidth) { send(""); return; }
    var scale = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
    var canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    try { send(canvas.toDataURL("image/jpeg", 0.85)); } catch (e) { send(""); }
  };
  if (document.readyState === "complete") run(); else window.addEventListener("load", run);
})();
true;
`;

export function PhotoWebViewHost() {
  const [requests, setRequests] = useState<WebViewPhotoRequest[]>([]);
  useEffect(() => {
    let unsubscribe = () => {};
    const update = (state: string) => {
      unsubscribe();
      unsubscribe = state === "active" ? subscribeWebViewPhotoRequests(setRequests) : () => {};
    };
    update(AppState.currentState);
    const subscription = AppState.addEventListener("change", update);
    return () => { unsubscribe(); subscription.remove(); };
  }, []);

  return (
    <View pointerEvents="none" style={styles.host}>
      {requests.map((request) => (
        <WebView
          key={request.id}
          source={{ uri: request.url, headers: request.headers }}
          userAgent={request.headers["User-Agent"] || USER_AGENT}
          injectedJavaScript={EXTRACT_SCRIPT}
          onMessage={(event) => {
            const data = event.nativeEvent.data;
            console.info("[PHOTO-WEBVIEW] Message reçu.", { ok: data.startsWith("data:image/"), length: data.length });
            completeWebViewPhoto(request.id, data.startsWith("data:image/") ? data : undefined);
          }}
          onError={(event) => {
            console.warn("[PHOTO-WEBVIEW] Erreur de chargement.", {
              code: event.nativeEvent.code,
              description: event.nativeEvent.description
            });
            completeWebViewPhoto(request.id, undefined);
          }}
          onHttpError={(event) => {
            console.warn("[PHOTO-WEBVIEW] Erreur HTTP.", {
              statusCode: event.nativeEvent.statusCode,
              description: event.nativeEvent.description
            });
            completeWebViewPhoto(request.id, undefined);
          }}
          style={styles.webView}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  host: { position: "absolute", width: 2, height: 2, opacity: 0, overflow: "hidden" },
  webView: { width: 2, height: 2 }
});
