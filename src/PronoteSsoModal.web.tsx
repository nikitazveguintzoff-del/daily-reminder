import { useEffect } from "react";
import type { ComponentProps } from "react";
import type { PronoteSsoModal as NativeModal } from "./PronoteSsoModal";
import { rpc } from "./web/rpc";
import type { PronoteSsoCapture } from "./providers/pronoteSso";
import { Modal, Pressable, Text, View } from "react-native";

export function PronoteSsoModal(props: ComponentProps<typeof NativeModal>) {
  const { visible, baseUrl, onCaptured, onError } = props;
  useEffect(() => {
    if (!visible) return;
    let active = true;
    rpc<PronoteSsoCapture>("auth.pronote", [baseUrl]).then((capture) => {
      if (active) onCaptured(capture);
    }).catch((error: Error) => { if (active) onError(error.message); });
    return () => { active = false; void rpc("auth.cancel", []).catch(console.error); };
  }, [visible, baseUrl]);
  return <Modal visible={visible} transparent>
    <View style={{ margin: 40, padding: 24, backgroundColor: "white" }}>
      <Text>Connecte-toi dans la fenêtre de navigateur ouverte par le service Tempo (les cookies ENT y sont conservés).</Text>
      <Pressable onPress={props.onCancel}><Text>Annuler</Text></Pressable>
    </View>
  </Modal>;
}
