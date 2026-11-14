import * as ed from "../src/ecoleDirecte";
import * as school from "../src/providers/schoolServices";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright";
import { PRONOTE_MOBILE_APP_ID, pronoteBaseUrl, safeTarget } from "../src/providers/pronoteSso";
import type { School } from "skolengojs";
import { School as SkolengoSchool } from "skolengojs";
import * as storage from "./persistentStore.cjs";
import type { TokenResponse } from "../src/web/rpc";
import { clearServiceLogs, installServiceLog, serviceLogs } from "./serviceLog";

const SESSION_EXPIRED = "Service web redémarré ou session expirée : recharge la page pour restaurer les connexions enregistrées.";
const objects = new Map<string, unknown>();
function store<T>(value: T): { remoteId: string } {
  const remoteId = randomUUID();
  objects.set(remoteId, value);
  return { remoteId };
}
function read<T>(reference: { remoteId: string }): T {
  if (!reference || !objects.has(reference.remoteId)) throw Object.assign(new Error(SESSION_EXPIRED), { code: "SESSION_EXPIRED" });
  touch(reference.remoteId);
  return objects.get(reference.remoteId) as T;
}

// Live provider sessions stay open in the service and are reused when a page reload "restores"
// with the current token, so single-use Pronote tokens and Skolengo refresh tokens are not burnt.
type LiveSession = { remoteId: string; result: unknown; token: string; usedAt: number };
const LIVE_IDLE_MS = 20 * 60 * 1000;
const liveByToken = new Map<string, LiveSession>();
const liveById = new Map<string, LiveSession>();
function remember(remoteId: string, token: string, result: unknown) {
  const live = { remoteId, token, result, usedAt: Date.now() };
  liveByToken.set(token, live);
  liveById.set(remoteId, live);
}
function reuse(token: string): LiveSession | undefined {
  const live = liveByToken.get(token);
  if (!live) return undefined;
  if (Date.now() - live.usedAt > LIVE_IDLE_MS || !objects.has(live.remoteId)) {
    forget(live.remoteId);
    return undefined;
  }
  live.usedAt = Date.now();
  return live;
}
function rotate(remoteId: string, token: string) {
  const live = liveById.get(remoteId);
  if (!live || live.token === token) return;
  liveByToken.delete(live.token);
  live.token = token;
  liveByToken.set(token, live);
}
function touch(remoteId: string) {
  const live = liveById.get(remoteId);
  if (live) live.usedAt = Date.now();
}
function forget(remoteId: string) {
  const live = liveById.get(remoteId);
  if (!live) return;
  liveById.delete(remoteId);
  liveByToken.delete(live.token);
}

function schoolInstance(value: School): School {
  return new SkolengoSchool(value.id, value.name, value.emsCode, value.OIDCWellKnown, value.location, value.homepage, value.UAI, value.subscribedServices);
}
function pronoteResult(result: school.PronoteConnection) {
  const response = { ...result, session: store(result.session) };
  remember(response.session.remoteId, result.refreshToken, response);
  return response;
}
function skolengoResult(result: Awaited<ReturnType<typeof school.restoreSkolengoLogin>>) {
  const account = result.account;
  const response = {
    students: result.students,
    account: { ...store(account), firstName: account.firstName, lastName: account.lastName, userId: account.userId, refreshToken: account.refreshToken }
  };
  remember(response.account.remoteId, account.refreshToken, response);
  return response;
}
async function dataWithToken<T>(remoteId: string, run: (save: (token: string) => Promise<void>) => Promise<T>): Promise<TokenResponse<T>> {
  let refreshToken: string | undefined;
  try {
    const data = await run(async (token) => { refreshToken = token; rotate(remoteId, token); });
    return { data, refreshToken };
  } catch (error) {
    // A failing session must not be handed back on the next reload.
    forget(remoteId);
    return { error: error instanceof Error ? error.message : String(error), refreshToken };
  }
}
function storageKey(value: unknown): string {
  if (typeof value !== "string" || !/^tempo-[\w.-]{1,120}$/.test(value)) throw new Error("Clé de stockage invalide.");
  return value;
}

let authContext: BrowserContext | undefined;
const authProfile = path.join(storage.dataDir, "auth-profile");
function resetSessions() {
  objects.clear();
  liveByToken.clear();
  liveById.clear();
}
export const initStorage = storage.init;
export const dataDir = storage.dataDir;
export { installServiceLog };
export async function shutdown(): Promise<void> {
  resetSessions();
  await authContext?.close();
}

// ENT/SSO cookies are kept in a dedicated persistent browser profile to make later reconnections quick.
async function authenticate(run: (context: BrowserContext) => Promise<unknown>) {
  if (authContext) throw new Error("Une connexion est déjà ouverte.");
  const context = await chromium.launchPersistentContext(authProfile, {
    headless: process.env.TEMPO_AUTH_HEADLESS === "1",
    channel: process.env.TEMPO_BROWSER_CHANNEL || (process.platform === "win32" ? "msedge" : undefined),
    userAgent: "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36"
  });
  authContext = context;
  // Host and path only: query strings carry SSO tickets.
  context.on("framenavigated", (frame) => {
    if (frame === frame.page().mainFrame()) console.info(`[WEB-AUTH] page ${safeTarget(frame.url())}`);
  });
  try { return await run(context); }
  finally {
    if (authContext === context) authContext = undefined;
    await context.close();
  }
}

