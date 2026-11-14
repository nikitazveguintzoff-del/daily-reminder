import * as BackgroundTask from "expo-background-task";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import * as TaskManager from "expo-task-manager";
import { AppState, Platform } from "react-native";
import { createEdSession, fetchStudentsSchoolDataWithAutoAdvance, relogin, type SchoolData } from "./ecoleDirecte";
import { defaultPreferences, sendRemindersAfterSync, type ReminderPreferences } from "./reminders";
import { CHILDREN_PROFILES_KEY, providerTokenKey, readProviderAccounts } from "./accountStorage";
import { restorePronote, restoreSkolengoLogin } from "./providers/schoolServices";
import { findFirstCourseDay, syncChildren } from "./sync";
import type { ChildProfile, ProviderAccount, ProviderSession } from "./providers/types";

import { CREDENTIALS_KEY, DEVICE_KEY, PREFS_KEY, BACKGROUND_SYNC_ENABLED_KEY, BACKGROUND_SYNC_TASK } from "./syncKeys";
export { CREDENTIALS_KEY, DEVICE_KEY, PREFS_KEY, BACKGROUND_SYNC_ENABLED_KEY, BACKGROUND_SYNC_TASK } from "./syncKeys";
const BACKGROUND_SYNC_DATA_KEY = "tempo-background-sync-data";
const BACKGROUND_SYNC_STATUS_KEY = "tempo-background-sync-status";

type SavedCredentials = {
  username: string;
  accessToken?: string;
  accountType?: string;
  factors?: { cn: string; cv: string };
};

function hasSavedCredentials(accounts: ProviderAccount[], credentials: SavedCredentials | null, device: string | null): boolean {
  const edReady = Boolean(credentials?.username && credentials.accessToken && device);
  return accounts.length > 0 ? accounts.every((account) => account.provider === "ecoleDirecte"
    ? edReady
    : Boolean(account.refreshToken && (account.provider !== "skolengo" || account.school))) : edReady;
}

export type BackgroundSyncStatus = {
  available: boolean;
  registered: boolean;
  credentialsSaved: boolean;
  notificationsGranted: boolean;
  lastSyncAt?: string;
  lastSyncSucceeded?: boolean;
  selectedDay?: string;
  lastNotificationsSent?: number;
  lastError?: string;
};

