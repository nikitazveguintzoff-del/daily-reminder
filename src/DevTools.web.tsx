import { useEffect, useState } from "react";
import { Pressable, Text, View } from "react-native";
import { rpc, rpcLogs as entries } from "./web/rpc";

export function DevTools() {
  const [count, setCount] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setCount(entries.length), 1000);
    return () => clearInterval(timer);
  }, []);
  const download = async () => {
    const service = await rpc<unknown[]>("logs.get", []).catch((error: Error) => [{ error: error.message }]);
    const blob = new Blob([JSON.stringify({ version: "1.2.0", logs: entries, service }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tempo-logs-${Date.now()}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return <View style={{ padding: 8, backgroundColor: "#EBF5F2", gap: 6 }}>
    <Text>Version web locale — connexions mémorisées par le service Tempo (fichier chiffré sur ce PC). Pas de tâche Android ni de notifications.</Text>
    <Pressable onPress={() => void download()}><Text>Exporter les logs ({count} appels + journal du service) — sans identifiants ni contenu scolaire</Text></Pressable>
    <Pressable onPress={() => { entries.length = 0; setCount(0); void rpc("logs.clear", []).catch(() => undefined); }}><Text>Effacer les logs</Text></Pressable>
    <Pressable onPress={() => {
      if (!window.confirm("Oublier toutes les connexions enregistrées par le service web (comptes, jetons, cookies ENT) ?")) return;
      void rpc("session.clear", []).then(() => {
        sessionStorage.clear();
        location.reload();
      }).catch((error: Error) => window.alert(error.message));
    }}><Text>Oublier toutes les connexions et recharger</Text></Pressable>
  </View>;
}
