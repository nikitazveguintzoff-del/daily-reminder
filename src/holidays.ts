import * as SecureStore from "expo-secure-store";
import type { HolidayPeriod } from "./providers/types";

export type SchoolZone = "A" | "B" | "C";

export const HOLIDAY_ZONE_KEY = "tempo-holiday-zone-v1";

export const SCHOOL_HOLIDAYS: Record<SchoolZone, HolidayPeriod[]> = {
  A: [
    { name: "Vacances de Toussaint", startDate: "2026-10-17", endDate: "2026-11-02" },
    { name: "Vacances de Noël", startDate: "2026-12-19", endDate: "2027-01-04" },
    { name: "Vacances d'Hiver", startDate: "2027-02-13", endDate: "2027-03-01" },
    { name: "Vacances de Printemps", startDate: "2027-04-10", endDate: "2027-04-26" },
    { name: "Vacances d'Été", startDate: "2027-07-03", endDate: "2027-09-02" },
    { name: "Vacances de Toussaint", startDate: "2027-10-23", endDate: "2027-11-08" },
    { name: "Vacances de Noël", startDate: "2027-12-18", endDate: "2028-01-03" },
    { name: "Vacances d'Hiver", startDate: "2028-02-19", endDate: "2028-03-06" },
    { name: "Vacances de Printemps", startDate: "2028-04-22", endDate: "2028-05-09" }
  ],
  B: [
    { name: "Vacances de Toussaint", startDate: "2026-10-17", endDate: "2026-11-02" },
    { name: "Vacances de Noël", startDate: "2026-12-19", endDate: "2027-01-04" },
    { name: "Vacances d'Hiver", startDate: "2027-02-20", endDate: "2027-03-08" },
    { name: "Vacances de Printemps", startDate: "2027-04-17", endDate: "2027-05-03" },
    { name: "Vacances d'Été", startDate: "2027-07-03", endDate: "2027-09-02" },
    { name: "Vacances de Toussaint", startDate: "2027-10-23", endDate: "2027-11-08" },
    { name: "Vacances de Noël", startDate: "2027-12-18", endDate: "2028-01-03" },
    { name: "Vacances d'Hiver", startDate: "2028-02-05", endDate: "2028-02-21" },
    { name: "Vacances de Printemps", startDate: "2028-04-08", endDate: "2028-04-24" }
  ],
  C: [
    { name: "Vacances de Toussaint", startDate: "2026-10-17", endDate: "2026-11-02" },
    { name: "Vacances de Noël", startDate: "2026-12-19", endDate: "2027-01-04" },
    { name: "Vacances d'Hiver", startDate: "2027-02-06", endDate: "2027-02-22" },
    { name: "Vacances de Printemps", startDate: "2027-04-03", endDate: "2027-04-19" },
    { name: "Vacances d'Été", startDate: "2027-07-03", endDate: "2027-09-02" },
    { name: "Vacances de Toussaint", startDate: "2027-10-23", endDate: "2027-11-08" },
    { name: "Vacances de Noël", startDate: "2027-12-18", endDate: "2028-01-03" },
    { name: "Vacances d'Hiver", startDate: "2028-02-12", endDate: "2028-02-28" },
    { name: "Vacances de Printemps", startDate: "2028-04-15", endDate: "2028-05-02" }
  ]
};

export async function getSavedZone(): Promise<SchoolZone> {
  try {
    const saved = await SecureStore.getItemAsync(HOLIDAY_ZONE_KEY);
    if (saved === "A" || saved === "B" || saved === "C") return saved;
  } catch {
    // Ignore error
  }
  return "C"; // Default Zone C (Paris, Toulouse, Montpellier...)
}

export async function saveZone(zone: SchoolZone): Promise<void> {
  try {
    await SecureStore.setItemAsync(HOLIDAY_ZONE_KEY, zone);
  } catch {
    // Ignore error
  }
}

export function getCurrentOrNextHoliday(zone: SchoolZone, refDate = new Date()): {
  currentHoliday: HolidayPeriod | null;
  nextHoliday: HolidayPeriod | null;
  daysUntilNext: number | null;
} {
  const dateStr = [
    refDate.getFullYear(),
    String(refDate.getMonth() + 1).padStart(2, "0"),
    String(refDate.getDate()).padStart(2, "0")
  ].join("-");
  const list = SCHOOL_HOLIDAYS[zone] || [];

  const currentHoliday = list.find((item) => dateStr >= item.startDate && dateStr < item.endDate) || null;

  const upcoming = list
    .filter((item) => item.endDate > dateStr && item.startDate > dateStr)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));

  const nextHoliday = upcoming[0] || null;

  let daysUntilNext: number | null = null;
  if (nextHoliday) {
    const start = new Date(nextHoliday.startDate).getTime();
    const now = new Date(dateStr).getTime();
    daysUntilNext = Math.ceil((start - now) / (1000 * 60 * 60 * 24));
  }

  return { currentHoliday, nextHoliday, daysUntilNext };
}
