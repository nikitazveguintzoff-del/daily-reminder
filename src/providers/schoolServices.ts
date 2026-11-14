import { Buffer } from "buffer";
import { cachedPhoto, inlinePhoto, photoCacheKey } from "../photos";
import * as SecureStore from "expo-secure-store";
import { Homework, ParentClient, type Grade } from "pronotets";
import {
  ChallengeMethod,
  GetOIDCWellKnown,
  LoginWithToken,
  SearchSchools,
  School,
  type AuthFlow,
  type Skolengo
} from "skolengojs";
import { pronoteBaseUrl, pronoteLog, type PronoteSsoCapture } from "./pronoteSso";
import type { CourseSlot } from "../courseDay";
import type { CourseItem, GradeItem, HomeworkItem } from "../ecoleDirecte";
import type { ProviderSchoolData, ProviderStudent } from "./types";

const runtimeGlobal = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
runtimeGlobal.Buffer ??= Buffer;

export type PronoteConnection = {
  session: ParentClient;
  url: string;
  parentName: string;
  students: ProviderStudent[];
  refreshToken: string;
};

type PronoteSnapshot = { v: 4; url: string; username: string; token: string; uuid: string };
const pronotePhotos = new WeakMap<object, string>();

function normalizePhotoUrl(url?: string, baseUrl?: string): string | undefined {
  const value = url?.trim();
  if (!value) return undefined;
  if (value.startsWith("data:") || value.startsWith("http://") || value.startsWith("https://")) return value;
  if (value.startsWith("//")) return `https:${value}`;
  if (baseUrl) {
    try {
      return new URL(value, baseUrl).toString();
    } catch (error) {
      console.warn("[PHOTO] Adresse de photo invalide.", { error: error instanceof Error ? error.name : "Error" });
    }
  }
  return value;
}

function photoDiagnostic(value: unknown): { type: string; present: boolean; length?: number; kind?: string; fields?: string[] } {
  if (typeof value !== "string") {
    return {
      type: value === null ? "null" : typeof value,
      present: value !== undefined && value !== null,
      ...(value && typeof value === "object" ? { fields: Object.keys(value) } : {})
    };
  }
  const photo = value.trim();
  return {
    type: "string",
    present: photo.length > 0,
    length: photo.length,
    kind: /^data:image\//i.test(photo)
      ? "data-uri"
      : /^https?:\/\//i.test(photo)
        ? "absolute-url"
        : photo.startsWith("//")
          ? "protocol-relative-url"
          : photo.startsWith("/")
            ? "relative-path"
            : /^[A-Za-z0-9+/=_-]+$/.test(photo)
              ? "base64-like"
              : "other"
  };
}

function pronoteStudents(session: ParentClient): ProviderStudent[] {
  console.info("[PRONOTE-PHOTO] Inspection des profils élèves.", {
    childCount: session.children.length
  });
  return session.children.map((child, index) => {
    const rawChild = child as unknown as Record<string, unknown>;
    const profilePicture = rawChild.profilePicture;
    const profilePictureUrl = profilePicture && typeof profilePicture === "object"
      ? (profilePicture as { url?: unknown }).url
      : undefined;
    const photoField = profilePictureUrl
      ? "profilePicture.url"
      : typeof rawChild.avatar === "string" && rawChild.avatar
        ? "avatar"
        : typeof rawChild.photo === "string" && rawChild.photo
          ? "photo"
          : typeof profilePicture === "string" && profilePicture
            ? "profilePicture"
            : undefined;
    const photoValue = profilePictureUrl || (photoField ? rawChild[photoField.split(".")[0]] : undefined);
    const rawPhoto = typeof photoValue === "string" ? photoValue : undefined;
    const baseUrl = session.pronoteUrl;
    const normalizedPhoto = normalizePhotoUrl(rawPhoto, baseUrl);
    console.info("[PRONOTE-PHOTO] Profil élève inspecté.", {
      index,
      fields: Object.keys(rawChild),
      resourceFields: Object.keys((rawChild.rawResource as object | undefined) || {}),
      profilePicture: photoDiagnostic(profilePicture),
      photoField: photoField || null,
      photo: photoDiagnostic(photoValue),
      normalized: !!normalizedPhoto,
      normalizedKind: photoDiagnostic(normalizedPhoto).kind || null
    });
    const nameParts = child.name.split(" ");
    return {
      id: child.id,
      firstName: nameParts[0] || child.name,
      lastName: nameParts.slice(1).join(" "),
      className: child.className || "",
      photo: isSessionBoundPhoto(normalizedPhoto) ? undefined : normalizedPhoto
    };
  });
}

// FichiersExternes URLs embed the Pronote session: useless (404) once displayed or stored elsewhere.
export function isSessionBoundPhoto(url?: string): boolean {
  return !!url && /\/FichiersExternes\//i.test(url);
}

type PronoteHttpResponse = { status: number; content: Buffer; headers?: { get(name: string): string | null } };
type PronoteAttachment = {
  url?: string;
  id?: string;
  name?: string;
  data?: () => Promise<Uint8Array>;
  _client?: {
    attributes?: Record<string, unknown>;
    communication?: {
      rootSite?: string;
      encryption?: { aesEncrypt: (data: Buffer) => Buffer };
      session?: { get: (url: string) => Promise<PronoteHttpResponse> };
    };
  };
};

