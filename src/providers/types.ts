import type { EdSession, SchoolData } from "../ecoleDirecte";
import type { ParentClient } from "pronotets";
import type { School, Skolengo } from "skolengojs";

export type ProviderType = "ecoleDirecte" | "skolengo" | "pronote";
export type DomainType = "courses" | "homeworks" | "grades" | "photo" | "messages";
export const DOMAIN_TYPES: DomainType[] = ["courses", "homeworks", "grades", "photo", "messages"];

export type MessageItem = {
  id: string;
  subject: string;
  from: string;
  date: string;
  read: boolean;
  preview: string;
};

export type ProviderStudent = {
  id: string;
  firstName: string;
  lastName: string;
  className: string;
  photo?: string;
};

export type ProviderStudentLink = {
  accountId: string;
  studentId: string;
};

export type ChildProfile = {
  id: string;
  firstName: string;
  lastName: string;
  className?: string;
  links: Partial<Record<ProviderType, ProviderStudentLink>>;
  sources: Record<DomainType, ProviderType | null>;
};

// Profiles saved before 1.4.0 have no messages source: default it to an already linked service.
export function withDefaultSources(child: ChildProfile): ChildProfile {
  const sources: Partial<Record<DomainType, ProviderType | null>> = child.sources || {};
  if (sources.messages !== undefined) return child;
  const linked = Object.keys(child.links || {}) as ProviderType[];
  const preferred = sources.homeworks ?? sources.courses ?? null;
  const messages = preferred && child.links[preferred] ? preferred : linked[0] ?? null;
  return { ...child, sources: { courses: null, homeworks: null, grades: null, photo: null, ...sources, messages } };
}

export type ProviderAccount = {
  id: string;
  provider: ProviderType;
  username: string;
  label: string;
  parentName?: string;
  url?: string;
  schoolId?: string;
  emsCode?: string;
  schoolName?: string;
  school?: School;
  deviceUUID?: string;
  refreshToken?: string;
  students: ProviderStudent[];
};

export type ProviderSession = EdSession | ParentClient | Skolengo;

export type ProviderSchoolData = Pick<SchoolData, "courses" | "homeworks" | "grades" | "competencies" | "gradesError"> & {
  studentPhoto?: string;
};

export type HolidayPeriod = {
  name: string;
  startDate: string;
  endDate: string;
};

export type HolidayConfig = {
  zone: "A" | "B" | "C";
  customPeriods: HolidayPeriod[];
};

export type NotificationFreezeConfig = {
  enabled: boolean;
  startDate: string;
  endDate: string;
};
