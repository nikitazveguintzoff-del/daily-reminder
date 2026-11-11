import type { SchoolData } from "./ecoleDirecte";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

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

export async function scheduleDailyReminders(
  preferences: ReminderPreferences,
  data: SchoolData[] | null
): Promise<boolean> {
  try {
    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) {
      permission = await Notifications.requestPermissionsAsync();
    }
    if (!permission.granted) return false;

    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("tempo-reminders", {
        name: "Rappels Tempo",
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: "#16866A",
        enableVibrate: true,
        showBadge: true
      });
    }

    await Notifications.cancelAllScheduledNotificationsAsync();

    const candidates = createReminderNotifications(preferences, data, new Date(), true);
    const pauseRange = activePauseRange(preferences);

    for (const reminder of candidates) {
      const normalized = normalizeTime(reminder.time);
      const [hour, minute] = normalized.split(":").map(Number);
      if (!Number.isInteger(hour) || !Number.isInteger(minute)) continue;

      const content = {
        title: reminder.title,
        body: reminder.body,
        sound: true,
        data: { screen: reminder.key }
      };

      if (!pauseRange) {
        await Notifications.scheduleNotificationAsync({
          content,
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DAILY, hour, minute }
        });
        continue;
      }

      // Un déclencheur quotidien ne peut pas sauter une plage de dates : on planifie chaque jour hors pause.
      const now = new Date();
      for (let offset = 0; offset < PAUSE_SCHEDULE_DAYS; offset++) {
        const when = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, hour, minute, 0, 0);
        const key = localDayKey(when);
        if (when.getTime() <= now.getTime() || (key >= pauseRange.startDate && key <= pauseRange.endDate)) continue;
        await Notifications.scheduleNotificationAsync({
          content,
          trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when }
        });
      }
    }

    return true;
  } catch (error) {
    console.error("[REMINDERS] Failed to schedule daily reminders:", error);
    return false;
  }
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

const PAUSE_SCHEDULE_DAYS = 21;

// Renvoie la pause si elle est activée, valide et pas encore terminée.
export function activePauseRange(preferences: ReminderPreferences, today = new Date()): { startDate: string; endDate: string } | null {
  const freeze = preferences.freeze;
  if (!freeze?.enabled || !freeze.startDate || !freeze.endDate) return null;
  if (freeze.endDate < freeze.startDate || freeze.endDate < localDayKey(today)) return null;
  return { startDate: freeze.startDate, endDate: freeze.endDate };
}

