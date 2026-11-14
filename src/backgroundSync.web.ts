export { CREDENTIALS_KEY, DEVICE_KEY, PREFS_KEY, BACKGROUND_SYNC_ENABLED_KEY, BACKGROUND_SYNC_TASK } from "./syncKeys";
export type { BackgroundSyncStatus } from "./backgroundSync";
export async function enableBackgroundSync(): Promise<void> {
  throw new Error("L'arrière-plan Android n'est pas disponible dans un navigateur. Utilise Actualiser pour tester.");
}
export async function disableBackgroundSync(): Promise<void> {}
export async function getBackgroundSyncStatus() {
  return { available: false, registered: false, credentialsSaved: false, notificationsGranted: false };
}
export async function readBackgroundSyncData() { return null; }
