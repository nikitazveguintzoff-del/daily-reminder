// Durable, encrypted key/value store shared by the browser UI and the provider code of the web service.
const { createCipheriv, createDecipheriv, randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const dataDir = process.env.TEMPO_WEB_DATA
  || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".local", "share"), "Tempo", "web");
const storeFile = path.join(dataDir, "store.enc");
const keyFile = path.join(dataDir, process.platform === "win32" ? "key.dpapi" : "key.bin");

// On Windows the AES key is protected by DPAPI for the current Windows user, not stored in clear.
function dpapi(operation, value) {
  const script = "Add-Type -AssemblyName System.Security;"
    + `$v=[Security.Cryptography.ProtectedData]::${operation}([Convert]::FromBase64String($env:TEMPO_DPAPI_IN),$null,'CurrentUser');`
    + "[Convert]::ToBase64String($v)";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, TEMPO_DPAPI_IN: value.toString("base64") }, encoding: "utf8", windowsHide: true
  });
  if (result.status !== 0) throw new Error(`Protection DPAPI indisponible : ${(result.stderr || "").trim()}`);
  return Buffer.from(result.stdout.trim(), "base64");
}

function loadKey() {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  if (fs.existsSync(keyFile)) {
    const raw = fs.readFileSync(keyFile);
    return process.platform === "win32" ? dpapi("Unprotect", raw) : raw;
  }
  const key = randomBytes(32);
  fs.writeFileSync(keyFile, process.platform === "win32" ? dpapi("Protect", key) : key, { mode: 0o600 });
  return key;
}

let key;
let values;
function load() {
  if (values) return values;
  key = loadKey();
  values = new Map();
  if (fs.existsSync(storeFile)) {
    const { iv, tag, data } = JSON.parse(fs.readFileSync(storeFile, "utf8"));
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const json = Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    values = new Map(Object.entries(JSON.parse(json)));
  }
  return values;
}

let writing = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(Object.fromEntries(load()));
  writing = writing.then(() => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const data = Buffer.concat([cipher.update(snapshot, "utf8"), cipher.final()]);
    const temporary = `${storeFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({
      v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64")
    }), { mode: 0o600 });
    fs.renameSync(temporary, storeFile);
  });
  return writing;
}

exports.dataDir = dataDir;
exports.getItemAsync = async (name) => load().get(name) ?? null;
exports.setItemAsync = async (name, value) => { load().set(name, String(value)); await save(); };
exports.deleteItemAsync = async (name) => { if (load().delete(name)) await save(); };
exports.clear = async () => { load().clear(); await save(); };
exports.init = () => { load(); };
