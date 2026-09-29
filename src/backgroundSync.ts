import * as BackgroundTask from "expo-background-task";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { createEdSession, fetchStudentsSchoolDataWithAutoAdvance, relogin, type SchoolData } from "./ecoleDirecte";
import { defaultPreferences, sendRemindersAfterSync, type ReminderPreferences } from "./reminders";

export const CREDENTIALS_KEY = "tempo-ecole-directe-credentials";
export const DEVICE_KEY = "tempo-device-id";
export const PREFS_KEY = "tempo-reminder-preferences";
export const BACKGROUND_SYNC_ENABLED_KEY = "tempo-background-sync-enabled";
export const BACKGROUND_SYNC_TASK = "tempo-hourly-school-sync";
const BACKGROUND_SYNC_DATA_KEY = "tempo-background-sync-data";
const BACKGROUND_SYNC_STATUS_KEY = "tempo-background-sync-status";

type SavedCredentials = {
  username: string;
  accessToken?: string;
  accountType?: string;
  factors?: { cn: string; cv: string };
};

export type BackgroundSyncStatus = {
  available: boolean;
  registered: boolean;
  credentialsSaved: boolean;
  notificationsGranted: boolean;
  lastSyncAt?: string;
  lastSyncSucceeded?: boolean;
  selectedDay?: string;
  lastNotificationsSent?: number;
};

TaskManager.defineTask(BACKGROUND_SYNC_TASK, async ({ error }) => {
  if (error) return BackgroundTask.BackgroundTaskResult.Failed;

  try {
    const [enabled, savedCredentials, savedUuid, savedPreferences] = await Promise.all([
      SecureStore.getItemAsync(BACKGROUND_SYNC_ENABLED_KEY),
      SecureStore.getItemAsync(CREDENTIALS_KEY),
      SecureStore.getItemAsync(DEVICE_KEY),
      SecureStore.getItemAsync(PREFS_KEY)
    ]);
    if (enabled !== "true" || !savedCredentials || !savedUuid) {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }

    const credentials = JSON.parse(savedCredentials) as SavedCredentials;
    if (!credentials.username || !credentials.accessToken) {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }

    const preferences = savedPreferences
      ? { ...defaultPreferences, ...JSON.parse(savedPreferences) } as ReminderPreferences
      : defaultPreferences;
    const session = createEdSession();
    await relogin(
      session,
      credentials.username,
      savedUuid,
      credentials.accessToken,
      credentials.accountType || "E",
      credentials.factors
    );
    const syncResult = await fetchStudentsSchoolDataWithAutoAdvance(session, preferences.homeworkDays, new Date());
    const data = syncResult.data;
    const succeeded = data.length > 0 && data.every((student) => !student.error);
    const notificationsSent = succeeded
      ? await sendRemindersAfterSync(preferences, data)
      : 0;
    await SecureStore.setItemAsync(BACKGROUND_SYNC_DATA_KEY, JSON.stringify(data));
    await SecureStore.setItemAsync(BACKGROUND_SYNC_STATUS_KEY, JSON.stringify({
      lastSyncAt: new Date().toISOString(),
      succeeded,
      selectedDay: syncResult.selectedDay.toISOString(),
      notificationsSent
    }));
    return succeeded ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
  } catch (taskError) {
    console.error("[BACKGROUND-SYNC] Periodic sync failed:", taskError);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function enableBackgroundSync(): Promise<void> {
  if (Platform.OS !== "android") {
    throw new Error("La synchronisation périodique est configurée pour Android.");
  }
  const [status, savedCredentials, registered] = await Promise.all([
    BackgroundTask.getStatusAsync(),
    SecureStore.getItemAsync(CREDENTIALS_KEY),
    TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)
  ]);
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) {
    throw new Error("Android indique que les tâches en arrière-plan sont indisponibles.");
  }
  if (!savedCredentials) {
    throw new Error("Active d’abord « Garder les identifiants sur cet appareil » pour permettre la reconnexion sécurisée.");
  }
  const credentials = JSON.parse(savedCredentials) as SavedCredentials;
  if (!credentials.username || !credentials.accessToken) {
    throw new Error("Reconnecte-toi avec « Garder les identifiants » activé avant de planifier la synchronisation.");
  }

  await SecureStore.setItemAsync(BACKGROUND_SYNC_ENABLED_KEY, "true");
  try {
    if (!registered) {
      await BackgroundTask.registerTaskAsync(BACKGROUND_SYNC_TASK, { minimumInterval: 60 });
    }
  } catch (error) {
    await SecureStore.deleteItemAsync(BACKGROUND_SYNC_ENABLED_KEY);
    throw error;
  }
}

export async function disableBackgroundSync(): Promise<void> {
  await SecureStore.deleteItemAsync(BACKGROUND_SYNC_ENABLED_KEY);
  if (await TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK)) {
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_SYNC_TASK);
  }
}

export async function getBackgroundSyncStatus(): Promise<BackgroundSyncStatus> {
  const [taskStatus, registered, savedCredentials, savedStatus, notificationPermissions] = await Promise.all([
    BackgroundTask.getStatusAsync(),
    TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK),
    SecureStore.getItemAsync(CREDENTIALS_KEY),
    SecureStore.getItemAsync(BACKGROUND_SYNC_STATUS_KEY),
    Notifications.getPermissionsAsync()
  ]);
  const lastSync = savedStatus ? JSON.parse(savedStatus) as {
    lastSyncAt?: string;
    succeeded?: boolean;
    selectedDay?: string;
    notificationsSent?: number;
  } : {};
  return {
    available: Platform.OS === "android" && taskStatus === BackgroundTask.BackgroundTaskStatus.Available,
    registered,
    credentialsSaved: Boolean(savedCredentials),
    notificationsGranted: notificationPermissions.granted,
    lastSyncAt: lastSync.lastSyncAt,
    lastSyncSucceeded: lastSync.succeeded,
    selectedDay: lastSync.selectedDay,
    lastNotificationsSent: lastSync.notificationsSent
  };
}

export async function readBackgroundSyncData(): Promise<SchoolData[] | null> {
  const savedData = await SecureStore.getItemAsync(BACKGROUND_SYNC_DATA_KEY);
  if (!savedData) return null;
  try {
    return JSON.parse(savedData) as SchoolData[];
  } catch {
    await SecureStore.deleteItemAsync(BACKGROUND_SYNC_DATA_KEY);
    return null;
  }
}