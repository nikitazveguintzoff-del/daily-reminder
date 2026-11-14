import { rpc } from "./web/rpc";
import type * as Native from "./ecoleDirecte";
export type { CourseItem, HomeworkItem, GradeItem, CompetenceItem, EdPupil, EdSession, LoginChallenge, SchoolData } from "./ecoleDirecte";

export const USER_AGENT = "Tempo local development";
export function formatEcoleDirectePhoto(photo?: string): string | undefined {
  if (photo?.startsWith("//")) return `https:${photo}`;
  if (photo?.startsWith("/")) return `https://www.ecoledirecte.com${photo}`;
  return photo;
}
export function createEdSession(): Native.EdSession { return {}; }

const handles = new WeakMap<Native.EdSession, string>();
async function call<T>(method: string, session: Native.EdSession, args: unknown[]): Promise<T> {
  let handle = handles.get(session);
  if (!handle) {
    handle = await rpc<string>("ed.create", []);
    handles.set(session, handle);
  }
  const result = await rpc<{ session: Native.EdSession; value: T; error?: string; code?: number }>("ed.call", [handle, method, args]);
  Object.assign(session, result.session);
  if (result.error) throw Object.assign(new Error(result.error), { code: result.code });
  return result.value;
}
export const login: typeof Native.login = (session, ...args) => call("login", session, args);
export const relogin: typeof Native.relogin = (session, ...args) => call("relogin", session, args);
export const fetchLoginChallenge: typeof Native.fetchLoginChallenge = (session) => call("fetchLoginChallenge", session, []);
export const resolveLoginChallenge: typeof Native.resolveLoginChallenge = (session, answer) => call("resolveLoginChallenge", session, [answer]);
export const fetchSchoolData: typeof Native.fetchSchoolData = (session, ...args) => call("fetchSchoolData", session, args);
export const fetchCourseSlots: typeof Native.fetchCourseSlots = (session, ...args) => call("fetchCourseSlots", session, args);
export const fetchMessages: typeof Native.fetchMessages = (session, ...args) => call("fetchMessages", session, args);
export const fetchStudentsSchoolDataWithAutoAdvance: typeof Native.fetchStudentsSchoolDataWithAutoAdvance = async (session, ...args) => {
  const result = await call<Awaited<ReturnType<typeof Native.fetchStudentsSchoolDataWithAutoAdvance>>>("fetchStudentsSchoolDataWithAutoAdvance", session, args);
  return { ...result, selectedDay: new Date(result.selectedDay) };
};
