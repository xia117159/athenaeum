import { invoke } from "@tauri-apps/api/core";

export type FileSystemIconKind = "file" | "folder" | "drive" | "remote-root";
export type SystemIconImageList = "sys-small" | "small" | "large" | "extra-large" | "jumbo";

export type SystemIconRequest = {
  kind: FileSystemIconKind;
  path?: string;
  extension?: string;
  size?: number;
  imageList?: SystemIconImageList;
  includeOverlays?: boolean;
  modifiedAt?: string | null;
};

type SystemIconResolver = (request: SystemIconRequest) => Promise<string | null>;

const iconCache = new Map<string, Promise<string | null>>();
// Resolved values are kept separately so rows can synchronously reuse an icon
// without clearing the previous DOM image while the promise path is skipped.
const resolvedIconCache = new Map<string, string | null>();
const MAX_RESOLVED_ICON_CACHE_ENTRIES = 512;
const MAX_PATH_KEYS = 20_000;
const MAX_FREE_BITMAPS = 512;
type IconKeyItem = { kind: FileSystemIconKind; path: string; extension?: string };
type IconKeyRequest = { items: IconKeyItem[]; size: number; imageList: SystemIconImageList };
type IconKeyReply = { key: string };
type PendingKey = { request: SystemIconRequest; resolve: (key: string | null) => void };
type PathKey = { modifiedAt: string | null | undefined; key: string };
type BitmapEntry = { url: string; refs: number };
const pathKeys = new Map<string, PathKey>();
const latestPathStamps = new Map<string, string | null | undefined>();
const pendingKeys = new Map<string, Promise<string | null>>();
const keyQueue: PendingKey[] = [];
const bitmapCache = new Map<string, BitmapEntry>();
const pendingBitmaps = new Map<string, Promise<string | null>>();
let keyFlushScheduled = false;

let testResolver: SystemIconResolver | undefined;

function rememberResolvedIcon(cacheKey: string, value: string | null) {
  resolvedIconCache.delete(cacheKey);
  resolvedIconCache.set(cacheKey, value);
  while (resolvedIconCache.size > MAX_RESOLVED_ICON_CACHE_ENTRIES) {
    const oldest = resolvedIconCache.keys().next().value;
    if (oldest === undefined) break;
    resolvedIconCache.delete(oldest);
  }
}

function readResolvedIcon(cacheKey: string) {
  if (!resolvedIconCache.has(cacheKey)) return undefined;
  const value = resolvedIconCache.get(cacheKey) ?? null;
  resolvedIconCache.delete(cacheKey);
  resolvedIconCache.set(cacheKey, value);
  return value;
}

const SYSTEM_ICON_IMAGE_LIST_SIZES: Record<SystemIconImageList, number> = {
  "sys-small": 16,
  small: 16,
  large: 32,
  "extra-large": 48,
  jumbo: 256
};

function hasTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function normalizeExtension(extension?: string) {
  if (!extension) {
    return "";
  }

  const normalized = extension.trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  return normalized.startsWith(".") ? normalized : `.${normalized}`;
}

function normalizeImageList(imageList?: SystemIconImageList, size = 16): SystemIconImageList {
  if (imageList) {
    return imageList;
  }
  if (size <= 16) {
    return "small";
  }
  if (size <= 32) {
    return "large";
  }
  if (size <= 48) {
    return "extra-large";
  }
  return "jumbo";
}

function normalizeSize(size: number | undefined, imageList: SystemIconImageList) {
  const fallbackSize = SYSTEM_ICON_IMAGE_LIST_SIZES[imageList];
  if (!size || Number.isNaN(size)) {
    return fallbackSize;
  }
  return Math.max(1, Math.round(size));
}

function isLocalPath(path: string | undefined): boolean {
  if (!path) {
    return false;
  }
  // Remote URIs (sftp://, ftp://) and virtual paths are not local filesystem.
  if (/^[a-z]+:\/\//i.test(path)) {
    return false;
  }
  // Windows drive-letter paths (C:\, D:\) and UNC paths (\\server\share).
  return /^[a-z]:\\/i.test(path) || path.startsWith("\\\\");
}

