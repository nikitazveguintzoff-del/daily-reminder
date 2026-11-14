import { Buffer } from "buffer";
import { inlinePhoto, photoCacheKey } from "./photos";
import { Client, Require2FA } from "@blockshub/blocksdirecte";
import { firstCourseDay, lookaheadRange, noonOf, type CourseSlot } from "./courseDay";
import type { MessageItem } from "./providers/types";

const runtimeGlobal = globalThis as typeof globalThis & { Buffer?: typeof Buffer };
runtimeGlobal.Buffer ??= Buffer;

export type CourseItem = {
  subject: string;
  start: string;
  end: string;
  room: string;
  teacher: string;
  canceled?: boolean;
};

export type HomeworkItem = {
  subject: string;
  content: string;
  preview: string;
  dueDate: string;
  done: boolean;
};

export type GradeItem = {
  subject: string;
  value: string;
  date: string;
  classAverage?: string;
};

export type CompetenceItem = {
  subject: string;
  label: string;
  value: string;
};

export type EdPupil = {
  id: number;
  prenom?: string;
  nom?: string;
  photo?: string;
  classe?: { libelle?: string; code?: string };
};

export function formatEcoleDirectePhoto(photo?: string): string | undefined {
  if (!photo) return undefined;
  if (photo.startsWith("data:image") || photo.startsWith("http")) return photo;
  if (photo.startsWith("//")) return `https:${photo}`;
  if (photo.startsWith("/")) return `https://www.ecoledirecte.com${photo}`;
  return photo;
}

export type SchoolData = {
  student: EdPupil;
  courses: CourseItem[];
  homeworks: HomeworkItem[];
  grades: GradeItem[];
  competencies: CompetenceItem[];
  latestGrade: GradeItem | null;
  syncedAt: string;
  error?: string;
  errorCode?: number;
  gradesError?: string;
};

type EcoleDirecteGradeData = {
  notes?: {
    libelleMatiere?: string;
    valeur?: string;
    noteSur?: string;
    dateSaisie?: string;
    date?: string;
    moyenneClasse?: string | number | null;
    elementsProgramme?: CompetenceItem[];
    elementsProg?: CompetenceItem[];
  }[];
  periodes?: {
    periode?: string;
    ensembleMatieres?: {
      moyenneClasse?: string | number;
      disciplines?: {
        discipline?: string;
        moyenneClasse?: string | number;
      }[];
    };
  }[];
  LSUN?: Record<string, CompetenceItem[]>;
};

type StudentAccount = EdPupil & {
  typeCompte: string;
  accesstoken?: string;
  accessToken?: string;
  profile?: { eleves?: EdPupil[] };
};

export type EdSession = {
  gtk?: string;
  token?: string;
  loginChallengeToken?: string;
  client?: Client;
  student?: StudentAccount;
  pupils?: EdPupil[];
  accessToken?: string;
  twoFactorFactors?: { cn: string; cv: string };
  loginResponse?: unknown;
};

export type LoginChallenge = {
  question: string;
  options: { label: string; value: string }[];
};

type ApiResponse<T> = {
  code: number;
  token?: string;
  message?: string | null;
  data: T;
};

const API_BASE = "https://api.ecoledirecte.com";
const API_VERSION = "8.0.0";
export const USER_AGENT =
  "BlocksDirecte/1.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148  EDMOBILE v8.0.0";

export class EdApiError extends Error {
  constructor(message: string, readonly code: number) {
    super(message);
    this.name = "EdApiError";
  }
}

export function createEdSession(): EdSession {
  return {};
}

function apiError(response: ApiResponse<unknown>): EdApiError {
  const messages: Record<number, string> = {
    505: "Identifiant ou mot de passe incorrect.",
    517: "La version de l'API École Directe n'est plus acceptée.",
    520: "La session École Directe est invalide.",
    525: "La session École Directe a expiré. Reconnecte-toi."
  };
  return new EdApiError(
    response.message || messages[response.code] || `Erreur École Directe (${response.code}).`,
    response.code
  );
}

async function fetchLogged(url: string, init: RequestInit, _endpoint: string): Promise<Response> {
  return fetch(url, init);
}

async function logRawResponse(response: Response, _endpoint: string): Promise<string> {
  return response.text();
}

