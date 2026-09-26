import * as Notifications from "expo-notifications";
import type { SchoolData } from "./ecoleDirecte";

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

export async function scheduleDailyReminders(
  preferences: ReminderPreferences,
  data: SchoolData | null
): Promise<boolean> {
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) return false;

  await Notifications.setNotificationChannelAsync("rappels", {
    name: "Rappels",
    importance: Notifications.AndroidImportance.DEFAULT
  });
  await Notifications.cancelAllScheduledNotificationsAsync();

  const descriptions = [
    {
      key: "classes" as const,
      title: "Les cours du jour",
      body: data?.courses.length
        ? data.courses
            .map((course) => `${course.start.match(/\d{2}:\d{2}/)?.[0] ?? ""} ${course.subject}`.trim())
            .join(" · ")
            .slice(0, 180)
        : "Ouvre Tempo pour consulter ton emploi du temps."
    },
    {
      key: "homework" as const,
      title: `Devoirs des ${preferences.homeworkDays} prochains jours`,
      body: data?.homeworks.length
        ? data.homeworks
            .slice(0, 3)
            .map((homework) => `${homework.subject} : ${homework.content}`)
            .join(" · ")
            .slice(0, 180)
        : "Ouvre Tempo pour vérifier les devoirs à venir."
    },
    {
      key: "grades" as const,
      title: "Dernière note reçue",
      body: data?.latestGrade
        ? `${data.latestGrade.subject} : ${data.latestGrade.value}`
        : "Ouvre Tempo pour consulter tes dernières notes."
    }
  ];

  for (const reminder of descriptions) {
    const setting = preferences[reminder.key];
    if (!setting.enabled) continue;
    const [hour, minute] = setting.time.split(":").map(Number);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) continue;
    await Notifications.scheduleNotificationAsync({
      content: {
        title: reminder.title,
        body: reminder.body || "Ouvre Tempo pour voir les dernières informations.",
        data: { screen: reminder.key }
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour,
        minute
      }
    });
  }

  return true;
}