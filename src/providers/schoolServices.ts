import { Buffer } from "buffer";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { ParentClient } from "pronotets";
import {
  ChallengeMethod,
  GetOIDCWellKnown,
  LoginWithToken,
  SearchSchools,
  School,
  type AuthFlow,
  type Skolengo
} from "skolengojs";
import { pronoteLog, type PronoteSsoCapture } from "./pronoteSso";
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

function pronoteStudents(session: ParentClient): ProviderStudent[] {
  return session.children.map((child) => ({
    id: child.id,
    firstName: child.name.split(" ")[0] || child.name,
    lastName: child.name.split(" ").slice(1).join(" "),
    className: child.className,
    photo: child.profilePicture?.url
  }));
}

function pronoteConnection(session: ParentClient, credentials: PronoteSnapshot): PronoteConnection {
  return {
    session,
    url: credentials.url,
    parentName: session.info.name || "Compte parent",
    refreshToken: JSON.stringify(credentials),
    students: pronoteStudents(session)
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

async function loginWithToken(snapshot: PronoteSnapshot, reason: "connect" | "restore"): Promise<PronoteConnection> {
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
    return pronoteConnection(session, {
      v: 4,
      url: snapshot.url,
      username: renewed.username,
      token: renewed.password,
      uuid: renewed.uuid
    });
  } catch (error) {
    await recordPronoteFailure(error);
    throw error;
  } finally {
    pronoteTrafficDepth--;
  }
}
let pronoteLoginInFlight: Promise<PronoteConnection> | null = null;

function serializedLogin(run: () => Promise<PronoteConnection>): Promise<PronoteConnection> {
  pronoteLoginInFlight ??= run().finally(() => {
    pronoteLoginInFlight = null;
  });
  return pronoteLoginInFlight;
}

export function connectPronoteSso(capture: PronoteSsoCapture): Promise<PronoteConnection> {
  return serializedLogin(async () => {
    pronoteLog("connect: requested", { pronoteHost: hostOf(capture.url) });
    await assertPronoteAllowed("connect");
    await SecureStore.setItemAsync(PRONOTE_LAST_ATTEMPT_KEY, String(Date.now()));
    return loginWithToken({ v: 4, url: capture.url, username: capture.username, token: capture.token, uuid: capture.uuid }, "connect");
  });
}

export function restorePronote(snapshot: string): Promise<PronoteConnection> {
  return serializedLogin(async () => {
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
    return loginWithToken(saved, "restore");
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

async function fetchSkolengoAgenda(
  student: Skolengo,
  studentId: string,
  date: Date
): Promise<SkolengoAgendaData> {
  await student.refreshAccessToken();
  const { accessToken, school } = student as unknown as { accessToken: string; school: School };
  const dateKey = date.toISOString().slice(0, 10);
  const query = new URLSearchParams({
    "page[limit]": "50",
    include: "lessons,lessons.subject,lessons.teachers,homeworkAssignments,homeworkAssignments.subject",
    "fields[cateringService]": "title,startDateTime,endDateTime",
    "fields[lesson]": "title,startDateTime,endDateTime,location,canceled,anyContent,anyHomeworkToDoForTheLesson,anyHomeworkToDoAfterTheLesson,subject,teachers",
    "fields[homework]": "title,done,dueDateTime,subject,html,deliverWorkOnline,onlineDeliveryUrl",
    "fields[teacher]": "firstName,lastName,title",
    "filter[date][GE]": dateKey,
    "filter[student.id]": studentId,
    "filter[date][LE]": dateKey,
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
        teacher: teachers.join(", ")
      }];
    });
    for (const id of relationshipIds(day, "homeworkAssignments")) {
      const homework = included.get(`homework:${id}`);
      if (!homework) continue;
      const attributes = homework.attributes || {};
      const subject = included.get(`subject:${relationId(homework, "subject") || ""}`);
      const consigne = String(attributes.consigne || attributes.instructions || "");
      const exercice = String(attributes.exercice || attributes.exercise || attributes.html || "");
      const content = [
        consigne ? `<p><strong>Consigne :</strong> ${consigne}</p>` : "",
        exercice ? `<p><strong>Exercice :</strong> ${exercice}</p>` : ""
      ].filter(Boolean).join("") || String(attributes.html || "");
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
  homeworkDays: number
): Promise<ProviderSchoolData> {
  const run = pronoteDataQueue.then(() => fetchPronoteDataNow(session, studentId, timetableDate, homeworkDays));
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
  // pronotets throws a TypeError when Pronote omits the homework list (no homework in range).
  const assignments = await logCall("homework", () => session.homework(timetableDate, homeworkEnd).catch((error) => {
    if (error instanceof TypeError) return [];
    throw error;
  }), true);
  const period = await logCall("currentPeriod", () => session.currentPeriod());
  const grades = await logCall("grades", () => period.grades(), true);

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
    const rawGrade = grade as unknown as { average?: string; classAverage?: string; outOf?: number };
    const avg = rawGrade.classAverage || (rawGrade.average ? `${rawGrade.average}${grade.outOf ? ` / ${grade.outOf}` : ""}` : undefined);
    return {
      subject: grade.subject.name,
      value: `${grade.grade}${grade.outOf ? ` / ${grade.outOf}` : ""}`,
      date: grade.date.toISOString(),
      ...(avg ? { classAverage: `Moy. classe : ${avg}` } : {})
    };
  });

  courses.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  homeworks.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  mappedGrades.sort((a, b) => b.date.localeCompare(a.date));

  return { courses, homeworks, grades: mappedGrades, competencies: [] };
}

export async function fetchSkolengoData(
  account: Skolengo,
  studentId: string,
  timetableDate: Date,
  homeworkDays: number
): Promise<ProviderSchoolData> {
  const student = [...(account.kids ?? []), account].find((candidate) => candidate.userId === studentId);
  if (!student) throw new Error("Élève Skolengo introuvable dans cette connexion.");
  const homeworkEnd = new Date(timetableDate);
  homeworkEnd.setDate(homeworkEnd.getDate() + homeworkDays);
  const agenda = await fetchSkolengoAgenda(student, studentId, timetableDate);
  let assignments: Awaited<ReturnType<Skolengo["GetAssignments"]>>;
  try {
    assignments = await student.GetAssignments(timetableDate, homeworkEnd);
  } catch (error) {
    console.warn("[SKOLENGO] homework-assignments failed:", (error as Error).message);
    assignments = [];
  }
  let grades: Awaited<ReturnType<Skolengo["GetLastGrades"]>> = [];
  let gradesError: string | undefined;
  try {
    grades = await student.GetLastGrades(30);
  } catch (error) {
    gradesError = `Notes Skolengo indisponibles : ${(error as Error).message}`;
  }
  const homeworkItems = new Map(agenda.homeworks.map((homework) => [homework.id, homework]));
  for (const assignment of assignments) {
    const rawAssignment = assignment as unknown as { consigne?: string; exercice?: string; html: string };
    const consigne = String(rawAssignment.consigne || "");
    const exercice = String(rawAssignment.exercice || rawAssignment.html || "");
    const content = [
      consigne ? `<p><strong>Consigne :</strong> ${consigne}</p>` : "",
      exercice ? `<p><strong>Exercice :</strong> ${exercice}</p>` : ""
    ].filter(Boolean).join("") || rawAssignment.html;

    homeworkItems.set(assignment.id, {
      id: assignment.id,
      subject: assignment.subject.label || assignment.title || "Devoir",
      content,
      preview: homeworkPreview(content),
      dueDate: assignment.dueDateTime.toISOString(),
      done: assignment.done
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
