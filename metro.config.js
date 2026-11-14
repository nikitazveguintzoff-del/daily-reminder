const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const nodeAliases = new Map([
  ["node:crypto", require.resolve("react-native-quick-crypto")],
  ["node:zlib", path.resolve(__dirname, "src/providers/nodeZlib.js")],
  ["node:fs/promises", path.resolve(__dirname, "src/providers/nodeFsPromises.js")],
  ["@noble/hashes/crypto", path.resolve(__dirname, "node_modules/@noble/hashes/crypto.js")],
  ["cheerio", path.resolve(__dirname, "node_modules/cheerio/dist/browser/index.js")]
]);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const webAliases = {
    "expo-secure-store": "src/web/secureStore.js",
    "expo-web-browser": "src/web/authSession.ts",
    "react-native-webview": "src/web/WebView.tsx"
  };
  if (platform === "web" && webAliases[moduleName]) {
    return { type: "sourceFile", filePath: path.resolve(__dirname, webAliases[moduleName]) };
  }
  const replacement = nodeAliases.get(moduleName);
  if (replacement) return { type: "sourceFile", filePath: replacement };
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;