function dateTimestamp(value: string): number {
  const datePart = value.slice(0, 10);
  if (datePart.includes("/")) {
    const [day, month, year] = datePart.split("/");
    return new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T12:00:00`).getTime();
  }
  return new Date(`${datePart}T12:00:00`).getTime();
}

type ReminderNotification = { key: string; time: string; title: string; body: string };

function formatCourseTime(value: string): string {
  const match = value.match(/(\d{2}):(\d{2})/);
  return match ? `${Number(match[1])}h${match[2]}` : "--:--";
}

function getStudentName(studentData: SchoolData): string {
  const pupil = studentData.student;
  return pupil.prenom || (pupil.nom ? pupil.nom.split(" ")[0] : `Élève ${pupil.id}`);
}

function buildClassesBody(data: SchoolData[] | null): string {
  if (!data || data.length === 0) return "Ton rappel de cours fonctionne.";

  const lines = data.map((studentData) => {
    const name = getStudentName(studentData);
    const courses = [...studentData.courses].sort((a, b) => a.start.localeCompare(b.start));
    if (courses.length === 0) {
      return `${name} : Aucun cours prévu`;
    }
    const firstCourse = courses[0];
    const lastCourse = [...courses].sort((a, b) => a.end.localeCompare(b.end)).at(-1) || firstCourse;
    const extra = courses.length > 1 ? ` (+${courses.length - 1})` : "";
    return `${name} : ${formatCourseTime(firstCourse.start)}-${formatCourseTime(lastCourse.end)} · ${firstCourse.subject}${extra}`;
  });

  return lines.join("\n");
}

function buildHomeworksBody(data: SchoolData[] | null, tomorrowKey: string): string {
  if (!data || data.length === 0) return "Ton rappel de devoirs fonctionne.";

  const lines = data.map((studentData) => {
    const name = getStudentName(studentData);
    const homeworks = studentData.homeworks;
    const doneCount = homeworks.filter((h) => h.done).length;
    const todoCount = homeworks.filter((h) => !h.done).length;
    const tomorrowCount = homeworks.filter((h) => !h.done && h.dueDate.slice(0, 10) === tomorrowKey).length;
    return `${name} : ${doneCount} fait${doneCount > 1 ? "s" : ""} · ${todoCount} à faire · ${tomorrowCount} pour demain`;
  });

  return lines.join("\n");
}

function buildGradesBody(data: SchoolData[] | null, dayKey: string): string {
  if (!data || data.length === 0) return "Ton rappel de notes fonctionne.";

  const lines = data.map((studentData) => {
    const name = getStudentName(studentData);
    const todaysGrades = studentData.grades.filter((g) => {
      const ts = dateTimestamp(g.date);
      return Number.isFinite(ts) && localDayKey(new Date(ts)) === dayKey;
    });

    if (todaysGrades.length > 0) {
      const topGrade = todaysGrades[0];
      const extra = todaysGrades.length > 1 ? ` (+${todaysGrades.length - 1})` : "";
      return `${name} : ${todaysGrades.length} nouvelle${todaysGrades.length > 1 ? "s" : ""} note${todaysGrades.length > 1 ? "s" : ""} (${topGrade.subject} : ${topGrade.value})${extra}`;
    }

    const latest = [...studentData.grades].sort((a, b) => dateTimestamp(b.date) - dateTimestamp(a.date))[0];
    if (latest) {
      return `${name} : Pas de nouvelle note (${latest.subject} : ${latest.value})`;
    }
    return `${name} : Aucune note récente`;
  });

  return lines.join("\n");
}

function createReminderNotifications(
  preferences: ReminderPreferences,
  data: SchoolData[] | null,
  now: Date,
  ignorePauseToday = false
): ReminderNotification[] {
  const dayKey = localDayKey(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = localDayKey(tomorrow);

  const pause = activePauseRange(preferences, now);
  // La planification filtre elle-même les jours en pause ; les envois immédiats les bloquent ici.
  if (!ignorePauseToday && pause && dayKey >= pause.startDate && dayKey <= pause.endDate) {
    console.log("[REMINDERS] Notifications en pause jusqu'au", pause.endDate);
    return [];
  }

  return [
    preferences.classes.enabled && {
      key: "classes",
      time: preferences.classes.time,
      title: "Tempo · Cours du jour",
      body: buildClassesBody(data)
    },
    preferences.homework.enabled && {
      key: "homework",
      time: preferences.homework.time,
      title: "Tempo · Devoirs à venir",
      body: buildHomeworksBody(data, tomorrowKey)
    },
    preferences.grades.enabled && {
      key: "grades",
      time: preferences.grades.time,
      title: "Tempo · Dernières notes",
      body: buildGradesBody(data, dayKey)
    }
  ].filter((candidate): candidate is { key: string; time: string; title: string; body: string } => Boolean(candidate));
}

async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("tempo-reminders", {
      name: "Rappels Tempo",
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: "#16866A"
    });
  }
  return (await Notifications.getPermissionsAsync()).granted;
}

export async function sendRemindersAfterSync(
  preferences: ReminderPreferences,
  data: SchoolData[],
  now = new Date()
): Promise<number> {
  if (data.length === 0 || data.some((student) => student.error)) return 0;
  const dayKey = localDayKey(now);
  const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const candidates = createReminderNotifications(preferences, data, now);

  const dueCandidates = await Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    alreadySent: await SecureStore.getItemAsync(`tempo-reminder-sent-${candidate.key}`) === dayKey
  })));
  const dueReminders = dueCandidates.filter(({ time, alreadySent }) =>
    /^([01]\d|2[0-3]):[0-5]\d$/.test(time) && time <= currentTime && !alreadySent
  );
  if (dueReminders.length === 0) return 0;
  if (!(await requestNotificationPermission())) return 0;

  await Promise.all(dueReminders.map(async ({ key, title, body }) => {
    await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: true },
      trigger: null
    });
    await SecureStore.setItemAsync(`tempo-reminder-sent-${key}`, dayKey);
  }));
  return dueReminders.length;
}

export async function sendTestNotifications(
  preferences: ReminderPreferences,
  data: SchoolData[] | null
): Promise<{ sent: number; permissionGranted: boolean }> {
  const enabledReminders = createReminderNotifications(preferences, data, new Date());

  if (enabledReminders.length === 0) return { sent: 0, permissionGranted: true };

  let permission = await Notifications.getPermissionsAsync();
  if (!permission.granted) permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return { sent: 0, permissionGranted: false };

  await Promise.all(enabledReminders.map(({ title, body }) =>
    Notifications.scheduleNotificationAsync({
      content: { title, body, sound: true },
      trigger: null
    })
  ));

  return { sent: enabledReminders.length, permissionGranted: true };
}
