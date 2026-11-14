import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

type Entry = { at: string; level: string; message: string };
const MAX_ENTRIES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const entries: Entry[] = [];
let file: string | undefined;

// Defensive redaction: query strings carry SSO tickets and Pronote session ids.
export function redact(text: string): string {
  return text
    .replace(/(https?:\/\/[^\s?#"'`]+)[?#][^\s"'`]*/gi, "$1?[masqué]")
    .replace(/\/FichiersExternes\/[0-9a-f]+\//gi, "/FichiersExternes/[masqué]/")
    .replace(/\b(Session|token|password|code|ticket|access_token|refresh_token)=([^\s&"']+)/gi, "$1=[masqué]")
    .replace(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]+/g, "[jwt masqué]");
}

function write(level: string, args: unknown[]) {
  const message = redact(args.map((arg) => typeof arg === "string" ? arg : inspect(arg, { depth: 4, breakLength: Infinity })).join(" "));
  const entry = { at: new Date().toISOString(), level, message };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  if (!file) return;
  try {
    try {
      if (statSync(file).size > MAX_FILE_BYTES) renameSync(file, `${file}.1`);
    } catch { /* first write */ }
    appendFileSync(file, `${entry.at} ${level.toUpperCase()} ${message}\n`);
  } catch { /* the console output still carries the line */ }
}

export function installServiceLog(dataDir: string): string {
  mkdirSync(dataDir, { recursive: true });
  file = path.join(dataDir, "service.log");
  for (const level of ["log", "info", "warn", "error"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      write(level, args);
      original(...args);
    };
  }
  return file;
}

export function serviceLogs(): Entry[] {
  return [...entries];
}

export function clearServiceLogs(): void {
  entries.length = 0;
}