async function readResponse<T>(response: Response, endpoint: string): Promise<ApiResponse<T>> {
  let result: ApiResponse<T>;
  const rawBody = await logRawResponse(response, endpoint);
  try {
    result = JSON.parse(rawBody) as ApiResponse<T>;
  } catch {
    throw new Error(`Réponse École Directe illisible pour ${endpoint}.`);
  }
  if (!response.ok) {
    throw new Error(`École Directe ne répond pas (${response.status}).`);
  }
  return result;
}

async function request<T>(
  session: EdSession,
  path: string,
  verb: "get" | "post",
  body: unknown,
  query = ""
): Promise<T> {
  const token = session.token;
  const authenticationHeader: Record<string, string> = {};
  if (token) {
    authenticationHeader["X-Token"] = token;
  }
  const requestUrl = `${API_BASE}${path}?${query ? `${query}&` : ""}verbe=${verb}&v=${API_VERSION}`;
  const response = await fetchLogged(requestUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
      ...authenticationHeader
    },
    body: `data=${encodeURIComponent(JSON.stringify(body))}`
  }, `${verb.toUpperCase()} ${path}`);
  const result = await readResponse<T>(response, `${verb.toUpperCase()} ${path}`);
  if (result.token) {
    session.token = result.token;
  }
  if (result.code !== 200) throw apiError(result);
  return result.data;
}

async function getGtk(): Promise<string> {
  const url = `${API_BASE}/v3/login.awp?gtk=1&v=${API_VERSION}`;
  const response = await fetchLogged(url, {
    headers: { "User-Agent": USER_AGENT }
  }, "GTK GET /v3/login.awp");
  await logRawResponse(response, "GTK GET /v3/login.awp");
  const cookies = response.headers.get("set-cookie") || response.headers.get("set-cookie2") || "";
  const gtk = cookies.match(/GTK=([A-Za-z0-9]+)/i)?.[1];
  if (!gtk) throw new Error("École Directe n'a pas transmis le cookie de connexion GTK.");
  return gtk;
}

export async function login(
  session: EdSession,
  username: string,
  password: string,
  uuid: string,
  factors?: { cn: string; cv: string }
): Promise<void> {
  const client = session.client ?? new Client();
  session.client = client;

  try {
    const result = await client.auth.loginUsername(
      username,
      password,
      factors?.cn,
      factors?.cv,
      true,
      uuid
    );
    session.loginResponse = result;
    const accounts = result.accounts as unknown as StudentAccount[];
    const profileAccountIndex = accounts.findIndex((account) => account.profile?.eleves?.length);
    const studentIndex = accounts.findIndex((account) => account.typeCompte === "E");
    const accountIndex = profileAccountIndex >= 0 ? profileAccountIndex : studentIndex >= 0 ? studentIndex : 0;
    const account = accounts[accountIndex];
    if (!account) throw new Error("Aucun compte École Directe n'est associé à ces identifiants.");

    const pupils = account.profile?.eleves?.filter((pupil) => pupil.id) ??
      accounts.filter((candidate) => candidate.typeCompte === "E");
    if (pupils.length === 0 && account.typeCompte === "E") pupils.push(account);
    if (pupils.length === 0) throw new Error("Aucun élève n'est associé à ce profil École Directe.");

    client.auth.setAccount(accountIndex);
    session.token = result.token;
    session.loginChallengeToken = undefined;
    session.student = account;
    session.pupils = pupils;
    session.accessToken = account.accessToken || account.accesstoken;
    session.twoFactorFactors = factors;
  } catch (error) {
    const is2FA = error instanceof Require2FA ||
      (error as { name?: string })?.name === "Require2FA" ||
      (error as { code?: number })?.code === 250;
    if (is2FA) {
      session.loginChallengeToken = (error as { token?: string })?.token || session.token;
      throw new EdApiError((error as Error).message || "Une vérification de sécurité est nécessaire.", 250);
    }
    throw error;
  }
}

