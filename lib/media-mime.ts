const MEDIA_MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
};

const GENERIC_MIME = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
]);

function extensionOf(value?: string | null) {
  if (!value) return "";
  const clean = value.split(/[?#]/, 1)[0].replace(/\\/g, "/");
  const name = clean.split("/").pop() || "";
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function inferMediaMime(...values: Array<string | null | undefined>) {
  for (const value of values) {
    const inferred = MEDIA_MIME_BY_EXTENSION[extensionOf(value)];
    if (inferred) return inferred;
  }
  return undefined;
}

export function resolveMediaMime(storedMime?: string | null, ...names: Array<string | null | undefined>) {
  const normalized = (storedMime || "").trim().toLowerCase();
  if (normalized.startsWith("image/") || normalized.startsWith("video/")) return storedMime || normalized;
  const inferred = inferMediaMime(...names);
  if (inferred) return inferred;
  if (!GENERIC_MIME.has(normalized) && normalized) return storedMime || normalized;
  return storedMime || "application/octet-stream";
}

export function isImageMedia(storedMime?: string | null, ...names: Array<string | null | undefined>) {
  return resolveMediaMime(storedMime, ...names).toLowerCase().startsWith("image/");
}

export function kindFromMediaMime(mimeType?: string | null) {
  const mime = (mimeType || "").toLowerCase();
  if (mime === "image/gif") return "GIF";
  if (mime.startsWith("video/")) return "Vídeo";
  if (mime.startsWith("image/")) return "Imagem";
  return "Arquivo";
}
