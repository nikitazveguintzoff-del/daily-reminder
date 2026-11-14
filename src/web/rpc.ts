// Diagnostics contain operation names and timings, never arguments or payloads.
type RpcLog = { at: string; method: string; succeeded: boolean; ms: number; code?: number | string };
export const rpcLogs: RpcLog[] = [];
export type TokenResponse<T> =
  | { data: T; refreshToken?: string }
  | { error: string; refreshToken?: string };

export async function rpcWithToken<T>(method: string, args: unknown[], saveToken?: (token: string) => Promise<void>): Promise<T> {
  const result = await rpc<TokenResponse<T>>(method, args);
  if (result.refreshToken) await saveToken?.(result.refreshToken);
  if ("error" in result) throw new Error(result.error);
  return result.data;
}

export async function rpc<T>(method: string, args: unknown[]): Promise<T> {
  const started = Date.now();
  let succeeded = false;
  let code: number | string | undefined;
  try {
    // Served by the Tempo web service: same-origin "/rpc" with an HttpOnly cookie; dev mode targets the service port.
    const response = await fetch(process.env.EXPO_PUBLIC_TEMPO_RPC_URL || "/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Tempo-Dev-Token": process.env.EXPO_PUBLIC_TEMPO_DEV_TOKEN || "" },
      body: JSON.stringify({ method, args })
    });
    if (response.status === 403) {
      code = 403;
      throw new Error("Service web Tempo redémarré : recharge la page.");
    }
    const result = await response.json() as { value: T; error?: string; code?: number | string };
    code = result.code;
    if (!response.ok || result.error) {
      throw Object.assign(new Error(result.error || `Service local : HTTP ${response.status}`), { code: result.code });
    }
    const operation = result.value;
    if (operation && typeof operation === "object" && "error" in operation && operation.error) {
      code = "code" in operation && typeof operation.code === "number" ? operation.code : undefined;
    } else succeeded = true;
    return result.value;
  } finally {
    const operation = method === "ed.call" ? `ed.${String(args[1])}` : method;
    rpcLogs.push({ at: new Date().toISOString(), method: operation, succeeded, ms: Date.now() - started, code });
    if (rpcLogs.length > 1000) rpcLogs.shift();
  }
}
