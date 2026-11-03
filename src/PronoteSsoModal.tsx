import * as Crypto from "expo-crypto";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent, type WebViewNavigation } from "react-native-webview";
import {
  PRONOTE_MOBILE_APP_ID,
  pronoteLog,
  safeTarget,
  type PronoteSsoCapture
} from "./providers/pronoteSso";

type Props = {
  visible: boolean;
  baseUrl: string;
  onCancel: () => void;
  onCaptured: (capture: PronoteSsoCapture) => void;
  onError: (message: string) => void;
};

const MOBILE_USER_AGENT = "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

// Same hook the official mobile app defines: Pronote then exposes a one-time login token.
function hookScript(uuid: string): string {
  return `
    window.hookAccesDepuisAppli = function () {
      this.passerEnModeValidationAppliMobile('', ${JSON.stringify(uuid)});
    };
    true;
  `;
}

function infoPageScript(uuid: string, baseUrl: string): string {
  const expires = (ms: number) => new Date(Date.now() + ms).toUTCString();
  return `
    (function () {
      try {
        var json = JSON.parse(document.body.innerText);
        var cas = json && json.CAS && json.CAS.jetonCAS;
        if (cas) {
          document.cookie = "appliMobile=; expires=${new Date(0).toUTCString()}";
          document.cookie = "validationAppliMobile=" + cas + "; expires=${expires(5 * 60 * 1000)}";
          document.cookie = "uuidAppliMobile=${uuid}; expires=${expires(5 * 60 * 1000)}";
        } else {
          document.cookie = "appliMobile=1; expires=${expires(5 * 60 * 1000)}";
        }
        document.cookie = "ielang=1036; expires=${expires(365 * 24 * 60 * 60 * 1000)}";
        window.location.assign(${JSON.stringify(`${baseUrl}/mobile.parent.html?fd=1`)});
      } catch (error) {}
    })();
    true;
  `;
}

const LOGIN_STATE_SCRIPT = `
  (function () {
    if (window.__tempoLoginWatcher) return;
    window.__tempoLoginWatcher = setInterval(function () {
      var state = window.loginState;
      if (state) {
        window.ReactNativeWebView.postMessage(JSON.stringify({ type: "loginState", data: state }));
      }
    }, 1000);
  })();
  true;
`;

export function PronoteSsoModal({ visible, baseUrl, onCancel, onCaptured, onError }: Props) {
  const [currentHost, setCurrentHost] = useState("");
  const webViewRef = useRef<WebView>(null);
  const finished = useRef(false);
  const uuid = useMemo(() => (visible ? Crypto.randomUUID() : ""), [visible, baseUrl]);
  const infoUrl = `${baseUrl}/InfoMobileApp.json?id=${PRONOTE_MOBILE_APP_ID}`;

  useEffect(() => {
    if (!visible) return;
    finished.current = false;
    setCurrentHost("");
    pronoteLog("webview: opened", { start: safeTarget(infoUrl) });
  }, [visible, infoUrl]);

  const onNavigation = (event: WebViewNavigation) => {
    if (event.loading) return;
    pronoteLog("webview: page loaded", { page: safeTarget(event.url), title: event.title });
    try {
      setCurrentHost(new URL(event.url).host);
    } catch {
      setCurrentHost("");
    }
    if (event.url.startsWith(infoUrl)) {
      webViewRef.current?.injectJavaScript(infoPageScript(uuid, baseUrl));
      return;
    }
    if (event.url.includes("mobile.parent.html")) {
      webViewRef.current?.injectJavaScript(hookScript(uuid));
      webViewRef.current?.injectJavaScript(LOGIN_STATE_SCRIPT);
    }
  };

  const onMessage = (event: WebViewMessageEvent) => {
    if (finished.current) return;
    let message: { type?: string; data?: { status?: number; login?: string; mdp?: string } };
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (message.type !== "loginState" || !message.data) return;
    // Status only: the login and token are never logged.
    pronoteLog("webview: login state received", {
      status: message.data.status,
      hasLogin: Boolean(message.data.login),
      hasToken: Boolean(message.data.mdp)
    });
    if (message.data.status !== 0) return;
    if (!message.data.login || !message.data.mdp) {
      finished.current = true;
      onError("Pronote n’a pas fourni de jeton de connexion.");
      return;
    }
    finished.current = true;
    onCaptured({ url: baseUrl, username: message.data.login, token: message.data.mdp, uuid });
  };
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      <SafeAreaView style={styles.screen} edges={["top", "bottom"]}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title}>Connexion Pronote via l’ENT</Text>
            <Text style={styles.detail}>
              {currentHost || "Connecte-toi à ton ENT."}
            </Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Annuler" onPress={() => {
            pronoteLog("webview: cancelled by user");
            onCancel();
          }} style={styles.cancel}>
            <Text style={styles.cancelText}>Annuler</Text>
          </Pressable>
        </View>
        <WebView
          ref={webViewRef}
          key={uuid}
          source={{ uri: infoUrl }}
          style={styles.webView}
          originWhitelist={["https://*"]}
          userAgent={MOBILE_USER_AGENT}
          incognito
          javaScriptEnabled
          domStorageEnabled
          setSupportMultipleWindows={false}
          thirdPartyCookiesEnabled
          injectedJavaScriptBeforeContentLoaded={hookScript(uuid)}
          onNavigationStateChange={onNavigation}
          onMessage={onMessage}
          onHttpError={(event) => pronoteLog("webview: HTTP error", {
            page: safeTarget(event.nativeEvent.url),
            status: event.nativeEvent.statusCode
          })}
          onError={(event) => pronoteLog("webview: load error", {
            page: safeTarget(event.nativeEvent.url),
            description: event.nativeEvent.description
          })}
        />
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#FFFFFF" },
  header: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderBottomWidth: 1, borderBottomColor: "#DDE5E1" },
  headerText: { flex: 1 },
  title: { fontSize: 16, fontWeight: "700", color: "#17211E" },
  detail: { fontSize: 12, color: "#66736E", marginTop: 2 },
  cancel: { paddingHorizontal: 12, paddingVertical: 8 },
  cancelText: { color: "#16866A", fontWeight: "600" },
  webView: { flex: 1 }
});

