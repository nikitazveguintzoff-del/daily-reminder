import type { SchoolData } from "./ecoleDirecte";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export type ReminderPreferences = {
  classes: { enabled: boolean; time: string };
  homework: { enabled: boolean; time: string };
  grades: { enabled: boolean; time: string };
  homeworkDays: number;
};

export const defaultPreferences: ReminderPreferences = {
  classes: { enabled: true, time: "07:00" },
  homework: { enabled: true, time: "17:00" },
  grades: { enabled: true, time: "18:00" },
  homeworkDays: 3
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
  _preferences: ReminderPreferences,
  _data: SchoolData[] | null
): Promise<boolean> {
  return true;
}

function localDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

function createReminderNotifications(
  preferences: ReminderPreferences,
  data: SchoolData[] | null,
  now: Date
): ReminderNotification[] {
  const dayKey = localDayKey(now);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowKey = localDayKey(tomorrow);
  const courses = (data || []).flatMap((student) => student.courses)
    .sort((first, second) => first.start.localeCompare(second.start));
  const lastCourse = [...courses].sort((first, second) => first.end.localeCompare(second.end)).at(-1);
  const homeworks = (data || []).flatMap((student) => student.homeworks);
  const grades = (data || []).flatMap((student) => student.grades);
  const latestGrade = [...grades].sort((first, second) => dateTimestamp(second.date) - dateTimestamp(first.date))[0];
  const todaysGrades = grades.filter((grade) => {
    const timestamp = dateTimestamp(grade.date);
    return Number.isFinite(timestamp) && localDayKey(new Date(timestamp)) === dayKey;
  });
  const nextDayHomeworkCount = homeworks.filter((homework) => homework.dueDate.slice(0, 10) === tomorrowKey && !homework.done).length;

  return [
    preferences.classes.enabled && {
      key: "classes",
      time: preferences.classes.time,
      title: "Tempo · Cours",
      body: !data
        ? "Ton rappel de cours fonctionne."
        : courses.length > 0
        ? `${formatCourseTime(courses[0].start)}-${formatCourseTime(lastCourse?.end || courses[0].end)} * ${courses[0].subject}${courses.length > 1 ? ` + ${courses.length - 1} cours` : ""}`
        : "Aucun cours prévu pour cette journée."
    },
    preferences.homework.enabled && {
      key: "homework",
      time: preferences.homework.time,
      title: "Tempo · Devoirs",
      body: data
        ? `${homeworks.filter((homework) => homework.done).length} faits · ${homeworks.filter((homework) => !homework.done).length} non faits · ${nextDayHomeworkCount} à faire demain`
        : "Ton rappel de devoirs fonctionne."
    },
    preferences.grades.enabled && (!data || todaysGrades.length > 0) && {
      key: "grades",
      time: preferences.grades.time,
      title: "Tempo · Notes",
      body: data
        ? `${todaysGrades.length} nouvelle${todaysGrades.length === 1 ? "" : "s"} note${todaysGrades.length === 1 ? "" : "s"} aujourd’hui${latestGrade ? ` · ${latestGrade.subject} : ${latestGrade.value}` : ""}`
        : "Ton rappel de notes fonctionne."
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
