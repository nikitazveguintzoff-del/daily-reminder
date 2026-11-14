export type ReminderPreferences = {
  classes: { enabled: boolean; time: string };
  homework: { enabled: boolean; time: string };
  grades: { enabled: boolean; time: string };
  homeworkDays: number;
  freeze?: { enabled: boolean; startDate: string; endDate: string };
};

export const defaultPreferences: ReminderPreferences = {
  classes: { enabled: true, time: "07:00" },
  homework: { enabled: true, time: "17:00" },
  grades: { enabled: true, time: "18:00" },
  homeworkDays: 3,
  freeze: { enabled: false, startDate: "", endDate: "" }
};

export function normalizeTime(time: string): string {
  const parts = time.trim().split(":");
  if (parts.length !== 2) return time;
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return time;
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return time;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}
