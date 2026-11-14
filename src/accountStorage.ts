import * as SecureStore from "expo-secure-store";
import { photoCacheKey, storedPhoto } from "./photos";
import type { ProviderAccount } from "./providers/types";

export const CHILDREN_PROFILES_KEY = "tempo-children-profiles-v3";
export const PROVIDER_ACCOUNTS_KEY = "tempo-provider-accounts-v1";

export function providerTokenKey(accountId: string): string {
  let hash = 2166136261;
  for (const character of accountId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return `tempo-provider-token-${(hash >>> 0).toString(16)}`;
}

export async function persistProviderAccounts(accounts: ProviderAccount[], remember: boolean): Promise<void> {
  const metadata = accounts.map(({ refreshToken: _token, ...account }) => ({
    ...account,
    students: account.students.map(({ photo, ...student }) => ({
      ...student,
      photo: photo?.startsWith("data:") || account.provider === "pronote" ? undefined : photo
    }))
  }));
  await SecureStore.setItemAsync(PROVIDER_ACCOUNTS_KEY, JSON.stringify(metadata));
  for (const account of accounts) {
    if (remember && account.refreshToken) {
      // Metadata may come from an older UI session after a headless token rotation.
      if (!await SecureStore.getItemAsync(providerTokenKey(account.id))) {
        await SecureStore.setItemAsync(providerTokenKey(account.id), account.refreshToken);
      }
    } else {
      await SecureStore.deleteItemAsync(providerTokenKey(account.id));
    }
  }
}

export async function readProviderAccounts(): Promise<ProviderAccount[]> {
  const metadata = await SecureStore.getItemAsync(PROVIDER_ACCOUNTS_KEY);
  const accounts: ProviderAccount[] = metadata ? JSON.parse(metadata) : [];
  return Promise.all(accounts.map(async (account) => ({
    ...account,
    students: await Promise.all(account.students.map(async (student) => ({
      ...student,
      photo: (await storedPhoto(photoCacheKey(account.provider, student.id))) ?? student.photo
    }))),
    refreshToken: await SecureStore.getItemAsync(providerTokenKey(account.id)) || undefined
  })));
}