function normalizeLocalPath(path: string): string {
  return path.trim().toLowerCase().replace(/\//g, "\\");
}

function normalizedRequest(request: SystemIconRequest): SystemIconRequest & { imageList: SystemIconImageList; size: number } {
  const imageList = normalizeImageList(request.imageList, request.size);
  return { ...request, extension: normalizeExtension(request.extension), imageList, size: normalizeSize(request.size, imageList) };
}

function touchPathKey(identity: string, value: PathKey) {
  pathKeys.delete(identity);
  pathKeys.set(identity, value);
  while (pathKeys.size > MAX_PATH_KEYS) pathKeys.delete(pathKeys.keys().next().value!);
}

function rememberPathStamp(identity: string, stamp: string | null | undefined) {
  latestPathStamps.delete(identity);
  latestPathStamps.set(identity, stamp);
  while (latestPathStamps.size > MAX_PATH_KEYS) latestPathStamps.delete(latestPathStamps.keys().next().value!);
}

function touchBitmap(key: string, value: BitmapEntry) {
  bitmapCache.delete(key);
  bitmapCache.set(key, value);
}

function trimFreeBitmaps() {
  let free = 0;
  for (const entry of bitmapCache.values()) if (entry.refs === 0) free += 1;
  if (free <= MAX_FREE_BITMAPS) return;
  for (const [key, entry] of bitmapCache) {
    if (free <= MAX_FREE_BITMAPS) break;
    if (entry.refs !== 0) continue;
    URL.revokeObjectURL(entry.url);
    bitmapCache.delete(key);
    free -= 1;
  }
}

async function flushKeyQueue() {
  keyFlushScheduled = false;
  const pending = keyQueue.splice(0);
  const groups = new Map<string, PendingKey[]>();
  for (const item of pending) {
    const request = normalizedRequest(item.request);
    const group = `${request.imageList}:${request.size}`;
    const items = groups.get(group) ?? [];
    items.push(item);
    groups.set(group, items);
  }
  await Promise.all(Array.from(groups.values(), async (group) => {
    for (let offset = 0; offset < group.length; offset += 256) {
      const batch = group.slice(offset, offset + 256);
      const first = normalizedRequest(batch[0].request);
      const request: IconKeyRequest = {
        imageList: first.imageList, size: first.size,
        items: batch.map(({ request: item }) => ({ kind: item.kind, path: item.path ?? "", extension: normalizeExtension(item.extension) }))
      };
      try {
        const replies = await invoke<IconKeyReply[]>("resolve_system_icon_keys", { request });
        batch.forEach((item, index) => item.resolve(replies[index]?.key ?? null));
      } catch (error) {
        console.warn("Failed to resolve system icon keys", error);
        batch.forEach((item) => item.resolve(null));
      }
    }
  }));
}

function resolveIconKey(request: SystemIconRequest): Promise<string | null> {
  const identity = getSystemIconCacheKey(request);
  const stamp = request.modifiedAt;
  const cached = pathKeys.get(identity);
  if (cached && cached.modifiedAt === stamp) {
    touchPathKey(identity, cached);
    return Promise.resolve(cached.key);
  }
  const inFlightKey = `${identity}\0${stamp ?? ""}`;
  rememberPathStamp(identity, stamp);
  const inFlight = pendingKeys.get(inFlightKey);
  if (inFlight) return inFlight;
  const pending = new Promise<string | null>((resolve) => {
    keyQueue.push({ request, resolve });
    if (!keyFlushScheduled) {
      keyFlushScheduled = true;
      queueMicrotask(() => { void flushKeyQueue(); });
    }
  }).then((key) => {
    pendingKeys.delete(inFlightKey);
    if (key && latestPathStamps.has(identity) && latestPathStamps.get(identity) === stamp) {
      touchPathKey(identity, { modifiedAt: stamp, key });
    }
    return key;
  });
  pendingKeys.set(inFlightKey, pending);
  return pending;
}

function resolveBitmap(key: string): Promise<string | null> {
  const cached = bitmapCache.get(key);
  if (cached) {
    touchBitmap(key, cached);
    return Promise.resolve(cached.url);
  }
  const pending = pendingBitmaps.get(key);
  if (pending) return pending;
  const load = invoke<ArrayBuffer | Uint8Array>("resolve_system_icon_bitmap", { key }).then((bytes) => {
    if (!(bytes instanceof ArrayBuffer) && !(bytes instanceof Uint8Array)) return null;
    if (typeof URL.createObjectURL !== "function") return null;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "image/png" }));
    touchBitmap(key, { url, refs: 0 });
    trimFreeBitmaps();
    return url;
  }).catch((error) => {
    console.warn("Failed to resolve system icon bitmap", error);
    return null;
  }).finally(() => pendingBitmaps.delete(key));
  pendingBitmaps.set(key, load);
  return load;
}

