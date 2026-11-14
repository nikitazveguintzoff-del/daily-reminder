import { rpc, rpcWithToken } from "../web/rpc";
import type * as Native from "./schoolServices";
export type { PronoteConnection, SkolengoLoginStart } from "./schoolServices";

export const searchSkolengoSchools: typeof Native.searchSkolengoSchools = (query) => rpc("school.searchSkolengoSchools", [query]);
export const startSkolengoLogin: typeof Native.startSkolengoLogin = (school) => rpc("school.startSkolengoLogin", [school]);
export const finishSkolengoLogin: typeof Native.finishSkolengoLogin = (flow, url) => rpc("school.finishSkolengoLogin", [flow, url]);
export const restoreSkolengoLogin: typeof Native.restoreSkolengoLogin = (...args) => rpc("school.restoreSkolengoLogin", args);
export const connectPronoteSso: typeof Native.connectPronoteSso = async (capture, saveToken) => {
  const result = await rpc<Native.PronoteConnection>("school.connectPronoteSso", [capture]);
  await saveToken?.(result.refreshToken);
  return result;
};
export const restorePronote: typeof Native.restorePronote = async (snapshot, saveToken) => {
  const result = await rpc<Native.PronoteConnection>("school.restorePronote", [snapshot]);
  await saveToken?.(result.refreshToken);
  return result;
};
export const fetchPronoteData: typeof Native.fetchPronoteData = (session, studentId, date, days, saveToken) =>
  rpcWithToken("school.fetchPronoteData", [session, studentId, date, days], saveToken);
export const fetchPronoteCourseSlots: typeof Native.fetchPronoteCourseSlots = (session, studentId, from, to) =>
  rpcWithToken("school.fetchPronoteCourseSlots", [session, studentId, from, to]);
export const fetchSkolengoCourseSlots: typeof Native.fetchSkolengoCourseSlots = (account, studentId, from, to, saveToken) =>
  rpcWithToken("school.fetchSkolengoCourseSlots", [account, studentId, from, to], async (token) => {
    account.refreshToken = token;
    await saveToken?.(token);
  });
export const fetchSkolengoData: typeof Native.fetchSkolengoData = async (account, studentId, date, days, saveToken) => {
  return rpcWithToken("school.fetchSkolengoData", [account, studentId, date, days], async (token) => {
    account.refreshToken = token;
    await saveToken?.(token);
  });
};
