import type { EdSession, SchoolData } from "../ecoleDirecte";
import type { ParentClient } from "pronotets";
import type { School, Skolengo } from "skolengojs";

export type ProviderType = "ecoleDirecte" | "skolengo" | "pronote";
export type DomainType = "courses" | "homeworks" | "grades" | "photo";

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