function imageMime(bytes: Buffer): string | undefined {
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.subarray(0, 3).toString() === "GIF") return "image/gif";
  if (bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return undefined;
}

// pronotets pads the file entity itself and Node's cipher pads again: Pronote then cannot decode the
// identifier and answers 404. Build the URL like the Pronote web client (single PKCS#7 padding) first,
// and keep the library URL as a fallback.
function pronotePhotoUrls(attachment: PronoteAttachment): { variant: string; url: string }[] {
  const urls: { variant: string; url: string }[] = [];
  const communication = attachment._client?.communication;
  const sessionId = attachment._client?.attributes?.h;
  if (attachment.id && communication?.rootSite && communication.encryption && sessionId !== undefined) {
    const entity = Buffer.from(JSON.stringify({ N: attachment.id, Actif: true }), "utf8");
    const magic = communication.encryption.aesEncrypt(entity).toString("hex");
    const file = encodeURIComponent(attachment.name || "photo.jpg");
    const typed = communication.encryption.aesEncrypt(Buffer.from(JSON.stringify({ N: attachment.id, G: 1 }), "utf8")).toString("hex");
    urls.push(
      { variant: "single-padding", url: `${communication.rootSite}/FichiersExternes/${magic}/${file}?Session=${sessionId}` },
      // Entity used by recent clients (Blocksnote): {N, G} without Actif.
      { variant: "entity-N-G", url: `${communication.rootSite}/FichiersExternes/${typed}/${file}?Session=${sessionId}` },
      // POST payloads are sent in upper-case hex: some Pronote versions may only accept that form.
      { variant: "single-padding-upper", url: `${communication.rootSite}/FichiersExternes/${magic.toUpperCase()}/${file}?Session=${sessionId}` }
    );
  }
  if (attachment.url && !urls.some(({ url }) => url === attachment.url)) urls.push({ variant: "library", url: attachment.url });
  return urls;
}

