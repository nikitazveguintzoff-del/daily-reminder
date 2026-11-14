// Kept by the local Tempo web service in an encrypted file, so connections survive reloads and restarts.
import { rpc } from "./rpc";
export async function getItemAsync(key) { return rpc("store.get", [key]); }
export async function setItemAsync(key, value) { await rpc("store.set", [key, value]); }
export async function deleteItemAsync(key) { await rpc("store.delete", [key]); }