export function acquireSystemIcon(request: SystemIconRequest): { current: string | null; promise: Promise<string | null>; release: () => void } {
  const current = peekSystemIcon(request) ?? null;
  if (testResolver || !hasTauriRuntime()) {
    return { current, promise: resolveTestIcon(request), release: () => undefined };
  }
  let released = false;
  let heldKey: string | null = null;
  const promise = resolveIconKey(request).then(async (key) => {
    if (!key) return null;
    const url = await resolveBitmap(key);
    if (url && !released) {
      const entry = bitmapCache.get(key);
      if (entry) {
        entry.refs += 1;
        heldKey = key;
        touchBitmap(key, entry);
      }
    }
    return url;
  });
  return { current, promise, release: () => {
    released = true;
    if (!heldKey) return;
    const entry = bitmapCache.get(heldKey);
    if (entry) entry.refs = Math.max(0, entry.refs - 1);
    heldKey = null;
    trimFreeBitmaps();
  } };
}

export function getSystemIconCacheKey(request: SystemIconRequest) {
  const imageList = normalizeImageList(request.imageList, request.size);
  const wantsOverlay =
    request.includeOverlays === true &&
    (request.kind === "file" || request.kind === "folder") &&
    isLocalPath(request.path);

  if (wantsOverlay) {
    const normalizedPath = normalizeLocalPath(request.path!);
    return `${request.kind}-overlay:${normalizedPath}:${imageList}`;
  }

  switch (request.kind) {
    case "file": {
      const extension = normalizeExtension(request.extension) || "__default__";
      return `file:${extension}:${imageList}`;
    }
    case "drive":
      return `drive:${request.path?.toUpperCase() ?? "__default__"}:${imageList}`;
    case "remote-root":
      return `remote-root:${imageList}`;
    case "folder":
    default:
      return `folder:${imageList}`;
  }
}

async function resolveTestIcon(request: SystemIconRequest): Promise<string | null> {
  const imageList = normalizeImageList(request.imageList, request.size);
  const normalizedRequest = {
    ...request,
    extension: normalizeExtension(request.extension),
    imageList,
    size: normalizeSize(request.size, imageList)
  } satisfies Required<Pick<SystemIconRequest, "kind" | "size">> & SystemIconRequest;
  const cacheKey = getSystemIconCacheKey(normalizedRequest);
  const resolved = readResolvedIcon(cacheKey);
  if (resolved !== undefined) {
    return resolved;
  }
  const cached = iconCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = (testResolver?.(normalizedRequest) ?? Promise.resolve(null)).then((value) => {
    iconCache.delete(cacheKey);
    rememberResolvedIcon(cacheKey, value);
    return value;
  }, (error) => {
    iconCache.delete(cacheKey);
    rememberResolvedIcon(cacheKey, null);
    throw error;
  });

  iconCache.set(cacheKey, pending);
  return pending;
}

/** Returns a resolved icon value without starting an IPC request. */
export function peekSystemIcon(request: SystemIconRequest): string | null | undefined {
  if (!testResolver && hasTauriRuntime()) {
    const identity = getSystemIconCacheKey(request);
    const cachedKey = pathKeys.get(identity);
    if (!cachedKey || cachedKey.modifiedAt !== request.modifiedAt) return undefined;
    touchPathKey(identity, cachedKey);
    const bitmap = bitmapCache.get(cachedKey.key);
    if (!bitmap) return undefined;
    touchBitmap(cachedKey.key, bitmap);
    return bitmap.url;
  }
  const imageList = normalizeImageList(request.imageList, request.size);
  const normalizedRequest = {
    ...request,
    extension: normalizeExtension(request.extension),
    imageList,
    size: normalizeSize(request.size, imageList)
  } satisfies Required<Pick<SystemIconRequest, "kind" | "size">> & SystemIconRequest;
  const cacheKey = getSystemIconCacheKey(normalizedRequest);
  return readResolvedIcon(cacheKey);
}

export function setSystemIconResolverForTests(resolver?: SystemIconResolver) {
  testResolver = resolver;
  clearSystemIconCacheForTests();
}

export function clearSystemIconCacheForTests() {
  iconCache.clear();
  resolvedIconCache.clear();
  pathKeys.clear();
  latestPathStamps.clear();
  pendingKeys.clear();
  keyQueue.length = 0;
  for (const entry of bitmapCache.values()) URL.revokeObjectURL(entry.url);
  bitmapCache.clear();
  pendingBitmaps.clear();
}