// Resolves with the first value found by `check` on any tab of the context (ENT flows may open new tabs).
function watchPages<T>(context: BrowserContext, label: string, check: (page: Page) => Promise<T | undefined>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const finish = (error?: Error, value?: T) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      context.off("close", closed);
      if (error) reject(error); else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new Error(`Connexion ${label} expirée après 3 minutes.`)), 180_000);
    const closed = () => finish(new Error(`Connexion ${label} annulée.`));
    context.on("close", closed);
    const poll = setInterval(() => {
      for (const page of context.pages()) {
        check(page).then((value) => { if (value !== undefined) finish(undefined, value); }, () => undefined);
      }
    }, 500);
  });
}

// Explicit operations only; this is not a generic remote invocation endpoint.
export async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case "store.get": return storage.getItemAsync(storageKey(args[0]));
    case "store.set":
      if (typeof args[1] !== "string") throw new Error("Valeur de stockage invalide.");
      await storage.setItemAsync(storageKey(args[0]), args[1]);
      return null;
    case "store.delete": await storage.deleteItemAsync(storageKey(args[0])); return null;
    case "logs.get": return serviceLogs();
    case "logs.clear": clearServiceLogs(); return null;
    case "session.clear":
      resetSessions();
      await authContext?.close();
      await storage.clear();
      await rm(authProfile, { recursive: true, force: true });
      return null;
    case "ed.create": return store(ed.createEdSession()).remoteId;
    case "ed.call": {
      const [remoteId, operation, values] = args as [string, string, unknown[]];
      const session = read<ed.EdSession>({ remoteId });
      let value: unknown, error: string | undefined, code: number | undefined;
      try {
        switch (operation) {
          case "login": value = await ed.login(session, ...values as Parameters<typeof ed.login> extends [unknown, ...infer R] ? R : never); break;
          case "relogin": value = await ed.relogin(session, ...values as Parameters<typeof ed.relogin> extends [unknown, ...infer R] ? R : never); break;
          case "fetchLoginChallenge": value = await ed.fetchLoginChallenge(session); break;
          case "resolveLoginChallenge": value = await ed.resolveLoginChallenge(session, values[0] as string); break;
          case "fetchSchoolData": value = await ed.fetchSchoolData(session, values[0] as number, values[1] as ed.EdPupil, new Date(values[2] as string)); break;
          case "fetchCourseSlots": value = await ed.fetchCourseSlots(session, values[0] as ed.EdPupil, new Date(values[1] as string), new Date(values[2] as string)); break;
          case "fetchStudentsSchoolDataWithAutoAdvance": value = await ed.fetchStudentsSchoolDataWithAutoAdvance(session, values[0] as number, values[1] ? new Date(values[1] as string) : undefined); break;
          default: throw new Error("Opération École Directe inconnue.");
        }
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
        code = (failure as { code?: number }).code;
      }
      const { client: _client, loginResponse: _response, ...snapshot } = session;
      return { session: snapshot, value, error, code };
    }
    case "school.searchSkolengoSchools": return school.searchSkolengoSchools(args[0] as string);
    case "school.startSkolengoLogin": {
      const result = await school.startSkolengoLogin(schoolInstance(args[0] as School));
      return { school: result.school, flow: { ...store(result.flow), loginURL: result.flow.loginURL } };
    }
    case "school.finishSkolengoLogin":
      return skolengoResult(await school.finishSkolengoLogin(read(args[0] as { remoteId: string }), args[1] as string));
    case "school.restoreSkolengoLogin": {
      const live = reuse(args[0] as string);
      if (live) {
        const response = live.result as ReturnType<typeof skolengoResult>;
        return { ...response, account: { ...response.account, refreshToken: live.token } };
      }
      return skolengoResult(await school.restoreSkolengoLogin(args[0] as string, args[1] as School));
    }
    case "school.connectPronoteSso":
      return pronoteResult(await school.connectPronoteSso(args[0] as Parameters<typeof school.connectPronoteSso>[0]));
    case "school.restorePronote": {
      const live = reuse(args[0] as string);
      if (live) return { ...live.result as ReturnType<typeof pronoteResult>, refreshToken: live.token };
      return pronoteResult(await school.restorePronote(args[0] as string));
    }
    case "school.fetchPronoteData": {
      const reference = args[0] as { remoteId: string };
      const session = read<school.PronoteConnection["session"]>(reference);
      return dataWithToken(reference.remoteId, (save) => school.fetchPronoteData(session, args[1] as string, new Date(args[2] as string), args[3] as number, save));
    }
    case "school.fetchSkolengoData": {
      const reference = args[0] as { remoteId: string };
      const account = read<Awaited<ReturnType<typeof school.restoreSkolengoLogin>>["account"]>(reference);
      return dataWithToken(reference.remoteId, (save) => school.fetchSkolengoData(account, args[1] as string, new Date(args[2] as string), args[3] as number, save));
    }
    case "school.fetchPronoteCourseSlots": {
      const reference = args[0] as { remoteId: string };
      const session = read<school.PronoteConnection["session"]>(reference);
      return dataWithToken(reference.remoteId, () => school.fetchPronoteCourseSlots(session, args[1] as string, new Date(args[2] as string), new Date(args[3] as string)));
    }
    case "school.fetchSkolengoCourseSlots": {
      const reference = args[0] as { remoteId: string };
      const account = read<Awaited<ReturnType<typeof school.restoreSkolengoLogin>>["account"]>(reference);
      return dataWithToken(reference.remoteId, (save) => school.fetchSkolengoCourseSlots(account, args[1] as string, new Date(args[2] as string), new Date(args[3] as string), save));
    }
    case "auth.cancel": await authContext?.close(); return null;
    case "auth.skolengo": return authenticate(async (context) => {
      const [url, redirect] = args as [string, string];
      if (!url.startsWith("https://") || redirect !== "skoapp-prod://sign-in-callback") throw new Error("Adresse de connexion invalide.");
      let callbackUrl: string | undefined;
      // The OIDC server returns an HTTP 302 to the custom scheme: only network requests see it, not CDP
      // frameRequestedNavigation (which only covers script navigations). Both are watched, on every tab.
      const capture = (target: string) => { if (!callbackUrl && target.startsWith(redirect)) callbackUrl = target; };
      context.on("request", (request) => capture(request.url()));
      const page = context.pages()[0] ?? await context.newPage();
      const protocol = await context.newCDPSession(page);
      await protocol.send("Page.enable");
      protocol.on("Page.frameRequestedNavigation", ({ url }: { url: string }) => capture(url));
      const callback = watchPages(context, "Skolengo", async () => callbackUrl);
      // A failed first load (aborted by an SSO redirect, network error page…) must not abort the login:
      // the user can still continue or close the window to cancel.
      await page.goto(url, { waitUntil: "commit" }).catch((error: Error) => {
        if (!callbackUrl) console.warn(`[WEB-AUTH] Skolengo : chargement initial interrompu (${error.message.split("\n")[0]})`);
      });
      const result = await callback;
      console.info("[WEB-AUTH] Skolengo : retour de connexion capturé");
      return result;
    });
    case "auth.pronote": return authenticate(async (context) => {
      const base = pronoteBaseUrl(args[0] as string);
      if (!base) throw new Error("Adresse Pronote HTTPS invalide.");
      const uuid = randomUUID();
      await context.addInitScript(({ uuid }) => {
        Object.assign(window, {
          hookAccesDepuisAppli: function (this: { passerEnModeValidationAppliMobile: (empty: string, uuid: string) => void }) {
            this.passerEnModeValidationAppliMobile("", uuid);
          }
        });
      }, { uuid });
      // The profile is persistent: drop mobile-mode cookies left by a previous attempt.
      await context.clearCookies({ name: /^(appliMobile|validationAppliMobile|uuidAppliMobile)$/ });
      const page = context.pages()[0] ?? await context.newPage();
      const response = await page.goto(`${base}/InfoMobileApp.json?id=${PRONOTE_MOBILE_APP_ID}`);
      if (!response?.ok()) throw new Error("InfoMobileApp Pronote indisponible.");
      const info = await response.json() as { CAS?: { jetonCAS?: string } };
      await context.addCookies([
        { name: "ielang", value: "1036", url: base },
        ...(info.CAS?.jetonCAS ? [
          { name: "validationAppliMobile", value: info.CAS.jetonCAS, url: base },
          { name: "uuidAppliMobile", value: uuid, url: base }
        ] : [{ name: "appliMobile", value: "1", url: base }])
      ]);
      let lastStatus: number | undefined;
      const state = watchPages(context, "Pronote", async (candidate) => {
        if (!candidate.url().startsWith(base)) return undefined;
        const value = await candidate.evaluate(() => {
          const login = (window as Window & { loginState?: { status?: number; login?: string; mdp?: string } }).loginState;
          return login ? { status: login.status, login: login.login, mdp: login.mdp } : null;
        });
        if (value && value.status !== lastStatus) {
          lastStatus = value.status;
          console.info(`[WEB-AUTH] Pronote : état de connexion ${value.status} (jeton ${value.mdp ? "présent" : "absent"})`);
        }
        return value?.status === 0 && value.login && value.mdp ? { login: value.login, mdp: value.mdp } : undefined;
      });
      await page.goto(`${base}/mobile.parent.html?fd=1`, { waitUntil: "commit" }).catch((error: Error) => {
        console.warn(`[WEB-AUTH] Pronote : chargement initial interrompu (${error.message.split("\n")[0]})`);
      });
      const captured = await state;
      console.info("[WEB-AUTH] Pronote : jeton de connexion capturé");
      return { url: base, username: captured.login, token: captured.mdp, uuid };
    });
    default: throw new Error("Opération locale inconnue.");
  }
}
