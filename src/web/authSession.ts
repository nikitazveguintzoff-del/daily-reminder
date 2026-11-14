import { rpc } from "./rpc";
export async function openAuthSessionAsync(url: string, redirect: string) {
  return { type: "success" as const, url: await rpc<string>("auth.skolengo", [url, redirect]) };
}