export async function relogin(
  session: EdSession,
  username: string,
  uuid: string,
  accessToken: string,
  accountType = "E",
  factors?: { cn: string; cv: string }
): Promise<void> {
  session.gtk ||= await getGtk();
  const reloginUrl = `${API_BASE}/v3/login.awp?v=${API_VERSION}`;
  const response = await fetchLogged(reloginUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
      "X-Gtk": session.gtk
    },
    body: `data=${encodeURIComponent(
      JSON.stringify({
        identifiant: username,
        uuid,
        isReLogin: true,
        motdepasse: "",
        typeCompte: accountType,
        accesstoken: accessToken,
        ...(factors ? { fa: [{ cn: factors.cn, cv: factors.cv }] } : {})
      })
    )}`
  }, "Relogin POST /v3/login.awp");
  const result = await readResponse<{ accounts: StudentAccount[] }>(response, "Relogin POST /v3/login.awp");
  session.token = result.token || undefined;
  if (result.code !== 200) throw apiError(result);
  const accounts = result.data?.accounts || [];
  const profileAccount = accounts.find((account) => account.profile?.eleves?.length);
  const student = profileAccount || accounts.find((account) => account.typeCompte === "E") || accounts[0];
  if (!student) throw new Error("Aucun compte associé lors du renouvellement de la session.");
  session.student = student;
  session.pupils = student.profile?.eleves?.filter((pupil) => pupil.id) ??
    accounts.filter((account) => account.typeCompte === "E");
  if (session.pupils.length === 0 && student.typeCompte === "E") session.pupils = [student];
  session.accessToken = student.accesstoken || student.accessToken || accessToken;
  session.twoFactorFactors = factors;
}

function decodeBase64(value: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes: number[] = [];
  let buffer = 0;
  let bitCount = 0;
  for (const character of normalized) {
    if (character === "=") break;
    const digit = alphabet.indexOf(character);
    if (digit < 0) continue;
    buffer = (buffer << 6) | digit;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((buffer >> bitCount) & 0xff);
    }
  }
  const encoded = bytes.map((byte) => `%${byte.toString(16).padStart(2, "0")}`).join("");
  try {
    return decodeURIComponent(encoded);
  } catch {
    return bytes.map((byte) => String.fromCharCode(byte)).join("");
  }
}

export async function fetchLoginChallenge(session: EdSession): Promise<LoginChallenge> {
  const challengeToken = session.loginChallengeToken || session.token;
  if (!session.client || !challengeToken) {
    throw new EdApiError("Aucun challenge de connexion École Directe n'est actif.", 520);
  }
  const challenge = await session.client.auth.get2FAQuestion(challengeToken);
  return {
    question: challenge.question,
    options: challenge.propositions.map((value) => ({ label: value, value }))
  };
}

export async function resolveLoginChallenge(
  session: EdSession,
  selectedOption: string
): Promise<{ cn: string; cv: string }> {
  const challengeToken = session.loginChallengeToken || session.token;
  if (!session.client || !challengeToken) {
    throw new EdApiError("Aucun challenge de connexion École Directe n'est actif.", 520);
  }
  return session.client.auth.send2FAQuestion(selectedOption, challengeToken);
}

function dayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function plainText(value: string): string {
  return value
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/@page\s*\{[^}]*\}/gi, " ")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function parseEdDate(dateStr: string): number {
  if (!dateStr) return 0;
  if (dateStr.includes("/")) {
    const [day, month, year] = dateStr.slice(0, 10).split("/");
    return new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00`).getTime() || 0;
  }
  return new Date(dateStr).getTime() || 0;
}

export async function fetchSchoolData(
  session: EdSession,
  homeworkDays: number,
  student: EdPupil,
  timetableDate = new Date()
): Promise<SchoolData> {
  if (!session.token) throw new Error("Aucun compte École Directe connecté.");
  const studentId = student.id;
  const timetableDayKey = dayKey(timetableDate);
  const [courses, homeworkDaysData, gradeData] = await Promise.all([
    request<Array<{ matiere?: string; text?: string; start_date?: string; end_date?: string; salle?: string; prof?: string }>>(
      session,
      `/v3/E/${studentId}/emploidutemps.awp`,
      "get",
      { dateDebut: timetableDayKey, dateFin: timetableDayKey, avecTrous: false }
    ),
    Promise.all(
      Array.from({ length: homeworkDays }, (_, offset) => {
        const date = new Date(timetableDate);
        date.setDate(timetableDate.getDate() + offset);
        const key = dayKey(date);
        return request<{ matieres?: { matiere?: string; effectue?: boolean; aFaire?: { contenu?: string; effectue?: boolean } }[] }>(
          session,
          `/v3/Eleves/${studentId}/cahierdetexte/${key}.awp`,
          "get",
          {}
        )
          .then((result) => ({ key, result }))
          .catch(() => ({ key, result: { matieres: [] } }));
      })
    ),
    request<EcoleDirecteGradeData>(
      session,
      `/v3/eleves/${studentId}/notes.awp`,
      "get",
      { anneeScolaire: "" }
    )
  ]);

  const mappedCourses = courses.map((course) => ({
    subject: course.matiere || course.text || "Cours",
    start: course.start_date || "",
    end: course.end_date || "",
    room: course.salle || "",
    teacher: course.prof || ""
  })).sort((first, second) => {
    const firstTime = first.start.match(/(\d{2}):(\d{2})/);
    const secondTime = second.start.match(/(\d{2}):(\d{2})/);
    const firstMinutes = firstTime ? Number(firstTime[1]) * 60 + Number(firstTime[2]) : Number.MAX_SAFE_INTEGER;
    const secondMinutes = secondTime ? Number(secondTime[1]) * 60 + Number(secondTime[2]) : Number.MAX_SAFE_INTEGER;
    return firstMinutes - secondMinutes;
  });

  const homeworks = homeworkDaysData.flatMap(({ key, result }) =>
    (result.matieres || []).flatMap((item) => {
      const content = item.aFaire?.contenu ? decodeBase64(item.aFaire.contenu) : "";
      return content
        ? [{
            subject: item.matiere || "Devoir",
            content,
            preview: plainText(content),
            dueDate: key,
            done: item.aFaire?.effectue ?? item.effectue ?? false
          }]
        : [];
    })
  );

  const sortedNotes = [...(gradeData.notes || [])].sort((first, second) => {
    const timeFirst = parseEdDate(first.dateSaisie || first.date || "");
    const timeSecond = parseEdDate(second.dateSaisie || second.date || "");
    return timeSecond - timeFirst;
  });
  const now = Date.now();
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
  const grades = sortedNotes.flatMap((note) => {
    const date = note.dateSaisie || note.date || "";
    const timestamp = parseEdDate(date);
    if (timestamp < thirtyDaysAgo || timestamp > now) return [];
    const classAverage = note.moyenneClasse === undefined || note.moyenneClasse === null || note.moyenneClasse === ""
      ? undefined
      : `Moy. classe : ${note.moyenneClasse}${note.noteSur ? ` / ${note.noteSur}` : ""}`;
    return [{
      subject: note.libelleMatiere || "Note",
      value: `${note.valeur ?? ""}${note.noteSur ? ` / ${note.noteSur}` : ""}`,
      date,
      ...(classAverage ? { classAverage } : {})
    }];
  });
  const competencyRecords = [
    ...Object.values(gradeData.LSUN || {}).flat(),
    ...(gradeData.notes || []).flatMap((note) => [...(note.elementsProgramme || []), ...(note.elementsProg || [])])
  ];
  const seenCompetencies = new Set<string>();
  const competencies = competencyRecords.flatMap((item) => {
    const label = item.label || (item as CompetenceItem & { libelleElementProgramme?: string }).libelleElementProgramme;
    if (!label) return [];
    const subject = item.subject || (item as CompetenceItem & { libelleMatiere?: string }).libelleMatiere || "Compétence";
    const rawValue = item.value ?? (item as CompetenceItem & { valeur?: string | number; afc?: string | number }).valeur ??
      (item as CompetenceItem & { afc?: string | number }).afc;
    const value = rawValue === undefined ? "" : String(rawValue);
    const key = `${subject}|${label}|${value}`;
    if (seenCompetencies.has(key)) return [];
    seenCompetencies.add(key);
    return [{ subject, label, value }];
  });

  return {
    student: {
      ...student,
      photo: await inlinePhoto(formatEcoleDirectePhoto(student.photo), "ECOLEDIRECTE", {
        "User-Agent": USER_AGENT,
        Referer: "https://www.ecoledirecte.com/"
      }, photoCacheKey("ecoleDirecte", student.id))
    },
    courses: mappedCourses,
    homeworks,
    grades,
    competencies,
    latestGrade: grades[0] ?? null,
    syncedAt: new Date().toISOString()
  };
}

export async function fetchStudentsSchoolData(
  session: EdSession,
  homeworkDays: number,
  timetableDate = new Date()
): Promise<SchoolData[]> {
  if (!session.token) throw new Error("Aucun compte École Directe connecté.");
  const pupils = session.pupils ?? (session.student?.typeCompte === "E" ? [session.student] : []);
  if (pupils.length === 0) throw new Error("Aucun élève n'est disponible dans ce profil École Directe.");

  return Promise.all(pupils.map(async (student) => {
    try {
      return await fetchSchoolData(session, homeworkDays, student, timetableDate);
    } catch (error) {
      return {
        student,
        courses: [],
        homeworks: [],
        grades: [],
        competencies: [],
        latestGrade: null,
        syncedAt: new Date().toISOString(),
        error: (error as Error).message,
        errorCode: (error as { code?: number }).code
      };
    }
  }));
}

export async function fetchCourseSlots(session: EdSession, student: EdPupil, from: Date, to: Date): Promise<CourseSlot[]> {
  if (!session.token) throw new Error("Aucun compte École Directe connecté.");
  const courses = await request<Array<{ start_date?: string; end_date?: string; isAnnule?: boolean }>>(
    session,
    `/v3/E/${student.id}/emploidutemps.awp`,
    "get",
    { dateDebut: dayKey(from), dateFin: dayKey(to), avecTrous: false }
  );
  return courses.map((course) => ({ start: course.start_date || "", end: course.end_date || "", canceled: !!course.isAnnule }));
}

type EdMessage = {
  id?: number | string;
  subject?: string;
  date?: string;
  read?: boolean;
  from?: { name?: string; civilite?: string; prenom?: string; nom?: string };
};

function schoolYear(date: Date): string {
  const start = date.getMonth() >= 7 ? date.getFullYear() : date.getFullYear() - 1;
  return `${start}-${start + 1}`;
}

// The mailbox belongs to the logged account (family or student), not to each child.
export async function fetchMessages(session: EdSession, count: number, now = new Date()): Promise<MessageItem[]> {
  if (!session.token || !session.student) throw new Error("Aucun compte École Directe connecté.");
  const owner = session.student.typeCompte === "E" ? "eleves" : "familles";
  const base = `/v3/${owner}/${session.student.id}/messages`;
  const body = { anneeMessages: schoolYear(now) };
  const list = await request<{ messages?: { received?: EdMessage[] } }>(
    session,
    `${base}.awp`,
    "get",
    body,
    `force=false&typeRecuperation=received&idClasseur=0&orderBy=date&order=desc&query=&onlyRead=&page=0&itemsPerPage=${count}&getAll=0`
  );
  const received = (list.messages?.received || []).slice(0, count);
  const items: MessageItem[] = [];
  for (const message of received) {
    let preview = "";
    try {
      const detail = await request<{ content?: string }>(session, `${base}/${message.id}.awp`, "get", body, "mode=destinataire");
      preview = plainText(decodeBase64(detail.content || ""));
    } catch (error) {
      console.warn("[ED] Message content unavailable", { id: message.id, error: error instanceof Error ? error.message : String(error) });
    }
    const sender = message.from;
    items.push({
      id: String(message.id ?? items.length),
      subject: message.subject || "(sans objet)",
      from: sender?.name || [sender?.civilite, sender?.prenom, sender?.nom].filter(Boolean).join(" ") || "École Directe",
      date: (message.date || "").replace(" ", "T"),
      read: !!message.read,
      preview
    });
  }
  return items;
}

// Without `fixedDay`, shows the first day (today included) that still has a course to come.
export async function fetchStudentsSchoolDataWithAutoAdvance(
  session: EdSession,
  homeworkDays: number,
  fixedDay?: Date
): Promise<{ data: SchoolData[]; selectedDay: Date }> {
  let selectedDay = fixedDay ? noonOf(fixedDay) : undefined;
  if (!selectedDay) {
    const now = new Date();
    const { from, to } = lookaheadRange(now);
    const pupils = session.pupils ?? (session.student?.typeCompte === "E" ? [session.student] : []);
    const slots = (await Promise.all(pupils.map((pupil) => fetchCourseSlots(session, pupil, from, to).catch((error) => {
      console.warn("[ED] Course lookahead failed:", (error as Error).message);
      return [];
    })))).flat();
    selectedDay = firstCourseDay(slots, now) ?? noonOf(now);
  }
  const data = await fetchStudentsSchoolData(session, homeworkDays, selectedDay);
  return { data, selectedDay };
}