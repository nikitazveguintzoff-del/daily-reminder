import { fetchCourseSlots, fetchSchoolData, type EdSession, type SchoolData } from "./ecoleDirecte";
import { fetchPronoteCourseSlots, fetchPronoteData, fetchSkolengoCourseSlots, fetchSkolengoData } from "./providers/schoolServices";
import { firstCourseDay, lookaheadRange, noonOf, type CourseSlot } from "./courseDay";
import type { ChildProfile, ProviderAccount, ProviderSchoolData, ProviderSession, ProviderType } from "./providers/types";
import * as SecureStore from "expo-secure-store";
import { providerTokenKey } from "./accountStorage";

function tokenSaver(account: ProviderAccount) {
  return async (token: string) => {
    if (account.refreshToken === token) return;
    const key = providerTokenKey(account.id);
    if (await SecureStore.getItemAsync(key)) await SecureStore.setItemAsync(key, token);
    account.refreshToken = token;
  };
}

// First day (today included) on which a course of any child's timetable source is still to come.
export async function findFirstCourseDay(
  children: ChildProfile[],
  accounts: ProviderAccount[],
  sessions: Map<string, ProviderSession>,
  now = new Date()
): Promise<Date> {
  const { from, to } = lookaheadRange(now);
  const slots: CourseSlot[] = [];
  const seen = new Set<string>();
  for (const child of children) {
    const provider = child.sources.courses;
    const link = provider ? child.links[provider] : undefined;
    if (!provider || !link || seen.has(`${provider}:${link.accountId}:${link.studentId}`)) continue;
    seen.add(`${provider}:${link.accountId}:${link.studentId}`);
    const account = accounts.find((item) => item.id === link.accountId && item.provider === provider);
    const session = sessions.get(link.accountId);
    if (!account || !session) continue;
    try {
      if (provider === "ecoleDirecte") {
        const edSession = session as EdSession;
        const pupil = edSession.pupils?.find((item) => String(item.id) === link.studentId);
        if (pupil) slots.push(...await fetchCourseSlots(edSession, pupil, from, to));
      } else if (provider === "pronote") {
        slots.push(...await fetchPronoteCourseSlots(session as Extract<ProviderSession, { children: unknown }>, link.studentId, from, to));
      } else {
        slots.push(...await fetchSkolengoCourseSlots(session as Extract<ProviderSession, { GetTimetable: unknown }>, link.studentId, from, to, tokenSaver(account)));
      }
    } catch (error) {
      console.warn("[SYNC] Emploi du temps indisponible pour choisir le jour", { provider, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const day = firstCourseDay(slots, now) ?? noonOf(now);
  console.info("[SYNC] Jour affiché", { day: day.toDateString(), slots: slots.length });
  return day;
}

// Both foreground and headless tasks honour the same per-child source choices.
export async function syncChildren(
  children: ChildProfile[],
  accounts: ProviderAccount[],
  sessions: Map<string, ProviderSession>,
  date: Date,
  homeworkDays: number,
  connectionErrors = new Map<string, string>()
): Promise<SchoolData[]> {
  const combined: SchoolData[] = [];
  for (const [index, child] of children.entries()) {
    const results: Partial<Record<ProviderType, ProviderSchoolData>> = {};
    const errors: string[] = [];
    for (const provider of new Set(Object.values(child.sources).filter((value): value is ProviderType => value !== null))) {
      const link = child.links[provider];
      const account = link && accounts.find((item) => item.id === link.accountId && item.provider === provider);
      const session = link && sessions.get(link.accountId);
      try {
        if (!link || !account || !session) throw new Error((link && connectionErrors.get(link.accountId)) || `${provider} n'est pas connecté.`);
        const saveToken = tokenSaver(account);
        if (provider === "ecoleDirecte") {
          const edSession = session as EdSession;
          const pupil = edSession.pupils?.find((item) => String(item.id) === link.studentId);
          if (!pupil) throw new Error("Élève École Directe indisponible.");
          const data = await fetchSchoolData(edSession, homeworkDays, pupil, date);
          if (data.error) throw new Error(data.error);
          results[provider] = { ...data, studentPhoto: data.student.photo };
        } else if (provider === "pronote") {
          results[provider] = await fetchPronoteData(session as Extract<ProviderSession, { children: unknown }>, link.studentId, date, homeworkDays, saveToken);
        } else {
          results[provider] = await fetchSkolengoData(session as Extract<ProviderSession, { GetTimetable: unknown }>, link.studentId, date, homeworkDays, saveToken);
        }
      } catch (error) {
        console.warn("[SYNC] Source failed", { provider, error: error instanceof Error ? error.message : String(error) });
        errors.push(`${provider} : ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Lists read account photos; the raw provider URL needs session/Referer headers the UI cannot send.
    for (const [provider, result] of Object.entries(results) as [ProviderType, ProviderSchoolData][]) {
      const link = child.links[provider];
      const student = link && accounts.find((item) => item.id === link.accountId && item.provider === provider)
        ?.students.find((item) => item.id === link.studentId);
      if (student && result.studentPhoto?.startsWith("data:image/")) student.photo = result.studentPhoto;
    }
    const grades = child.sources.grades ? results[child.sources.grades] : undefined;
    if (grades?.gradesError) errors.push(grades.gradesError);
    const photoProvider = child.sources.photo;
    const photoLink = photoProvider ? child.links[photoProvider] : undefined;
    const photo = photoProvider
      ? results[photoProvider]?.studentPhoto || accounts.find((item) => item.id === photoLink?.accountId)?.students.find((item) => item.id === photoLink?.studentId)?.photo
      : undefined;
    combined.push({
      student: { id: index + 1, prenom: child.firstName, nom: child.lastName, photo, classe: { libelle: child.className } },
      courses: child.sources.courses ? results[child.sources.courses]?.courses || [] : [],
      homeworks: child.sources.homeworks ? results[child.sources.homeworks]?.homeworks || [] : [],
      grades: grades?.grades || [],
      competencies: grades?.competencies || [],
      latestGrade: grades?.grades[0] || null,
      gradesError: grades?.gradesError,
      syncedAt: new Date().toISOString(),
      ...(errors.length ? { error: errors.join(" ") } : {})
    });
  }
  return combined;
}
