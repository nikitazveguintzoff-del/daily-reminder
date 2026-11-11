const USER_AGENT =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<string | undefined>>();

export type WebViewPhotoRequest = { id: number; url: string; headers: Record<string, string> };
type WebViewListener = (requests: WebViewPhotoRequest[]) => void;

const pendingWebView = new Map<number, { url: string; headers: Record<string, string>; resolve: (value?: string) => void; timer: ReturnType<typeof setTimeout> }>();
const webViewListeners = new Set<WebViewListener>();
let nextRequestId = 1;

function notifyWebView(): void {
  const requests = [...pendingWebView.entries()].map(([id, { url, headers }]) => ({ id, url, headers }));
  webViewListeners.forEach((listener) => listener(requests));
}

export function subscribeWebViewPhotoRequests(listener: WebViewListener): () => void {
  webViewListeners.add(listener);
  notifyWebView();
  return () => {
    webViewListeners.delete(listener);
  };
}

export function completeWebViewPhoto(id: number, dataUri?: string): void {
  const entry = pendingWebView.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingWebView.delete(id);
  entry.resolve(dataUri);
  notifyWebView();
}

// Le WebView passe par la pile réseau de Chrome, acceptée par les serveurs qui coupent okhttp.
function webViewPhoto(url: string, headers: Record<string, string>): Promise<string | undefined> {
  return new Promise((resolve) => {
    const id = nextRequestId++;
    const timer = setTimeout(() => completeWebViewPhoto(id, undefined), 20000);
    pendingWebView.set(id, { url, headers, resolve, timer });
    notifyWebView();
  });
}

function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function downloadPhoto(url: string, label: string, headers: Record<string, string>): Promise<string | undefined> {
  const shape = url.replace(/^https?:\/\/[^/]+/, "").replace(/[A-Za-z0-9%_-]{6,}/g, "x").slice(0, 80);
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    console.info(`[${label}-PHOTO] Structure de l’URL.`, {
      host: parsed.host,
      firstSegment: segments[0],
      segmentLengths: segments.map((part) => part.length),
      extension: segments[segments.length - 1]?.match(/\.[A-Za-z0-9]{2,5}$/)?.[0] ?? null,
      queryKeys: [...parsed.searchParams.keys()],
      queryLength: parsed.search.length
    });
  } catch {
    // URL illisible : le diagnostic « shape » ci-dessous suffit.
  }
  try {
    const started = Date.now();
    const response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "image/*,*/*;q=0.8", ...headers }
    });
    const contentType = response.headers.get("content-type") || "";
    console.info(`[${label}-PHOTO] Téléchargement de la photo.`, {
      pathShape: shape,
      status: response.status,
      contentType,
      ms: Date.now() - started
    });
    if (response.ok && /^image\//i.test(contentType)) return await blobToDataUri(await response.blob());
  } catch (error) {
    console.warn(`[${label}-PHOTO] Échec du téléchargement de la photo.`, {
      pathShape: shape,
      error: error instanceof Error ? error.message : String(error)
    });
  }
  const started = Date.now();
  const viaWebView = await webViewPhoto(url, headers);
  console.info(`[${label}-PHOTO] Téléchargement via WebView.`, {
    pathShape: shape,
    success: !!viaWebView,
    ms: Date.now() - started
  });
  return viaWebView;
}

export function getCachedPhoto(url: string | undefined): string | undefined {
  return url ? cache.get(url) : undefined;
}

// Télécharge la photo et la renvoie en data URI pour que l'Image n'ait plus besoin de session/en-têtes.
export async function inlinePhoto(
  url: string | undefined,
  label: string,
  headers: Record<string, string> = {}
): Promise<string | undefined> {
  if (!url || url.startsWith("data:")) return url;
  const cached = cache.get(url);
  if (cached) return cached;
  let task = inflight.get(url);
  if (!task) {
    task = downloadPhoto(url, label, headers).finally(() => inflight.delete(url));
    inflight.set(url, task);
  }
  const dataUri = await task;
  if (dataUri) {
    cache.set(url, dataUri);
    return dataUri;
  }
  return url;
}
