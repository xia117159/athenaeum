import { invoke } from "@tauri-apps/api/core";

export type FileSystemIconKind = "file" | "folder" | "drive" | "remote-root";
export type SystemIconImageList = "sys-small" | "small" | "large" | "extra-large" | "jumbo";

export type SystemIconRequest = {
  kind: FileSystemIconKind;
  path?: string;
  extension?: string;
  size?: number;
  imageList?: SystemIconImageList;
};

type SystemIconBitmap = {
  width: number;
  height: number;
  rgbaBase64: string;
};

type SystemIconResolver = (request: SystemIconRequest) => Promise<string | null>;

const iconCache = new Map<string, Promise<string | null>>();

let testResolver: SystemIconResolver | undefined;

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

export function getSystemIconCacheKey(request: SystemIconRequest) {
  const imageList = normalizeImageList(request.imageList, request.size);

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

function decodeBase64(base64: string) {
  if (typeof atob !== "function") {
    return null;
  }

  const binary = atob(base64);
  const bytes = new Uint8ClampedArray(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bitmapToDataUrl(bitmap: SystemIconBitmap) {
  if (typeof document === "undefined" || typeof ImageData === "undefined") {
    return null;
  }

  const rgbaBytes = decodeBase64(bitmap.rgbaBase64);
  if (!rgbaBytes) {
    return null;
  }

  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;

  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  const imageData = new ImageData(rgbaBytes, bitmap.width, bitmap.height);
  context.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

export async function resolveSystemIcon(request: SystemIconRequest): Promise<string | null> {
  const imageList = normalizeImageList(request.imageList, request.size);
  const normalizedRequest = {
    ...request,
    extension: normalizeExtension(request.extension),
    imageList,
    size: normalizeSize(request.size, imageList)
  } satisfies Required<Pick<SystemIconRequest, "kind" | "size">> & SystemIconRequest;
  const cacheKey = getSystemIconCacheKey(normalizedRequest);
  const cached = iconCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    if (testResolver) {
      return testResolver(normalizedRequest);
    }

    if (!hasTauriRuntime()) {
      return null;
    }

    try {
      const bitmap = await invoke<SystemIconBitmap>("resolve_system_icon", {
        request: normalizedRequest
      });
      return bitmapToDataUrl(bitmap);
    } catch (error) {
      console.warn("Failed to resolve system icon", error);
      return null;
    }
  })();

  iconCache.set(cacheKey, pending);
  return pending;
}

export function setSystemIconResolverForTests(resolver?: SystemIconResolver) {
  testResolver = resolver;
  iconCache.clear();
}

export function clearSystemIconCacheForTests() {
  iconCache.clear();
}