TaskManager.defineTask(BACKGROUND_SYNC_TASK, async ({ error }) => {
  if (error) {
    console.error("[BACKGROUND-SYNC] Task error:", error);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
  // Avoid consuming single-use tokens while the UI owns an active session.
  if (AppState.currentState === "active") return BackgroundTask.BackgroundTaskResult.Success;

  try {
    const [enabled, savedCredentials, savedUuid, savedPreferences, accounts, savedChildren] = await Promise.all([
      SecureStore.getItemAsync(BACKGROUND_SYNC_ENABLED_KEY),
      SecureStore.getItemAsync(CREDENTIALS_KEY),
      SecureStore.getItemAsync(DEVICE_KEY),
      SecureStore.getItemAsync(PREFS_KEY),
      readProviderAccounts(),
      SecureStore.getItemAsync(CHILDREN_PROFILES_KEY)
    ]);
    if (enabled !== "true") return BackgroundTask.BackgroundTaskResult.Success;

    const preferences = savedPreferences
      ? { ...defaultPreferences, ...JSON.parse(savedPreferences) } as ReminderPreferences
      : defaultPreferences;
    const sessions = new Map<string, ProviderSession>();
    const failures: string[] = [];
    for (const account of accounts) {
      try {
        if (account.provider === "ecoleDirecte") {
          if (!savedCredentials || !savedUuid) throw new Error("Identifiants École Directe absents.");
          const credentials = JSON.parse(savedCredentials) as SavedCredentials;
          if (!credentials.accessToken) throw new Error("Jeton École Directe absent.");
          const session = createEdSession();
          await relogin(session, credentials.username, savedUuid, credentials.accessToken, credentials.accountType || "E", credentials.factors);
          sessions.set(account.id, session);
          if (session.accessToken) {
            await SecureStore.setItemAsync(CREDENTIALS_KEY, JSON.stringify({ ...credentials, accessToken: session.accessToken }));
          }
        } else {
          if (!account.refreshToken) throw new Error(`Jeton ${account.provider} absent.`);
          const saveToken = (token: string) => SecureStore.setItemAsync(providerTokenKey(account.id), token);
          if (account.provider === "pronote") {
            const restored = await restorePronote(account.refreshToken, saveToken);
            sessions.set(account.id, restored.session);
          } else {
            if (!account.school) throw new Error("Établissement Skolengo absent.");
            const restored = await restoreSkolengoLogin(account.refreshToken, account.school);
            await saveToken(restored.account.refreshToken);
            sessions.set(account.id, restored.account);
          }
        }
      } catch (loginError) {
        const message = `${account.provider} : ${loginError instanceof Error ? loginError.message : String(loginError)}`;
        console.error("[BACKGROUND-SYNC]", message);
        failures.push(message);
      }
    }
    let selectedDay = new Date();
    let data: SchoolData[];
    if (accounts.length) {
      const children: ChildProfile[] = savedChildren ? JSON.parse(savedChildren) : [];
      selectedDay = await findFirstCourseDay(children, accounts, sessions);
      data = await syncChildren(children, accounts, sessions, selectedDay, preferences.homeworkDays);
    } else {
      // Migration from installations predating provider accounts.
      if (!savedCredentials || !savedUuid) throw new Error("Aucun compte mémorisé.");
      const credentials = JSON.parse(savedCredentials) as SavedCredentials;
      if (!credentials.accessToken) throw new Error("Jeton École Directe absent.");
      const session = createEdSession();
      await relogin(session, credentials.username, savedUuid, credentials.accessToken, credentials.accountType || "E", credentials.factors);
      const result = await fetchStudentsSchoolDataWithAutoAdvance(session, preferences.homeworkDays);
      data = result.data;
      selectedDay = result.selectedDay;
    }
    if (!data.length) throw new Error("Aucun profil enfant à synchroniser.");
    const succeeded = !failures.length && data.every((student) => !student.error && !student.gradesError);
    const notificationsSent = succeeded
      ? await sendRemindersAfterSync(preferences, data)
      : 0;
    await SecureStore.setItemAsync(BACKGROUND_SYNC_DATA_KEY, JSON.stringify(data));
    await SecureStore.setItemAsync(BACKGROUND_SYNC_STATUS_KEY, JSON.stringify({
      lastSyncAt: new Date().toISOString(),
      succeeded,
      selectedDay: selectedDay.toISOString(),
      notificationsSent,
      lastError: [...failures, ...data.flatMap((entry) => [entry.error, entry.gradesError].filter(Boolean))].join(" ") || undefined
    }));
    return succeeded ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
  } catch (taskError) {
    console.error("[BACKGROUND-SYNC] Periodic sync failed:", taskError);
    await SecureStore.setItemAsync(BACKGROUND_SYNC_STATUS_KEY, JSON.stringify({
      lastSyncAt: new Date().toISOString(), succeeded: false,
      lastError: taskError instanceof Error ? taskError.message : String(taskError)
    }));
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function enableBackgroundSync(): Promise<void> {
  if (Platform.OS !== "android") {
    throw new Error("La synchronisation périodique est configurée pour Android.");
  }
  const [status, savedCredentials, registered, savedUuid] = await Promise.all([
    BackgroundTask.getStatusAsync(),
    SecureStore.getItemAsync(CREDENTIALS_KEY),
    TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK),
    SecureStore.getItemAsync(DEVICE_KEY)
  ]);
  if (status !== BackgroundTask.BackgroundTaskStatus.Available) {
    throw new Error("Android indique que les tâches en arrière-plan sont indisponibles.");
  }
  const accounts = await readProviderAccounts();
  if (!savedCredentials && !accounts.length) {
    throw new Error("Active d’abord « Garder les identifiants sur cet appareil » pour permettre la reconnexion sécurisée.");
  }
  const credentials: SavedCredentials | null = savedCredentials ? JSON.parse(savedCredentials) : null;
  if (!hasSavedCredentials(accounts, credentials, savedUuid)) {
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
  const [taskStatus, registered, savedCredentials, savedStatus, notificationPermissions, accounts, savedUuid] = await Promise.all([
    BackgroundTask.getStatusAsync(),
    TaskManager.isTaskRegisteredAsync(BACKGROUND_SYNC_TASK),
    SecureStore.getItemAsync(CREDENTIALS_KEY),
    SecureStore.getItemAsync(BACKGROUND_SYNC_STATUS_KEY),
    Notifications.getPermissionsAsync(),
    readProviderAccounts(),
    SecureStore.getItemAsync(DEVICE_KEY)
  ]);
  const lastSync = savedStatus ? JSON.parse(savedStatus) as {
    lastSyncAt?: string;
    succeeded?: boolean;
    selectedDay?: string;
    notificationsSent?: number;
    lastError?: string;
  } : {};
  return {
    available: Platform.OS === "android" && taskStatus === BackgroundTask.BackgroundTaskStatus.Available,
    registered,
    credentialsSaved: hasSavedCredentials(accounts, savedCredentials ? JSON.parse(savedCredentials) : null, savedUuid),
    notificationsGranted: notificationPermissions.granted,
    lastSyncAt: lastSync.lastSyncAt,
    lastSyncSucceeded: lastSync.succeeded,
    selectedDay: lastSync.selectedDay,
    lastNotificationsSent: lastSync.notificationsSent,
    lastError: lastSync.lastError
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