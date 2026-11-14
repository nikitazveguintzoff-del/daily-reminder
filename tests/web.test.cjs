const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chromium, request } = require("playwright");
const { build } = require("esbuild");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = path.join(__dirname, "..");
const browserOptions = {
  headless: true,
  channel: process.env.TEMPO_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined)
};
const port = 8799;
const base = `http://127.0.0.1:${port}`;

function startService(args, dataDir) {
  const child = spawn(process.execPath, ["--use-system-ca", path.join(root, "web", "server.cjs"), ...args], {
    cwd: root, env: { ...process.env, TEMPO_WEB_DATA: dataDir, TEMPO_WEB_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  return new Promise((resolve, reject) => {
    const collect = (chunk) => {
      output += chunk;
      if (output.includes(`Tempo web : ${base}`)) resolve(child);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("exit", (code) => reject(new Error(`Service arrêté (${code}) :\n${output.slice(-3000)}`)));
  });
}
function stopService(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) { resolve(); return; }
    child.removeAllListeners("exit");
    child.once("exit", resolve);
    child.kill();
  });
}
async function pageRpc(page, method, args) {
  return page.evaluate(async ([method, args]) => {
    const response = await fetch("/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ method, args }) });
    return { status: response.status, body: response.status === 200 ? await response.json() : null };
  }, [method, args]);
}
async function loadService(fixture, dataDir) {
  process.env.TEMPO_WEB_DATA = dataDir;
  const mocks = { playwright: "module.exports = { chromium: fixture.chromium };" };
  if (fixture.school) mocks.school = "module.exports = fixture.school;";
  const result = await build({
    entryPoints: [path.join(root, "web", "service.ts")], bundle: true, write: false, platform: "node", format: "cjs",
    alias: { "expo-secure-store": path.join(root, "web", "persistentStore.cjs") },
    plugins: [{
      name: "fixtures",
      setup(builder) {
        builder.onResolve({ filter: /^playwright$/ }, () => ({ path: "playwright", namespace: "mock" }));
        if (fixture.school) builder.onResolve({ filter: /providers\/schoolServices$/ }, () => ({ path: "school", namespace: "mock" }));
        builder.onLoad({ filter: /.*/, namespace: "mock" }, (args) => ({ contents: mocks[args.path], loader: "js" }));
      }
    }]
  });
  const module = { exports: {} };
  new Function("module", "exports", "require", "fixture", result.outputFiles[0].text)(module, module.exports, require, fixture);
  return module.exports;
}

test("real web service: cookie-guarded API, encrypted storage kept across restarts, Skolengo search and log export", { timeout: 600_000 }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tempo-web-"));
  let service = await startService([], dataDir);
  const browser = await chromium.launch(browserOptions);
  try {
    const anonymous = await request.newContext();
    const denied = await anonymous.post(`${base}/rpc`, { headers: { Origin: base }, data: { method: "store.get", args: ["tempo-web-test"] } });
    assert.equal(denied.status(), 403);
    await anonymous.dispose();

    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(base);
    await page.getByText("Exporter les logs", { exact: false }).waitFor();
    assert.equal(await page.evaluate(() => document.cookie.includes("tempo_token")), false);

    assert.equal((await pageRpc(page, "store.set", ["tempo-web-test", "persisted-secret-value"])).status, 200);
    assert.equal((await pageRpc(page, "store.set", ["not-a-tempo-key", "x"])).status, 400);
    assert.equal(fs.readFileSync(path.join(dataDir, "store.enc"), "utf8").includes("persisted-secret-value"), false);

    await page.getByRole("tab", { name: "Compte", exact: true }).click();
    await page.getByText("Skolengo", { exact: true }).first().click();
    await page.getByPlaceholder(/établissement/i).fill("Paris");
    const search = page.waitForResponse((response) => response.url().endsWith("/rpc") && response.request().postData().includes("searchSkolengoSchools"));
    await page.getByRole("button", { name: /rechercher/i }).click();
    const found = await (await search).json();
    assert.ok(Array.isArray(found.value) && found.value.length > 0, JSON.stringify(found).slice(0, 300));

    const downloadPromise = page.waitForEvent("download");
    await page.getByText("Exporter les logs", { exact: false }).click();
    let text = "";
    for await (const chunk of await (await downloadPromise).createReadStream()) text += chunk;
    assert.ok(JSON.parse(text).logs.some((entry) => entry.method === "school.searchSkolengoSchools" && entry.succeeded));
    assert.equal(text.includes("Paris"), false);
    assert.equal(text.includes("persisted-secret-value"), false);
    assert.deepEqual(errors, []);

    await stopService(service);
    service = await startService(["--no-build"], dataDir);
    assert.equal((await pageRpc(page, "store.get", ["tempo-web-test"])).status, 403);
    await page.reload();
    assert.equal((await pageRpc(page, "store.get", ["tempo-web-test"])).body.value, "persisted-secret-value");
  } finally {
    await browser.close();
    await stopService(service);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("service reuses live Pronote/Skolengo sessions on reload and follows token rotation", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tempo-web-"));
  const calls = { pronote: 0, skolengo: 0 };
  let failData = false;
  const school = {
    restorePronote: async (token) => ({ session: { n: ++calls.pronote }, url: "u", parentName: "P", refreshToken: `${token}-renewed`, students: [] }),
    fetchPronoteData: async (_session, _id, _date, _days, save) => {
      await save("rotated");
      if (failData) throw new Error("synthetic failure");
      return { ok: true };
    },
    restoreSkolengoLogin: async (token) => ({ account: { refreshToken: `${token}-sko`, n: ++calls.skolengo }, students: [] }),
    fetchSkolengoData: async (account, _id, _date, _days, save) => {
      account.refreshToken = "sko-rotated";
      await save(account.refreshToken);
      return { ok: true };
    }
  };
  try {
    const { dispatch } = await loadService({ chromium: {}, school }, dataDir);
    const first = await dispatch("school.restorePronote", ["t0"]);
    const reload = await dispatch("school.restorePronote", ["t0-renewed"]);
    assert.equal(calls.pronote, 1);
    assert.equal(reload.session.remoteId, first.session.remoteId);
    assert.equal((await dispatch("school.fetchPronoteData", [first.session, "s", new Date().toISOString(), 1])).refreshToken, "rotated");
    const afterRotation = await dispatch("school.restorePronote", ["rotated"]);
    assert.equal(calls.pronote, 1);
    assert.equal(afterRotation.refreshToken, "rotated");
    failData = true;
    assert.ok((await dispatch("school.fetchPronoteData", [first.session, "s", new Date().toISOString(), 1])).error);
    await dispatch("school.restorePronote", ["rotated"]);
    assert.equal(calls.pronote, 2);

    const sko = await dispatch("school.restoreSkolengoLogin", ["r0", {}]);
    await dispatch("school.fetchSkolengoData", [sko.account, "s", new Date().toISOString(), 1]);
    const skoReload = await dispatch("school.restoreSkolengoLogin", ["sko-rotated", {}]);
    assert.equal(calls.skolengo, 1);
    assert.equal(skoReload.account.refreshToken, "sko-rotated");
    assert.equal(skoReload.account.remoteId, sko.account.remoteId);

    await dispatch("store.set", ["tempo-provider-token-test", "secret"]);
    await dispatch("session.clear", []);
    assert.equal(await dispatch("store.get", ["tempo-provider-token-test"]), null);
    await assert.rejects(dispatch("school.fetchPronoteData", [first.session, "s", new Date().toISOString(), 1]), /recharge la page/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// Self-signed HTTPS server standing in for an ENT/EduConnect -> OIDC chain ending in an HTTP 302 to the app scheme.
async function startOidcServer() {
  const forge = require("node-forge");
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = "01";
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 3_600_000);
  cert.setSubject([{ name: "commonName", value: "sko.invalid" }]);
  cert.setIssuer([{ name: "commonName", value: "sko.invalid" }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  const server = require("node:https").createServer({
    key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert)
  }, (req, res) => {
    const location = req.url.startsWith("/educonnect") ? "/authorize" : "skoapp-prod://sign-in-callback?code=http-code&state=http-state";
    res.writeHead(302, { Location: location }).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

test("persistent SSO profile captures custom-scheme Skolengo redirects and Pronote tokens", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tempo-web-"));
  const oidc = await startOidcServer();
  let intercept = true;
  const fixture = {
    chromium: {
      launchPersistentContext: async (profile, options) => {
        assert.ok(profile.startsWith(dataDir));
        const context = await chromium.launchPersistentContext(profile, {
          ...options, headless: true, ignoreHTTPSErrors: true,
          args: [`--host-resolver-rules=MAP sko.invalid 127.0.0.1:${oidc.address().port}`]
        });
        // Request interception hides custom-scheme redirects, so the HTTP 302 case runs without it.
        if (!intercept) return context;
        await context.route("https://school.invalid/**", async (route) => {
          const url = route.request().url();
          if (url.includes("InfoMobileApp.json")) {
            await route.fulfill({ json: { CAS: { jetonCAS: "synthetic-ticket" } } });
          } else {
            await route.fulfill({
              contentType: "text/html",
              body: url.includes("/oauth")
                ? '<script>location.href="skoapp-prod://sign-in-callback?code=synthetic-code&state=synthetic-state"</script>'
                : '<script>setTimeout(()=>{window.loginState={status:0,login:"synthetic-user",mdp:"synthetic-token"}},800)</script>'
            });
          }
        });
        return context;
      }
    }
  };
  try {
    const { dispatch } = await loadService(fixture, dataDir);
    assert.equal(await dispatch("auth.skolengo", ["https://school.invalid/oauth", "skoapp-prod://sign-in-callback"]),
      "skoapp-prod://sign-in-callback?code=synthetic-code&state=synthetic-state");
    const capture = await dispatch("auth.pronote", ["https://school.invalid/pronote"]);
    assert.equal(capture.username, "synthetic-user");
    assert.equal(capture.token, "synthetic-token");
    assert.ok(capture.uuid);
    intercept = false;
    assert.equal(await dispatch("auth.skolengo", ["https://sko.invalid/educonnect", "skoapp-prod://sign-in-callback"]),
      "skoapp-prod://sign-in-callback?code=http-code&state=http-state");
    assert.ok(fs.existsSync(path.join(dataDir, "auth-profile")));
  } finally {
    oidc.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});