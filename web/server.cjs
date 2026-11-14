// Tempo local web service.
//   npm run web      -> builds the web app, then serves UI + API on http://127.0.0.1:8787 (same origin).
//   npm run web:dev  -> API on 8787 and Expo hot reload on http://localhost:8081.
const { build } = require("esbuild");
const { createServer } = require("node:http");
const { randomBytes } = require("node:crypto");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const dev = process.argv.includes("--dev");
const skipBuild = process.argv.includes("--no-build");
const port = Number(process.env.TEMPO_WEB_PORT) || 8787;
const token = randomBytes(32).toString("hex");
const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const expoCli = require.resolve("expo/bin/cli");
const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
const origins = new Set(dev
  ? ["http://localhost:8081", "http://127.0.0.1:8081"]
  : [...hosts].map((host) => `http://${host}`));
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".ttf": "font/ttf", ".woff": "font/woff", ".woff2": "font/woff2", ".map": "application/json"
};

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--use-system-ca", expoCli, ...args], { cwd: root, stdio: "inherit", env });
    child.on("exit", (code) => code ? reject(new Error(`expo ${args[0]} a échoué (${code}).`)) : resolve());
    child.on("error", reject);
  });
}

function cookieToken(header = "") {
  return header.split(";").map((part) => part.trim().split("=")).find(([name]) => name === "tempo_token")?.[1];
}

function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
  const pathname = decodeURIComponent(new URL(req.url, "http://local").pathname);
  let file = path.join(dist, path.normalize(pathname));
  if (!file.startsWith(dist + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(dist, "index.html");
  }
  const extension = path.extname(file);
  const headers = { "Content-Type": types[extension] || "application/octet-stream", "X-Content-Type-Options": "nosniff" };
  if (extension === ".html") {
    // Same-site cookie only readable by the service: the page itself never sees the API secret.
    headers["Set-Cookie"] = `tempo_token=${token}; HttpOnly; SameSite=Strict; Path=/`;
    headers["Cache-Control"] = "no-store";
    headers["Content-Security-Policy"] = "frame-ancestors 'none'";
  }
  res.writeHead(200, headers);
  if (req.method === "HEAD") res.end(); else fs.createReadStream(file).pipe(res);
}

async function main() {
  const outfile = path.join(root, ".expo", "web-service.cjs");
  await build({
    entryPoints: [path.join(__dirname, "service.ts")], outfile, bundle: true, platform: "node", format: "cjs",
    external: ["playwright"],
    alias: { "expo-secure-store": path.join(__dirname, "persistentStore.cjs") }
  });
  const service = require(outfile);
  service.initStorage();
  console.info(`Données web chiffrées : ${service.dataDir}`);
  console.info(`Journal du service : ${service.installServiceLog(service.dataDir)}`);
  if (!dev && !skipBuild) {
    const env = { ...process.env };
    delete env.EXPO_PUBLIC_TEMPO_RPC_URL;
    delete env.EXPO_PUBLIC_TEMPO_DEV_TOKEN;
    await run(["export", "--platform", "web"], env);
  }
  if (!dev && !fs.existsSync(path.join(dist, "index.html"))) throw new Error("dist\\index.html absent : lance « npm run web » sans --no-build.");

  const server = createServer(async (req, res) => {
    if (!hosts.has(req.headers.host)) { res.writeHead(403).end(); return; }
    res.setHeader("Cache-Control", "no-store");
    if (req.url !== "/rpc") {
      if (dev) res.writeHead(404).end(); else serveStatic(req, res);
      return;
    }
    const origin = req.headers.origin;
    if (!origins.has(origin)) { res.writeHead(403).end(); return; }
    if (dev) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Tempo-Dev-Token");
        res.setHeader("Access-Control-Allow-Methods", "POST");
        res.writeHead(204).end(); return;
      }
    }
    const presented = dev ? req.headers["x-tempo-dev-token"] : cookieToken(req.headers.cookie);
    if (req.method !== "POST" || presented !== token) { res.writeHead(403).end(); return; }
    let method = "invalid";
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 2 * 1024 * 1024) throw new Error("Requête trop volumineuse.");
      }
      const request = JSON.parse(body);
      if (typeof request.method !== "string" || !Array.isArray(request.args)) throw new Error("Requête invalide.");
      method = request.method;
      const started = Date.now();
      const value = await service.dispatch(method, request.args);
      if (!method.startsWith("store.")) console.info(`[WEB-RPC] ${method} completed (${Date.now() - started} ms)`);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ value }));
    } catch (error) {
      // No request/response bodies, account details, cookies or tokens in diagnostics.
      const code = error.code || error.cause?.code;
      const certificateError = [
        "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"
      ].includes(code);
      const message = certificateError
        ? "Certificat HTTPS non reconnu. Redémarre le service avec « npm run web » pour utiliser les certificats système ; si l'erreur persiste, fais vérifier la chaîne de certificats par ton administrateur."
        : error.message;
      console.error(`[WEB-RPC] ${method} failed (${code || error.name || "Error"})`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message, code }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  let child;
  const shutdown = () => {
    child?.kill();
    void service.shutdown().catch(console.error);
    server.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (!dev) {
    console.info(`Tempo web : http://127.0.0.1:${port}`);
    return;
  }
  console.info(`API Tempo : http://127.0.0.1:${port}/rpc — interface : http://localhost:8081`);
  child = spawn(process.execPath, ["--use-system-ca", expoCli, "start", "--web", "--localhost", "--port", "8081"], {
    cwd: root, stdio: "inherit",
    env: { ...process.env, EXPO_PUBLIC_TEMPO_DEV_TOKEN: token, EXPO_PUBLIC_TEMPO_RPC_URL: `http://127.0.0.1:${port}/rpc` }
  });
  child.on("exit", (code) => {
    shutdown();
    process.exitCode = code || 0;
  });
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
