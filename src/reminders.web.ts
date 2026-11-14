import type { ReminderPreferences } from "./reminderPreferences";
import type { SchoolData } from "./ecoleDirecte";
export { defaultPreferences, normalizeTime, type ReminderPreferences } from "./reminderPreferences";
export async function scheduleDailyReminders(_preferences: ReminderPreferences, _data: SchoolData[] | null): Promise<boolean> {
  console.info("[WEB] Notifications planifiées indisponibles dans le navigateur.");
  return false;
}
export async function sendTestNotifications(_preferences: ReminderPreferences, _data: SchoolData[] | null) {
  console.warn("[WEB] Les rappels doivent être testés sur Android.");
  return { sent: 0, permissionGranted: false };
}