// Recent Pronote versions embed the picture in ParametresUtilisateur: the resource holds `photoBase64`,
// an index into the envelope's clear `dataNonSec.fichiers` (the web client shows it as a data URI).
// `ressources` sits next to `dataSec` in the response envelope; look a few levels deep to stay tolerant.
function findPronoteFiles(value: unknown, depth = 0): unknown[] | undefined {
  if (!value || typeof value !== "object" || depth > 4) return undefined;
  const record = value as Record<string, unknown>;
  const ressources = record.ressources as { fichiers?: unknown } | undefined;
  if (Array.isArray(ressources?.fichiers)) return ressources.fichiers;
  if (Array.isArray(record.fichiers)) return record.fichiers;
  for (const [key, child] of Object.entries(record)) {
    if (key === "_client" || key === "listeRessources") continue;
    const found = findPronoteFiles(child, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function pronoteEmbeddedPhoto(child: object): string | undefined {
  const { rawResource, _client } = child as {
    rawResource?: { photoBase64?: unknown };
    _client?: { parametresUtilisateur?: Record<string, unknown> };
  };
  let index = rawResource?.photoBase64;
  if (index === undefined || index === null) return undefined;
  if (typeof index === "object") index = (index as { V?: unknown }).V;
  const settings = _client?.parametresUtilisateur;
  let encoded: unknown;
  if (typeof index === "string" && index.length > 64) {
    encoded = index;
  } else {
    let nonSec = settings?.dataNonSec;
    if (typeof nonSec === "string") {
      try { nonSec = JSON.parse(nonSec); } catch { nonSec = undefined; }
    }
    const files = findPronoteFiles(nonSec) ?? findPronoteFiles(settings);
    const entry = files?.[Number(index)];
    encoded = typeof entry === "string" ? entry : (entry as { V?: unknown } | undefined)?.V;
    if (typeof encoded !== "string" || !encoded) {
      const dataSec = settings?.dataSec as Record<string, unknown> | undefined;
      console.warn("[PRONOTE-PHOTO] photoBase64 présent mais fichier introuvable.", {
        indexType: typeof index,
        index: typeof index === "number" || (typeof index === "string" && index.length < 16) ? index : undefined,
        files: files ? `array(${files.length})` : "absent",
        entryType: typeof entry,
        envelopeKeys: Object.keys(settings || {}),
        dataNonSecType: typeof settings?.dataNonSec,
        dataNonSecKeys: nonSec && typeof nonSec === "object" ? Object.keys(nonSec) : undefined,
        dataSecKeys: Object.keys(dataSec || {}),
        dataKeys: Object.keys((dataSec?.data as object | undefined) || {})
      });
      return undefined;
    }
  }
  if (typeof encoded !== "string") return undefined;
  const bytes = Buffer.from(encoded.replace(/^data:[^,]*,/, ""), "base64");
  const mime = imageMime(bytes);
  if (!mime) {
    console.warn("[PRONOTE-PHOTO] photoBase64 n'est pas une image reconnue.", { length: bytes.length });
    return undefined;
  }
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function pronoteStudentPhoto(child: unknown, studentId: string): Promise<string | undefined> {
  return cachedPhoto(photoCacheKey("pronote", studentId), () => pronotePhotoData(child));
}

// L'URL de la photo n'est valable qu'avec la session Pronote : on la télécharge via le client.
async function pronotePhotoData(child: unknown): Promise<string | undefined> {
  if (!child || typeof child !== "object") return undefined;
  const cached = pronotePhotos.get(child);
  if (cached) return cached;
  try {
    const embedded = pronoteEmbeddedPhoto(child);
    if (embedded) {
      console.info("[PRONOTE-PHOTO] Photo récupérée.", { variant: "photoBase64" });
      pronotePhotos.set(child, embedded);
      return embedded;
    }
    const attachment = (child as { profilePicture?: PronoteAttachment | null }).profilePicture;
    if (!attachment) {
      console.info("[PRONOTE-PHOTO] Pronote ne déclare pas de photo pour cet élève (avecPhoto absent).");
      return undefined;
    }
    const get = attachment._client?.communication?.session?.get.bind(attachment._client.communication.session);
    const attempts: { variant: string; status?: number; length: number; type?: string; error?: string }[] = [];
    let photo: string | undefined;
    if (get) {
      for (const { variant, url } of pronotePhotoUrls(attachment)) {
        let response: PronoteHttpResponse;
        try {
          response = await get(url);
        } catch (error) {
          attempts.push({ variant, length: 0, error: error instanceof Error ? error.message : String(error) });
          continue;
        }
        const bytes = Buffer.from(response.content);
        const mime = response.status === 200 ? imageMime(bytes) : undefined;
        attempts.push({ variant, status: response.status, length: bytes.length, type: response.headers?.get("content-type") || undefined });
        if (mime) {
          photo = `data:${mime};base64,${bytes.toString("base64")}`;
          break;
        }
      }
    } else if (typeof attachment.data === "function") {
      const bytes = Buffer.from(await attachment.data());
      const mime = imageMime(bytes);
      attempts.push({ variant: "data", length: bytes.length });
      if (mime) photo = `data:${mime};base64,${bytes.toString("base64")}`;
    }
    if (!photo) {
      // Status and size only: the URL carries the session id.
      console.warn("[PRONOTE-PHOTO] Aucune image valide reçue.", { attempts });
      return undefined;
    }
    console.info("[PRONOTE-PHOTO] Photo récupérée.", { variant: attempts[attempts.length - 1]?.variant });
    pronotePhotos.set(child, photo);
    return photo;
  } catch (error) {
    console.warn("[PRONOTE-PHOTO] Échec du téléchargement authentifié.", {
      error: error instanceof Error ? error.message : String(error)
    });
    return undefined;
  }
}

async function pronoteConnection(session: ParentClient, credentials: PronoteSnapshot): Promise<PronoteConnection> {
  const students: ProviderStudent[] = [];
  // Attachment requests share Pronote's session sequence; never run them in parallel.
  for (const [index, student] of pronoteStudents(session).entries()) {
    students.push({
      ...student,
      photo: (await pronoteStudentPhoto(session.children[index], student.id)) ?? (student.photo ? await inlinePhoto(student.photo, "PRONOTE") : undefined)
    });
  }
  return {
    session,
    url: credentials.url,
    parentName: session.info.name || "Compte parent",
    refreshToken: JSON.stringify(credentials),
    students
  };
}

const PRONOTE_COOLDOWN_KEY = "tempo-pronote-cooldown-v2";
const PRONOTE_LAST_ATTEMPT_KEY = "tempo-pronote-last-attempt-v1";
const PRONOTE_FAILURE_COOLDOWN_MS = 15 * 60 * 1000;
const PRONOTE_BLOCK_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const PRONOTE_RESTORE_MIN_INTERVAL_MS = 60 * 1000;
const PRONOTE_BLOCK_PATTERN = /\b(25|403|429)\b|exceeded|too many|blocked|banned|forbidden|bloqu/i;
const PRONOTE_IGNORED_HOSTS = /(^|\.)ecoledirecte\.com$|skolengo|expo\.dev/i;

type PronoteCooldown = { until: number; blocked: boolean };

export class PronoteCooldownError extends Error {
  constructor(public readonly until: number) {
    super(`Pronote est en pause jusqu’à ${new Date(until).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} pour éviter un blocage. Réessaie plus tard.`);
    this.name = "PronoteCooldownError";
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

let pronoteTrafficDepth = 0;
let pronoteFetchInstalled = false;

// Logs method, host, path and status only: no query string, body, header or cookie.
function installPronoteTrafficLog(): void {
  if (pronoteFetchInstalled) return;
  pronoteFetchInstalled = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const tracked = pronoteTrafficDepth > 0 && !PRONOTE_IGNORED_HOSTS.test(hostOf(rawUrl));
    if (!tracked) return originalFetch(input, init);
    const method = init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET");
    const target = (() => {
      try {
        const parsed = new URL(rawUrl);
        return `${parsed.host}${parsed.pathname}`;
      } catch {
        return "invalid-url";
      }
    })();
    const startedAt = Date.now();
    try {
      const response = await originalFetch(input, init);
      const location = response.headers.get("location");
      pronoteLog(`HTTP ${method} ${target}`, {
        status: response.status,
        location: location ? hostOf(new URL(location, rawUrl).toString()) : undefined,
        ms: Date.now() - startedAt
      });
      return response;
    } catch (error) {
      pronoteLog(`HTTP ${method} ${target} NETWORK ERROR`, { error: (error as Error).message, ms: Date.now() - startedAt });
      throw error;
    }
  }) as typeof fetch;
}

// User-initiated connections only honour a suspected IP block, not the short failure pause.
async function assertPronoteAllowed(reason: "connect" | "restore"): Promise<void> {
  let cooldown: PronoteCooldown | null = null;
  try {
    cooldown = JSON.parse((await SecureStore.getItemAsync(PRONOTE_COOLDOWN_KEY)) || "null") as PronoteCooldown | null;
  } catch {
    cooldown = null;
  }
  if (!cooldown || cooldown.until <= Date.now()) return;
  if (reason === "connect" && !cooldown.blocked) return;
  pronoteLog(`${reason}: blocked by local cooldown`, { until: new Date(cooldown.until).toISOString(), suspectedBlock: cooldown.blocked });
  throw new PronoteCooldownError(cooldown.until);
}

async function recordPronoteFailure(error: unknown): Promise<void> {
  if (error instanceof PronoteCooldownError) return;
  const message = error instanceof Error ? error.message : String(error);
  const blocked = PRONOTE_BLOCK_PATTERN.test(message);
  const until = Date.now() + (blocked ? PRONOTE_BLOCK_COOLDOWN_MS : PRONOTE_FAILURE_COOLDOWN_MS);
  pronoteLog("login failed, cooldown started", {
    name: (error as Error)?.name,
    message,
    suspectedBlock: blocked,
    until: new Date(until).toISOString()
  });
  await SecureStore.setItemAsync(PRONOTE_COOLDOWN_KEY, JSON.stringify({ until, blocked } satisfies PronoteCooldown));
}

async function loginWithToken(snapshot: PronoteSnapshot, reason: "connect" | "restore", saveToken?: (token: string) => Promise<void>): Promise<PronoteConnection> {
  installPronoteTrafficLog();
  pronoteLog(`${reason}: token login starting`, { pronoteHost: hostOf(snapshot.url) });
  const startedAt = Date.now();
  pronoteTrafficDepth++;
  try {
    // pronotets requests the page it is given: the mobile parent page, not the /pronote root.
    const pageUrl = `${snapshot.url.replace(/\/+$/, "")}/mobile.parent.html?fd=1&bydlg=A6ABB224-12DD-4E31-AD3E-8A39A1C2C335&login=true`;
    const session = await ParentClient.tokenLogin(pageUrl, snapshot.username, snapshot.token, snapshot.uuid);
    pronoteLog(`${reason}: login succeeded`, { ms: Date.now() - startedAt, children: session.children.length });
    // Tokens are single-use: the renewed one must replace the saved one.
    const renewed = session.exportCredentials();
    const credentials: PronoteSnapshot = {
      v: 4,
      url: snapshot.url,
      username: renewed.username,
      token: renewed.password,
      uuid: renewed.uuid
    };
    // A photo failure or process termination must not lose the renewed single-use token.
    await saveToken?.(JSON.stringify(credentials));
    return await pronoteConnection(session, credentials);
  } catch (error) {
    await recordPronoteFailure(error);
    throw error;
  } finally {
    pronoteTrafficDepth--;
  }
}
let pronoteLoginQueue: Promise<unknown> = Promise.resolve();
const pendingPronoteLogins = new Map<string, Promise<PronoteConnection>>();

function serializedLogin(key: string, run: () => Promise<PronoteConnection>): Promise<PronoteConnection> {
  const pending = pendingPronoteLogins.get(key);
  if (pending) return pending;
  const result = pronoteLoginQueue.then(run).finally(() => pendingPronoteLogins.delete(key));
  pendingPronoteLogins.set(key, result);
  pronoteLoginQueue = result.catch(() => undefined);
  return result;
}

export function connectPronoteSso(capture: PronoteSsoCapture, saveToken?: (token: string) => Promise<void>): Promise<PronoteConnection> {
  return serializedLogin(JSON.stringify(capture), async () => {
    pronoteLog("connect: requested", { pronoteHost: hostOf(capture.url) });
    await assertPronoteAllowed("connect");
    await SecureStore.setItemAsync(PRONOTE_LAST_ATTEMPT_KEY, String(Date.now()));
    return loginWithToken({ v: 4, url: capture.url, username: capture.username, token: capture.token, uuid: capture.uuid }, "connect", saveToken);
  });
}

export function restorePronote(snapshot: string, saveToken?: (token: string) => Promise<void>): Promise<PronoteConnection> {
  return serializedLogin(snapshot, async () => {
    pronoteLog("restore: requested");
    await assertPronoteAllowed("restore");
    let saved: PronoteSnapshot | null = null;
    try {
      saved = JSON.parse(snapshot) as PronoteSnapshot;
    } catch {
      saved = null;
    }
    if (!saved || saved.v !== 4 || !saved.url || !saved.username || !saved.token || !saved.uuid) {
      pronoteLog("restore: legacy or invalid snapshot, reconnection required");
      throw new Error("Session Pronote expirée : reconnecte-toi via ton ENT.");
    }
    const lastAttempt = Number(await SecureStore.getItemAsync(PRONOTE_LAST_ATTEMPT_KEY)) || 0;
    if (Date.now() - lastAttempt < PRONOTE_RESTORE_MIN_INTERVAL_MS) {
      const until = lastAttempt + PRONOTE_RESTORE_MIN_INTERVAL_MS;
      pronoteLog("restore: skipped, last login attempt is too recent", { until: new Date(until).toISOString() });
      throw new PronoteCooldownError(until);
    }
    await SecureStore.setItemAsync(PRONOTE_LAST_ATTEMPT_KEY, String(Date.now()));
    return loginWithToken(saved, "restore", saveToken);
  });
}

export type SkolengoLoginStart = {
  school: School;
  flow: AuthFlow;
};

export async function searchSkolengoSchools(query: string): Promise<School[]> {
  return SearchSchools(query, 20);
}

export async function startSkolengoLogin(school: School): Promise<SkolengoLoginStart> {
  return { school, flow: await school.initializeLogin(ChallengeMethod.S256) };
}

export async function finishSkolengoLogin(
  flow: AuthFlow,
  callbackUrl: string
): Promise<{ account: Skolengo; students: ProviderStudent[] }> {
  const callback = new URL(callbackUrl);
  const code = callback.searchParams.get("code");
  const state = callback.searchParams.get("state");
  if (!code || !state) throw new Error("La réponse de connexion Skolengo est incomplète.");
  const account = await flow.finalizeLogin(code, state);
  const students = (account.kids?.length ? account.kids : [account]).map((student) => ({
    id: student.userId,
    firstName: student.firstName,
    lastName: student.lastName,
    className: student.className,
    photo: undefined
  }));
  return { account, students };
}

export async function restoreSkolengoLogin(
  refreshToken: string,
  schoolInfo: Pick<School, "id" | "name" | "emsCode" | "OIDCWellKnown" | "location" | "homepage" | "UAI" | "subscribedServices">
): Promise<{ account: Skolengo; students: ProviderStudent[] }> {
  const school = new School(
    schoolInfo.id,
    schoolInfo.name,
    schoolInfo.emsCode,
    schoolInfo.OIDCWellKnown,
    schoolInfo.location,
    schoolInfo.homepage,
    schoolInfo.UAI,
    schoolInfo.subscribedServices
  );
  const metadata = await GetOIDCWellKnown(school.OIDCWellKnown);
  const account = await LoginWithToken(
    metadata.token_endpoint,
    refreshToken,
    school.OIDCWellKnown,
    metadata.token_endpoint,
    school.emsCode
  );
  const students = (account.kids?.length ? account.kids : [account]).map((student) => ({
    id: student.userId,
    firstName: student.firstName,
    lastName: student.lastName,
    className: student.className
  }));
  return { account, students };
}

function homeworkPreview(content: string): string {
  return content.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

type SkolengoResource = {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, {
    data?: { id: string; type: string } | Array<{ id: string; type: string }> | null;
  }>;
};

type SkolengoAgendaResponse = {
  data?: SkolengoResource[];
  included?: SkolengoResource[];
};

type SkolengoAgendaData = {
  courses: CourseItem[];
  homeworks: Array<HomeworkItem & { id: string }>;
};

function relationshipIds(resource: SkolengoResource, name: string): string[] {
  const data = resource.relationships?.[name]?.data;
  if (!data) return [];
  return Array.isArray(data) ? data.map((item) => item.id) : [data.id];
}

// Course consumers read the wall-clock time from the string, so UTC instants must be converted first.
function toLocalDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatSkolengoHomeworkContent(raw: Record<string, unknown>): string {
  const title = String(raw.title || "").trim();
  const consigne = String(raw.consigne || raw.instructions || "").trim();
  const exercice = String(raw.exercice || raw.exercise || "").trim();
  const description = String(raw.description || raw.details || raw.content || "").trim();
  const html = String(raw.html || "").trim();
  const onlineUrl = String(raw.onlineDeliveryUrl || "").trim();
  const deliverOnline = Boolean(raw.deliverWorkOnline || raw.onlineDeliveryUrl);

  const parts: string[] = [];

  if (title && !consigne.includes(title) && !exercice.includes(title) && !html.includes(title)) {
    parts.push(`<h4 style="margin:0 0 8px 0;color:#0F604D;font-size:16px;">${title}</h4>`);
  }
  if (consigne) {
    parts.push(`<div><strong>Consigne :</strong> ${consigne}</div>`);
  }
  if (exercice) {
    parts.push(`<div><strong>Exercice :</strong> ${exercice}</div>`);
  }
  if (description && !consigne.includes(description) && !exercice.includes(description)) {
    parts.push(`<div>${description}</div>`);
  }
  if (html && !parts.some((part) => part.includes(html))) {
    parts.push(`<div>${html}</div>`);
  }
  if (deliverOnline || onlineUrl) {
    parts.push(`<div style="margin-top:10px;padding:8px 12px;background-color:#EBF5F2;border-radius:8px;color:#16866A;font-weight:600;">💻 Travail à rendre en ligne${onlineUrl ? ` : <a href="${onlineUrl}" target="_blank" style="color:#16866A;">Lien de rendu</a>` : ""}</div>`);
  }

  return parts.join("<br/>") || html || title || "Aucun détail fourni.";
}

async function fetchSkolengoAgenda(
  student: Skolengo,
  studentId: string,
  date: Date,
  endDate?: Date
): Promise<SkolengoAgendaData> {
  await student.refreshAccessToken();
  const { accessToken, school } = student as unknown as { accessToken: string; school: School };
  const dateKey = toLocalDateTime(date).slice(0, 10);
  const endDateKey = toLocalDateTime(endDate || date).slice(0, 10);
  const query = new URLSearchParams({
    "page[limit]": "100",
    include: "lessons,lessons.subject,lessons.teachers,homeworkAssignments,homeworkAssignments.subject",
    "fields[cateringService]": "title,startDateTime,endDateTime",
    "fields[lesson]": "title,startDateTime,endDateTime,location,canceled,anyContent,anyHomeworkToDoForTheLesson,anyHomeworkToDoAfterTheLesson,subject,teachers",
    "fields[homework]": "title,done,dueDateTime,subject,html,consigne,instructions,exercice,exercise,description,details,deliverWorkOnline,onlineDeliveryUrl",
    "fields[teacher]": "firstName,lastName,title",
    "filter[date][GE]": dateKey,
    "filter[student.id]": studentId,
    "filter[date][LE]": endDateKey,
    "fields[subject]": "label,color"
  });
  const response = await fetch(`https://api.skolengo.com/api/v1/bff-sko-app/agendas?${query}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "x-skolengo-ems-code": school.emsCode,
      "x-skolengo-school-id": school.id
    }
  });
  if (!response.ok) throw new Error(`Agenda Skolengo : HTTP ${response.status}.`);
  const payload = await response.json() as SkolengoAgendaResponse;
  const included = new Map((payload.included || []).map((item) => [`${item.type}:${item.id}`, item]));
  const relationId = (resource: SkolengoResource, name: string) => relationshipIds(resource, name)[0];
  const homeworks = new Map<string, HomeworkItem & { id: string }>();
  const courses = (payload.data || []).flatMap((day) => {
    const lessons = relationshipIds(day, "lessons").flatMap((id) => {
      const lesson = included.get(`lesson:${id}`);
      if (!lesson) return [];
      const attributes = lesson.attributes || {};
      const subject = included.get(`subject:${relationId(lesson, "subject") || ""}`);
      const teachers = relationshipIds(lesson, "teachers")
        .map((teacherId) => included.get(`teacher:${teacherId}`)?.attributes)
        .filter((teacher): teacher is Record<string, unknown> => !!teacher)
        .map((teacher) => [teacher.title, teacher.firstName, teacher.lastName].filter(Boolean).join(" "));
      return [{
        subject: String(subject?.attributes?.label || attributes.title || "Cours"),
        start: toLocalDateTime(String(attributes.startDateTime || "")),
        end: toLocalDateTime(String(attributes.endDateTime || "")),
        room: String(attributes.location || ""),
        teacher: teachers.join(", "),
        ...(attributes.canceled ? { canceled: true } : {})
      }];
    });
    for (const id of relationshipIds(day, "homeworkAssignments")) {
      const homework = included.get(`homework:${id}`);
      if (!homework) continue;
      const attributes = homework.attributes || {};
      const subject = included.get(`subject:${relationId(homework, "subject") || ""}`);
      const content = formatSkolengoHomeworkContent(attributes);
      homeworks.set(id, {
        id,
        subject: String(subject?.attributes?.label || attributes.title || "Devoir"),
        content,
        preview: homeworkPreview(content),
        dueDate: String(attributes.dueDateTime || ""),
        done: Boolean(attributes.done)
      });
    }
    return lessons;
  });
  return { courses, homeworks: [...homeworks.values()] };
}

let pronoteDataQueue: Promise<unknown> = Promise.resolve();

// Pronote numbers requests per session: concurrent syncs would corrupt the sequence.
export function fetchPronoteData(
  session: ParentClient,
  studentId: string,
  timetableDate: Date,
  homeworkDays: number,
  saveToken?: (token: string) => Promise<void>
): Promise<ProviderSchoolData> {
  const run = pronoteDataQueue.then(async () => {
    try { return await fetchPronoteDataNow(session, studentId, timetableDate, homeworkDays); }
    finally {
      if (saveToken) {
        const credentials = session.exportCredentials();
        const url = pronoteBaseUrl(session.pronoteUrl);
        if (!url) throw new Error("Adresse de la session Pronote invalide.");
        await saveToken(JSON.stringify({
          v: 4, url, username: credentials.username, token: credentials.password, uuid: credentials.uuid
        } satisfies PronoteSnapshot));
      }
    }
  });
  pronoteDataQueue = run.catch(() => undefined);
  return run;
}

async function fetchPronoteDataNow(
  session: ParentClient,
  studentId: string,
  timetableDate: Date,
  homeworkDays: number
): Promise<ProviderSchoolData> {
  const student = session.children.find((candidate) => candidate.id === studentId);
  if (!student) throw new Error("Élève Pronote introuvable dans cette connexion.");
  session.setChild(student);

  const homeworkEnd = new Date(timetableDate);
  homeworkEnd.setDate(homeworkEnd.getDate() + homeworkDays);
  homeworkEnd.setHours(23, 59, 59, 999);

  const logCall = async <T>(
    name: string,
    call: () => Promise<T>,
    countResults = false
  ): Promise<T> => {
    const startedAt = Date.now();
    try {
      const result = await call();
      pronoteLog(`data: ${name} succeeded`, {
        ...(countResults && Array.isArray(result) ? { count: result.length } : {}),
        ms: Date.now() - startedAt
      });
      return result;
    } catch (error) {
      pronoteLog(`data: ${name} failed`, {
        errorName: error instanceof Error ? error.name : "UnknownError",
        ...(error instanceof Error && error.name !== "ParsingError" ? { message: error.message.slice(0, 200) } : {}),
        ms: Date.now() - startedAt
      });
      throw error;
    }
  };

  const allLessons = await logCall("lessons", () => session.lessons(timetableDate, timetableDate), true);
  const homeworkStart = new Date(timetableDate);
  homeworkStart.setHours(0, 0, 0, 0);
  const assignments = await logCall("homework", async () => {
    // pronotets assumes ListeTravauxAFaire exists; only an omitted list means "no homework".
    const response = await session.post("PageCahierDeTexte", 88, {
      domaine: { _T: 8, V: `[${session.getWeek(homeworkStart)}..${session.getWeek(homeworkEnd)}]` }
    }) as { dataSec?: { data?: { ListeTravauxAFaire?: { V?: unknown } } } };
    if (!response.dataSec?.data) throw new Error("Réponse devoirs Pronote incomplète.");
    const list = response.dataSec.data.ListeTravauxAFaire;
    if (!list) return [];
    if (!Array.isArray(list.V)) throw new Error("Liste des devoirs Pronote invalide.");
    return list.V.map((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Devoir Pronote invalide.");
      return new Homework(session, item as Record<string, unknown>);
    }).filter((item) => item.date >= homeworkStart && item.date <= homeworkEnd);
  }, true);
  let grades: Grade[] = [];
  let gradesError: string | undefined;
  try {
    const period = await logCall("currentPeriod", () => session.currentPeriod());
    grades = await logCall("grades", () => period.grades(), true);
  } catch (error) {
    gradesError = `Notes Pronote indisponibles : ${error instanceof Error ? error.message : String(error)}`;
  }

  const courses: CourseItem[] = allLessons
    .map((lesson) => ({
      subject: lesson.subject?.name || "Cours",
      start: toLocalDateTime(lesson.start),
      end: toLocalDateTime(lesson.end),
      room: lesson.classrooms.join(", "),
      teacher: lesson.teacherNames.join(", ")
    }));
  const homeworks: HomeworkItem[] = assignments.map((assignment) => ({
    subject: assignment.subject.name,
    content: assignment.description,
    preview: homeworkPreview(assignment.description),
    dueDate: assignment.date.toISOString(),
    done: assignment.done
  }));
  const mappedGrades: GradeItem[] = grades.map((grade) => {
    const rawGrade = grade as unknown as Record<string, unknown>;
    let classAvgRaw: string | undefined;

    if (typeof rawGrade.classAverage === "string" || typeof rawGrade.classAverage === "number") {
      classAvgRaw = String(rawGrade.classAverage);
    } else if (typeof rawGrade.average === "string" || typeof rawGrade.average === "number") {
      classAvgRaw = String(rawGrade.average);
    } else if (rawGrade.average && typeof rawGrade.average === "object") {
      const avgObj = rawGrade.average as Record<string, unknown>;
      classAvgRaw = String(avgObj.value || avgObj.average || avgObj.val || "");
    } else if (rawGrade.averages && typeof rawGrade.averages === "object") {
      const avgObj = rawGrade.averages as Record<string, unknown>;
      classAvgRaw = String(avgObj.average || avgObj.value || "");
    }

    const classAverage = classAvgRaw && classAvgRaw !== "undefined"
      ? `Moy. classe : ${classAvgRaw}${grade.outOf && !classAvgRaw.includes("/") ? ` / ${grade.outOf}` : ""}`
      : undefined;

    return {
      subject: grade.subject.name,
      value: `${grade.grade}${grade.outOf ? ` / ${grade.outOf}` : ""}`,
      date: grade.date.toISOString(),
      ...(classAverage ? { classAverage } : {})
    };
  });

  courses.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  homeworks.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  mappedGrades.sort((a, b) => b.date.localeCompare(a.date));

  const rawChild = student as unknown as Record<string, unknown>;
  const rawPhoto = (student.profilePicture as { url?: string } | undefined)?.url ||
    String(rawChild.avatar || rawChild.photo || rawChild.profilePicture || "");
  const fallbackPhoto = normalizePhotoUrl(rawPhoto, session.pronoteUrl);
  const studentPhoto = (await pronoteStudentPhoto(student, studentId)) ??
    (isSessionBoundPhoto(fallbackPhoto) ? undefined : fallbackPhoto);

  return { courses, homeworks, grades: mappedGrades, competencies: [], studentPhoto, gradesError };
}

const skolengoDataQueues = new WeakMap<Skolengo, Promise<unknown>>();

export function fetchSkolengoData(
  account: Skolengo,
  studentId: string,
  timetableDate: Date,
  homeworkDays: number,
  saveToken?: (token: string) => Promise<void>
): Promise<ProviderSchoolData> {
  const run = (skolengoDataQueues.get(account) || Promise.resolve()).then(() =>
    fetchSkolengoDataNow(account, studentId, timetableDate, homeworkDays, saveToken));
  skolengoDataQueues.set(account, run.catch(() => undefined));
  return run;
}

async function fetchSkolengoDataNow(
  account: Skolengo,
  studentId: string,
  timetableDate: Date,
  homeworkDays: number,
  saveToken?: (token: string) => Promise<void>
): Promise<ProviderSchoolData> {
  const { student, request } = await skolengoStudent(account, studentId, saveToken);
  const homeworkEnd = new Date(timetableDate);
  homeworkEnd.setDate(homeworkEnd.getDate() + homeworkDays);
  homeworkEnd.setHours(23, 59, 59, 999);
  const agenda = await request(() => fetchSkolengoAgenda(student, studentId, timetableDate, homeworkEnd));
  let assignments: Awaited<ReturnType<Skolengo["GetAssignments"]>>;
  try {
    assignments = await request(() => student.GetAssignments(timetableDate, homeworkEnd));
  } catch (error) {
    console.warn("[SKOLENGO] homework-assignments failed:", (error as Error).message);
    throw new Error(`Devoirs Skolengo incomplets : ${(error as Error).message}`);
  }
  let grades: Awaited<ReturnType<Skolengo["GetLastGrades"]>> = [];
  let gradesError: string | undefined;
  try {
    grades = await request(() => student.GetLastGrades(30));
  } catch (error) {
    gradesError = `Notes Skolengo indisponibles : ${(error as Error).message}`;
  }
  const homeworkItems = new Map(agenda.homeworks.map((homework) => [homework.id, homework]));
  for (const assignment of assignments) {
    const rawAssignment = assignment as unknown as Record<string, unknown>;
    const content = formatSkolengoHomeworkContent(rawAssignment);

    homeworkItems.set(assignment.id, {
      id: assignment.id,
      subject: assignment.subject?.label || assignment.title || "Devoir",
      content,
      preview: homeworkPreview(content),
      dueDate: assignment.dueDateTime.toISOString(),
      done: Boolean(assignment.done)
    });
  }
  return {
    courses: agenda.courses,
    homeworks: [...homeworkItems.values()],
    grades: grades.map((grade) => ({
      subject: grade.subject?.label || "Note",
      value: `${grade.value}${grade.outOf ? ` / ${grade.outOf}` : ""}`,
      date: grade.date.toISOString()
    })),
    competencies: [],
    ...(gradesError ? { gradesError } : {})
  };
}

async function skolengoStudent(account: Skolengo, studentId: string, saveToken?: (token: string) => Promise<void>) {
  const refreshed = await account.refreshAccessToken();
  await saveToken?.(account.refreshToken);
  // skolengojs copies credentials to each child and doesn't advance TTL after refresh.
  // Share the latest credentials before calls, preventing reuse of a rotated refresh token.
  type Tokens = { accessToken: string; accessTokenTTL: number };
  const parentTokens = account as unknown as Tokens;
  const tokenExpiry = (token: string): number => {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString("utf8")) as { exp?: unknown };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) throw new Error("Expiration du jeton Skolengo invalide.");
    return payload.exp * 1000;
  };
  if (refreshed) parentTokens.accessTokenTTL = tokenExpiry(parentTokens.accessToken);
  const student = [...(account.kids ?? []), account].find((candidate) => candidate.userId === studentId);
  if (!student) throw new Error("Élève Skolengo introuvable dans cette connexion.");
  const studentTokens = student as unknown as Tokens;
  studentTokens.accessToken = parentTokens.accessToken;
  studentTokens.accessTokenTTL = parentTokens.accessTokenTTL;
  student.refreshToken = account.refreshToken;
  const request = async <T>(run: () => Promise<T>): Promise<T> => {
    try { return await run(); }
    finally {
      if (account.refreshToken !== student.refreshToken) {
        account.refreshToken = student.refreshToken;
        await saveToken?.(account.refreshToken);
      }
      parentTokens.accessToken = studentTokens.accessToken;
      parentTokens.accessTokenTTL = studentTokens.accessTokenTTL = tokenExpiry(studentTokens.accessToken);
    }
  };
  return { student, request };
}

export function fetchSkolengoCourseSlots(
  account: Skolengo,
  studentId: string,
  from: Date,
  to: Date,
  saveToken?: (token: string) => Promise<void>
): Promise<CourseSlot[]> {
  const run = (skolengoDataQueues.get(account) || Promise.resolve()).then(async () => {
    const { student, request } = await skolengoStudent(account, studentId, saveToken);
    const agenda = await request(() => fetchSkolengoAgenda(student, studentId, from, to));
    return agenda.courses.map(({ start, end, canceled }) => ({ start, end, canceled }));
  });
  skolengoDataQueues.set(account, run.catch(() => undefined));
  return run;
}

export function fetchPronoteCourseSlots(session: ParentClient, studentId: string, from: Date, to: Date): Promise<CourseSlot[]> {
  const run = pronoteDataQueue.then(async () => {
    const student = session.children.find((candidate) => candidate.id === studentId);
    if (!student) throw new Error("Élève Pronote introuvable dans cette connexion.");
    session.setChild(student);
    const lessons = await session.lessons(from, to);
    return lessons.map((lesson) => ({ start: toLocalDateTime(lesson.start), end: toLocalDateTime(lesson.end), canceled: !!lesson.canceled }));
  });
  pronoteDataQueue = run.catch(() => undefined);
  return run;
}
