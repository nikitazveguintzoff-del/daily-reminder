import { createElement } from "react";
export function WebView({ source }: { source: { html?: string }; [key: string]: unknown }) {
  return createElement("iframe", {
    title: "Détail du devoir", srcDoc: source.html, sandbox: "",
    style: { border: 0, width: "100%", height: "100%", flex: 1 }
  });
}
