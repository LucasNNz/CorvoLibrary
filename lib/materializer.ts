import { env } from "./platform/runtime";
import { toArrayBuffer } from "./web-crypto";
import sharp from "sharp";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { strToU8, zipSync } from "fflate";
import { bridgeMaterializationToSupervisor } from "./supervisor-materialization-bridge";
import { getDb } from "../db";
import {
  assetUsage,
  assets,
  collectionCandidates,
  fastPushCandidates,
  materializationBatches,
  materializationCandidates,
  materializationFiles,
  materializationHostHealth,
  materializationHostProbes,
  materializationItems,
  materializationLogs,
  settings,
} from "../db/schema";

type CandidateInput = { prioridade?: number; url?: string; fonte?: string; parent_file_id?: string; technical_operation?: string; technical_parameters?: Record<string, unknown> };
type ItemInput = {
  item_id?: string;
  arquivo_alvo?: string;
  conceito?: string;
  referencia_visual?: string;
  universo?: string;
  preset?: string;
  slot?: string;
  tipo?: string;
  sujeito?: string;
  tags?: string[];
  referencia_roteiro?: string;
  usado_para?: string;
  largura_minima?: number;
  altura_minima?: number;
  transparencia_necessaria?: boolean;
  composition_class?: "CONTEXTUAL" | "ISOLATED";
  candidatas?: CandidateInput[];
};

const GLOBAL_CONCURRENCY = 8;
const PER_HOST_CONCURRENCY = 2;
const MAX_REDIRECTS = 5;
const MAX_FILE_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;
const CIRCUIT_BREAK_MS = 5 * 60_000;
const MAX_CONVERSION_BYTES = 20 * 1024 * 1024;
const MAX_CONVERSION_PIXELS = 12_000_000;
const FLAG_DEFAULTS = {
  MATERIALIZER_V2_ENABLED: "true",
  MATERIALIZER_V2_DEFAULT: "true",
  MATERIALIZER_V2_CONCURRENCY: String(GLOBAL_CONCURRENCY),
  MATERIALIZER_V2_PER_HOST: String(PER_HOST_CONCURRENCY),
  DIRECT_FILE_DELIVERY_ENABLED: "true",
  GITHUB_PUBLIC_RESOLVER_ENABLED: "true",
} as const;

const makeId = (prefix: string) => prefix + "-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomUUID().slice(0, 8).toUpperCase();
const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const safeName = (value: string) => (value || "arquivo").replace(/[\\/]/g, "-").replace(/[^a-zA-Z0-9À-ÿ._ -]/g, "-").slice(0, 180);
const toTags = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(clean).filter(Boolean))] : [];
const now = () => new Date();
const chunk = <T,>(values: T[], size = 40) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, index * size + size));

async function materializerFlags() {
  const keys = Object.keys(FLAG_DEFAULTS);
  const rows = await getDb().select().from(settings).where(inArray(settings.key, keys));
  return { ...FLAG_DEFAULTS, ...Object.fromEntries(rows.map((row) => [row.key, row.value])) };
}

async function stableId(prefix: string, value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const suffix = Array.from(new Uint8Array(digest).subarray(0, 10), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return prefix + "-" + suffix;
}

async function sha256(bytes: Uint8Array) {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isPrivateIpv4(host: string) {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19));
}

function validateExternalUrl(raw: string) {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("INVALID_URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("UNSUPPORTED_PROTOCOL");
  if (url.username || url.password) throw new Error("URL_CREDENTIALS_BLOCKED");
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host === "metadata.google.internal" || host === "metadata" || host === "169.254.169.254" ||
      /^0x/i.test(host) || /^\d+$/.test(host) || isPrivateIpv4(host) ||
      host === "::1" || host === "::" || /^f[cd]/i.test(host) || /^fe[89ab]/i.test(host)) {
    throw new Error("SSRF_BLOCKED");
  }
  return url;
}

function adapterFor(url: URL) {
  const host = url.hostname.toLowerCase();
  if (host === "github.com" || host.endsWith(".github.com") || host === "raw.githubusercontent.com") return "github-public";
  if (host.includes("pinimg.com") || host.includes("pinterest.")) return "pinterest";
  if (host.includes("wikia") || host.includes("fandom.")) return "fandom-wikia";
  if (host.includes("wikimedia.org") || host.includes("wikipedia.org")) return "wikimedia";
  if (host.includes("redd.it") || host.includes("redditmedia.com") || host.includes("imgur.com")) return "reddit-media";
  if (host.includes("knowyourmeme.com")) return "knowyourmeme";
  return "generic";
}

function adaptInitialUrl(url: URL) {
  if (url.hostname === "github.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 5 && parts[2] === "blob") {
      return validateExternalUrl("https://raw.githubusercontent.com/" + parts[0] + "/" + parts[1] + "/" + parts[3] + "/" + parts.slice(4).join("/"));
    }
  }
  return url;
}

function metaMediaUrl(html: string, base: URL) {
  const patterns = [
    /<meta[^>]+(?:property|name)=["'](?:og:image|og:video|twitter:image)["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|og:video|twitter:image)["']/i,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      try { return validateExternalUrl(new URL(match[1].replace(/&amp;/g, "&"), base).toString()); } catch { /* continue */ }
    }
  }
  return null;
}

async function readLimited(response: Response, maxBytes: number) {
  if (!response.body) throw new Error("EMPTY_BODY");
  const declared = Number(response.headers.get("content-length")) || 0;
  if (declared > maxBytes) throw new Error("FILE_TOO_LARGE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    const chunk = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
    total += chunk.byteLength;
    if (total > maxBytes) { await reader.cancel(); throw new Error("FILE_TOO_LARGE"); }
    chunks.push(chunk);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

async function fetchMaterial(urlInput: string) {
  let current = adaptInitialUrl(validateExternalUrl(urlInput));
  const original = current.toString();
  let redirects = 0;
  const started = Date.now();
  while (redirects <= MAX_REDIRECTS) {
    current = validateExternalUrl(current.toString());
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(current.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "accept": "image/avif,image/webp,image/png,image/jpeg,image/gif,video/mp4,video/webm,*/*;q=0.5",
          "user-agent": "CorvoLibraryMaterializer/2.0",
          "referer": new URL(original).origin + "/",
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) throw new Error("REDIRECT_WITHOUT_LOCATION");
        redirects += 1;
        current = validateExternalUrl(new URL(location, current).toString());
        continue;
      }
      if (response.status === 429) throw new Error("RATE_LIMITED");
      if (response.status === 404) throw new Error("HTTP_404");
      if (response.status >= 500) throw new Error("HTTP_5XX");
      if (!response.ok) throw new Error("HTTP_" + response.status);
      const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase();
      const bytes = await readLimited(response, contentType.includes("html") ? 1024 * 1024 : MAX_FILE_BYTES);
      if (contentType.includes("html") || looksLikeHtml(bytes)) {
        const extracted = metaMediaUrl(new TextDecoder().decode(bytes), current);
        if (!extracted) throw new Error("HTML_INSTEAD_OF_IMAGE");
        redirects += 1;
        current = extracted;
        continue;
      }
      return {
        bytes,
        originalUrl: original,
        resolvedUrl: current.toString(),
        host: current.hostname.toLowerCase(),
        httpStatus: response.status,
        declaredType: contentType,
        declaredLength: Number(response.headers.get("content-length")) || bytes.byteLength,
        redirects,
        durationMs: Date.now() - started,
        adapter: adapterFor(current),
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw new Error("DOWNLOAD_TIMEOUT");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error("TOO_MANY_REDIRECTS");
}

function looksLikeHtml(bytes: Uint8Array) {
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 512))).trim().toLowerCase();
  return prefix.startsWith("<!doctype html") || prefix.startsWith("<html") || prefix.includes("<body");
}

function u16be(bytes: Uint8Array, offset: number) { return (bytes[offset] << 8) | bytes[offset + 1]; }
function u24le(bytes: Uint8Array, offset: number) { return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16); }
function u32be(bytes: Uint8Array, offset: number) { return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0; }

function avifDimensions(bytes: Uint8Array) {
  for (let offset = 4; offset + 12 <= Math.min(bytes.length, 256 * 1024); offset += 1) {
    if (bytes[offset] === 0x69 && bytes[offset + 1] === 0x73 && bytes[offset + 2] === 0x70 && bytes[offset + 3] === 0x65) {
      const width = u32be(bytes, offset + 4), height = u32be(bytes, offset + 8);
      if (width > 0 && height > 0) return { width, height };
    }
  }
  return { width: null, height: null };
}

function inspectBytes(bytes: Uint8Array) {
  if (!bytes.byteLength) return { ok: false, reason: "EMPTY_FILE" as const };
  if (looksLikeHtml(bytes)) return { ok: false, reason: "HTML_INSTEAD_OF_IMAGE" as const };
  if (bytes.length >= 24 && bytes[0] === 0x89 && String.fromCharCode(...bytes.subarray(1, 4)) === "PNG") {
    return { ok: true, mime: "image/png", extension: "png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  const head6 = new TextDecoder().decode(bytes.subarray(0, 6));
  if (bytes.length >= 10 && (head6 === "GIF87a" || head6 === "GIF89a")) {
    return { ok: true, mime: "image/gif", extension: "gif", width: bytes[6] | (bytes[7] << 8), height: bytes[8] | (bytes[9] << 8) };
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1], length = u16be(bytes, offset + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { ok: true, mime: "image/jpeg", extension: "jpg", width: u16be(bytes, offset + 7), height: u16be(bytes, offset + 5) };
      }
      if (length < 2) break;
      offset += 2 + length;
    }
    return { ok: true, mime: "image/jpeg", extension: "jpg", width: null, height: null };
  }
  if (bytes.length >= 30 && new TextDecoder().decode(bytes.subarray(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.subarray(8, 12)) === "WEBP") {
    const chunk = new TextDecoder().decode(bytes.subarray(12, 16));
    if (chunk === "VP8X") return { ok: true, mime: "image/webp", extension: "webp", width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
    return { ok: true, mime: "image/webp", extension: "webp", width: null, height: null };
  }
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 2048))).trim();
  if (/^<\?xml|^<svg/i.test(prefix) && /<svg[\s>]/i.test(prefix)) {
    const svg = prefix.match(/<svg[^>]*>/i)?.[0] || "";
    const width = Number(svg.match(/\bwidth=["']?(\d+)/i)?.[1]) || null;
    const height = Number(svg.match(/\bheight=["']?(\d+)/i)?.[1]) || null;
    return { ok: true, mime: "image/svg+xml", extension: "svg", width, height };
  }
  if (bytes.length >= 16 && new TextDecoder().decode(bytes.subarray(4, 8)) === "ftyp") {
    const brand = new TextDecoder().decode(bytes.subarray(8, 16)).toLowerCase();
    if (brand.includes("avif")) return { ok: true, mime: "image/avif", extension: "avif", ...avifDimensions(bytes) };
    return { ok: true, mime: brand.includes("qt") ? "video/quicktime" : "video/mp4", extension: brand.includes("qt") ? "mov" : "mp4", width: null, height: null };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { ok: true, mime: "video/webm", extension: "webm", width: null, height: null };
  }
  return { ok: false, reason: "UNSUPPORTED_FORMAT" as const };
}

type ValidInspection = Extract<ReturnType<typeof inspectBytes>, { ok: true }>;
type NormalizedImage = {
  bytes: Uint8Array;
  inspection: ValidInspection;
  converted: boolean;
  originalMime: string;
  originalExtension: string;
  finalMime: string;
  finalExtension: string;
  originalSha256: string;
  finalSha256: string;
  alphaDetected: boolean;
};

function targetImageFormat(targetName: string) {
  const extension = targetName.split(".").pop()?.toLowerCase() || "";
  if (extension === "jpg" || extension === "jpeg") return { mime: "image/jpeg", extension: "jpg" };
  if (extension === "png") return { mime: "image/png", extension: "png" };
  return null;
}

function isAnimatedRaster(bytes: Uint8Array, mime: string) {
  if (mime === "image/gif") {
    let frames = 0;
    for (let index = 13; index < bytes.length; index += 1) if (bytes[index] === 0x2c && ++frames > 1) return true;
  }
  if (mime === "image/webp") {
    const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)));
    return text.includes("ANIM") || text.includes("ANMF");
  }
  return false;
}


function hasAlpha(rawPixels: Uint8Array) {
  for (let index = 3; index < rawPixels.length; index += 4) if (rawPixels[index] !== 255) return true;
  return false;
}

async function normalizeImageFormat(bytes: Uint8Array, inspection: ValidInspection, targetName: string, requiresAlpha: boolean): Promise<NormalizedImage> {
  const originalSha256 = await sha256(bytes);
  const target = targetImageFormat(targetName);
  if (!target || target.mime === inspection.mime) {
    return {
      bytes, inspection, converted: false, originalMime: inspection.mime, originalExtension: inspection.extension,
      finalMime: inspection.mime, finalExtension: inspection.extension, originalSha256, finalSha256: originalSha256, alphaDetected: false,
    };
  }
  if (!["image/jpeg", "image/png", "image/webp", "image/avif"].includes(inspection.mime)) throw new Error("FORMAT_CONVERSION_UNSUPPORTED");
  if (bytes.byteLength > MAX_CONVERSION_BYTES) throw new Error("FORMAT_CONVERSION_TOO_LARGE");
  if (inspection.width && inspection.height && inspection.width * inspection.height > MAX_CONVERSION_PIXELS) throw new Error("FORMAT_CONVERSION_TOO_MANY_PIXELS");
  if (isAnimatedRaster(bytes, inspection.mime)) throw new Error("ANIMATED_CONVERSION_BLOCKED");

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const metadata = await sharp(bytes, { failOn: "error" }).metadata();
      const width = metadata.width || inspection.width || 0, height = metadata.height || inspection.height || 0;
      if (!width || !height) throw new Error("IMAGE_DIMENSIONS_UNAVAILABLE");
      if (width * height > MAX_CONVERSION_PIXELS) throw new Error("FORMAT_CONVERSION_TOO_MANY_PIXELS");
      const alphaDetected = Boolean(metadata.hasAlpha);
      let finalMime = target.mime, finalExtension = target.extension;
      if (requiresAlpha && alphaDetected && target.mime === "image/jpeg") {
        finalMime = "image/png";
        finalExtension = "png";
      }
      let pipeline = sharp(bytes, { failOn: "error" });
      if (finalMime === "image/png") pipeline = pipeline.png();
      else pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: 92 });
      const output = new Uint8Array(await pipeline.toBuffer());
      const finalInspection = inspectBytes(output);
      if (!finalInspection.ok || finalInspection.mime !== finalMime) throw new Error("FORMAT_CONVERSION_OUTPUT_INVALID");
      const finalSha256 = await sha256(output);
      return {
        bytes: output, inspection: finalInspection, converted: true,
        originalMime: inspection.mime, originalExtension: inspection.extension,
        finalMime, finalExtension, originalSha256, finalSha256, alphaDetected,
      };
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
    }
  }
  throw new Error("FORMAT_CONVERSION_FAILED:" + (lastError instanceof Error ? lastError.message : "UNKNOWN"));
}

class HostLimiter {
  private active = new Map<string, number>();
  private queues = new Map<string, Array<() => void>>();
  async run<T>(host: string, operation: () => Promise<T>) {
    await new Promise<void>((resolve) => {
      const count = this.active.get(host) || 0;
      if (count < PER_HOST_CONCURRENCY) { this.active.set(host, count + 1); resolve(); return; }
      const queue = this.queues.get(host) || [];
      queue.push(resolve);
      this.queues.set(host, queue);
    });
    try { return await operation(); }
    finally {
      const queue = this.queues.get(host) || [];
      const next = queue.shift();
      if (next) next();
      else this.active.set(host, Math.max(0, (this.active.get(host) || 1) - 1));
    }
  }
}

class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(operation: () => Promise<T>) {
    await new Promise<void>((resolve) => {
      if (this.active < this.max) { this.active += 1; resolve(); return; }
      this.queue.push(resolve);
    });
    try { return await operation(); }
    finally {
      const next = this.queue.shift();
      if (next) next(); else this.active = Math.max(0, this.active - 1);
    }
  }
}

// V56: limites compartilhados por isolate, evitando que vários lotes paralelos multipliquem a concorrência por host/global.
const sharedHostLimiter = new HostLimiter();
const globalMaterializationLimiter = new Semaphore(GLOBAL_CONCURRENCY);

async function logEvent(batchId: string | null, itemDbId: string | null, candidateId: string | null, event: string, status?: string, detail?: unknown, durationMs?: number) {
  try {
    await getDb().insert(materializationLogs).values({
      id: makeId("MATLOG"), batchId, itemDbId, candidateId, event, status: status || null,
      detail: detail === undefined ? null : JSON.stringify(detail).slice(0, 4000), durationMs: durationMs ?? null,
    });
  } catch { /* logging cannot erase materialized bytes */ }
}

async function hostAvailable(host: string) {
  const [health] = await getDb().select().from(materializationHostHealth).where(eq(materializationHostHealth.host, host)).limit(1);
  if (!health) return true;
  if (health.circuitState !== "OPEN") return true;
  if (!health.blockedUntil || health.blockedUntil.getTime() <= Date.now()) {
    await getDb().update(materializationHostHealth).set({ circuitState: "HALF_OPEN", updatedAt: now() }).where(eq(materializationHostHealth.host, host));
    return true;
  }
  return false;
}

async function recordHost(host: string, success: boolean) {
  const db = getDb(), date = now();
  const [current] = await db.select().from(materializationHostHealth).where(eq(materializationHostHealth.host, host)).limit(1);
  if (!current) {
    await db.insert(materializationHostHealth).values({
      host, successCount: success ? 1 : 0, failureCount: success ? 0 : 1,
      recentFailureCount: success ? 0 : 1, circuitState: "CLOSED", updatedAt: date,
    });
    return;
  }
  const nextSuccess = current.successCount + (success ? 1 : 0);
  const nextFailure = current.failureCount + (success ? 0 : 1);
  const recentFailures = success ? Math.max(0, current.recentFailureCount - 1) : current.recentFailureCount + 1;
  const historicalSuccessRate = nextSuccess / Math.max(1, nextSuccess + nextFailure);
  // V56: fonte historicamente saudável não é bloqueada por duas URLs ruins isoladas.
  const threshold = nextSuccess >= 20 && historicalSuccessRate >= 0.8 ? 5 : nextSuccess >= 5 && historicalSuccessRate >= 0.65 ? 4 : 3;
  const shouldOpen = recentFailures >= threshold;
  await db.update(materializationHostHealth).set({
    successCount: nextSuccess,
    failureCount: nextFailure,
    recentFailureCount: recentFailures,
    circuitState: shouldOpen ? "OPEN" : success ? "CLOSED" : current.circuitState === "OPEN" && current.blockedUntil && current.blockedUntil.getTime() > Date.now() ? "OPEN" : "CLOSED",
    blockedUntil: shouldOpen ? new Date(Date.now() + CIRCUIT_BREAK_MS) : success ? null : current.blockedUntil,
    updatedAt: date,
  }).where(eq(materializationHostHealth.host, host));
}

async function syncBatchStatus(batchId: string) {
  const db = getDb();
  const [batch] = await db.select().from(materializationBatches).where(eq(materializationBatches.id, batchId)).limit(1);
  if (!batch) throw new Error("BATCH_NOT_FOUND");
  const items = await db.select().from(materializationItems).where(eq(materializationItems.batchId, batchId));
  const frozen = items.filter((item) => item.status === "FROZEN").length;
  const ready = items.filter((item) => item.status === "READY_FOR_VISUAL_QA").length;
  const failedStates = new Set(["RELINK_REQUIRED", "NO_MORE_CANDIDATES", "INFRA_BLOCKED", "HOST_BLOCKED", "UNSUPPORTED_FORMAT", "INVALID_CONTENT"]);
  const failed = items.filter((item) => failedStates.has(item.status)).length;
  let status = "PROCESSING";
  if (batch.cancelled) status = "CANCELLED";
  else if (batch.status === "EXPORTED" && items.length > 0 && frozen === items.length) status = "EXPORTED";
  else if (items.length > 0 && frozen === items.length) status = "READY_TO_EXPORT";
  else if (ready > 0) status = failed > 0 ? "PARTIAL_SUCCESS" : "READY_FOR_QA";
  else if (failed === items.length && items.length > 0) status = "PARTIAL_FAILURE";
  else if (failed > 0) status = "PARTIAL_SUCCESS";
  await db.update(materializationBatches).set({ status, completedItems: frozen + ready, failedItems: failed, updatedAt: now() }).where(eq(materializationBatches.id, batchId));
  return { ...batch, status, totalItems: items.length, completedItems: frozen + ready, failedItems: failed, readyForQa: ready, frozen, items };
}

async function materializeCandidate(batchId: string, item: typeof materializationItems.$inferSelect, candidate: typeof materializationCandidates.$inferSelect, limiter: HostLimiter) {
  const db = getDb();
  const startedAt = Date.now();
  const recoveredFileId = await recoverMaterializedFile(batchId, item, candidate);
  if (recoveredFileId) return recoveredFileId;
  const initialUrl = adaptInitialUrl(validateExternalUrl(candidate.originalUrl));
  const initialHost = initialUrl.hostname.toLowerCase();
  if (!(await hostAvailable(initialHost))) {
    await db.update(materializationCandidates).set({ host: initialHost, status: "HOST_BLOCKED", failureReason: "CIRCUIT_OPEN", updatedAt: now() }).where(eq(materializationCandidates.id, candidate.id));
    await logEvent(batchId, item.id, candidate.id, "candidate_failed", "HOST_BLOCKED", { url: candidate.originalUrl, host: initialHost, reason: "CIRCUIT_OPEN" }, Date.now() - startedAt);
    throw new Error("HOST_BLOCKED");
  }
  await db.update(materializationItems).set({ status: "DOWNLOADING", updatedAt: now() }).where(eq(materializationItems.id, item.id));
  await db.update(materializationCandidates).set({ status: "DOWNLOADING", attempts: candidate.attempts + 1, updatedAt: now() }).where(eq(materializationCandidates.id, candidate.id));
  await logEvent(batchId, item.id, candidate.id, "download_started", "DOWNLOADING", { url: candidate.originalUrl });
  try {
    const downloaded = await limiter.run(initialHost, () => fetchMaterial(candidate.originalUrl));
    await db.update(materializationItems).set({ status: "TECHNICAL_PRECHECK", updatedAt: now() }).where(eq(materializationItems.id, item.id));
    const originalInspection = inspectBytes(downloaded.bytes);
    if (!originalInspection.ok) throw new Error(originalInspection.reason);
    if (originalInspection.width && originalInspection.width < item.minWidth) throw new Error("TOO_SMALL");
    if (originalInspection.height && originalInspection.height < item.minHeight) throw new Error("TOO_SMALL");
    let normalized: NormalizedImage;
    try {
      normalized = await normalizeImageFormat(downloaded.bytes, originalInspection, item.targetName, item.requiresAlpha);
    } catch (error) {
      const reason = error instanceof Error ? error.message : "FORMAT_CONVERSION_FAILED";
      await logEvent(batchId, item.id, candidate.id, "format_conversion_failed", "TECHNICAL_CORRECTION_REQUIRED", {
        reason, sourceUrl: downloaded.resolvedUrl, originalMime: originalInspection.mime,
        originalExtension: originalInspection.extension, targetName: item.targetName,
      });
      throw error;
    }
    const inspection = normalized.inspection;
    const digest = normalized.finalSha256;
    const fileId = await stableId("MATFILE", item.id + "\n" + candidate.id + "\n" + digest);
    const extension = normalized.finalExtension;
    const target = safeName(item.targetName.replace(/\.[^.]+$/, "") + "." + extension);
    const r2Key = "materialized/" + batchId + "/" + item.itemId + "/" + fileId + "-" + target;
    const [existingHash] = await db.select().from(materializationFiles).where(eq(materializationFiles.sha256, digest)).limit(1);
    try {
      await env.BUCKET.put(r2Key, normalized.bytes, {
        httpMetadata: { contentType: inspection.mime },
        customMetadata: {
          batchId, itemDbId: item.id, candidateId: candidate.id, sha256: digest, technicalStatus: "TECHNICAL_OK",
          width: String(inspection.width || ""), height: String(inspection.height || ""), sourceUrl: downloaded.resolvedUrl,
          originalMimeType: normalized.originalMime, originalSha256: normalized.originalSha256,
          conversionType: normalized.converted ? "CONVERSAO_FORMATO" : "",
          sourceFileId: candidate.parentFileId || "", technicalOperation: candidate.technicalOperation || "", technicalParameters: candidate.technicalParameters || "",
        },
      });
    } catch (error) {
      await logEvent(batchId, item.id, candidate.id, "r2_write_failed", "R2_WRITE_FAILED", { r2Key, error: error instanceof Error ? error.message : "R2_FAILURE" });
      throw new Error("R2_WRITE_FAILED");
    }
    try {
      await db.insert(materializationFiles).values({
        id: fileId, itemDbId: item.id, candidateId: candidate.id, r2Key,
        mimeType: inspection.mime, sizeBytes: normalized.bytes.byteLength,
        width: inspection.width, height: inspection.height, sha256: digest,
        originalMimeType: normalized.originalMime, originalSha256: normalized.originalSha256,
        conversionType: normalized.converted ? "CONVERSAO_FORMATO" : null,
        sourceFileId: candidate.parentFileId, technicalOperation: candidate.technicalOperation, technicalParameters: candidate.technicalParameters,
        technicalStatus: "TECHNICAL_OK",
      }).onConflictDoNothing();
    } catch (error) {
      await logEvent(batchId, item.id, candidate.id, "db_sync_pending", "DB_SYNC_PENDING", { r2Key, error: error instanceof Error ? error.message : "D1_FAILURE" });
      throw new Error("DB_SYNC_PENDING");
    }
    await db.update(materializationCandidates).set({
      resolvedUrl: downloaded.resolvedUrl, host: downloaded.host, adapter: downloaded.adapter,
      status: existingHash ? "DUPLICATE" : "MATERIALIZED", failureReason: null,
      httpStatus: downloaded.httpStatus, contentType: inspection.mime,
      contentLength: normalized.bytes.byteLength, redirectsCount: downloaded.redirects, updatedAt: now(),
    }).where(eq(materializationCandidates.id, candidate.id));
    await db.update(materializationItems).set({
      status: "READY_FOR_VISUAL_QA", selectedCandidateId: candidate.id, selectedFileId: fileId,
      targetName: target, routeClass: normalized.converted ? "CORRECAO_TECNICA_SIMPLES" : item.routeClass,
      failureReason: null, updatedAt: now(),
    }).where(eq(materializationItems.id, item.id));
    if (normalized.converted) {
      await logEvent(batchId, item.id, candidate.id, "format_converted", "CONVERSAO_FORMATO", {
        itemId: item.itemId, batchId, sourceUrl: downloaded.resolvedUrl,
        originalMime: normalized.originalMime, originalExtension: normalized.originalExtension,
        finalMime: normalized.finalMime, finalExtension: normalized.finalExtension,
        originalSha256: normalized.originalSha256, finalSha256: normalized.finalSha256,
        alphaDetected: normalized.alphaDetected, timestamp: new Date().toISOString(),
      });
    }
    await recordHost(downloaded.host, true);
    await logEvent(batchId, item.id, candidate.id, "qa_ready", "READY_FOR_VISUAL_QA", {
      fileId, r2Key, mime: inspection.mime, width: inspection.width,
      height: inspection.height, bytes: normalized.bytes.byteLength, sha256: digest,
      originalMime: normalized.originalMime, originalSha256: normalized.originalSha256,
      conversionType: normalized.converted ? "CONVERSAO_FORMATO" : null,
      resolvedUrl: downloaded.resolvedUrl, adapter: downloaded.adapter,
    }, downloaded.durationMs);
    // V47: toda materialização real tenta se reconciliar imediatamente com o projeto principal.
    // Falha de ponte nunca invalida os bytes já materializados; o backfill MCP pode reconciliar depois.
    await bridgeMaterializationToSupervisor(item.id).catch(async (bridgeError) => {
      await logEvent(batchId, item.id, candidate.id, "supervisor_bridge_deferred", "DEFERRED", { reason: bridgeError instanceof Error ? bridgeError.message : "BRIDGE_FAILED" });
    });
    return fileId;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "DOWNLOAD_FAILED";
    const technicalFailure = reason.startsWith("FORMAT_CONVERSION") || reason === "ANIMATED_CONVERSION_BLOCKED";
    const urlSpecificFailure = reason === "HTTP_404" || reason === "INVALID_CONTENT" || reason === "HTML_INSTEAD_OF_IMAGE";
    if (!technicalFailure && !urlSpecificFailure) await recordHost(initialHost, false).catch(() => undefined);
    await db.update(materializationCandidates).set({ host: initialHost, status: reason, failureReason: reason, updatedAt: now() }).where(eq(materializationCandidates.id, candidate.id)).catch(() => undefined);
    await logEvent(batchId, item.id, candidate.id, "candidate_failed", reason, { url: candidate.originalUrl, host: initialHost }, Date.now() - startedAt);
    throw error;
  }
}

async function recoverMaterializedFile(batchId: string, item: typeof materializationItems.$inferSelect, candidate: typeof materializationCandidates.$inferSelect) {
  const prefix = "materialized/" + batchId + "/" + item.itemId + "/";
  const listed = await env.BUCKET.list({ prefix, limit: 20 });
  for (const listedObject of listed.objects) {
    const object = await env.BUCKET.get(listedObject.key);
    if (!object || object.customMetadata?.candidateId !== candidate.id || object.customMetadata?.itemDbId !== item.id) continue;
    const bytes = new Uint8Array(await object.arrayBuffer());
    const inspection = inspectBytes(bytes);
    if (!inspection.ok) continue;
    const digest = object.customMetadata?.sha256 || await sha256(bytes);
    const fileId = await stableId("MATFILE", item.id + "\n" + candidate.id + "\n" + digest);
    try {
      await getDb().insert(materializationFiles).values({
        id: fileId, itemDbId: item.id, candidateId: candidate.id, r2Key: listedObject.key,
        mimeType: inspection.mime, sizeBytes: object.size, width: inspection.width, height: inspection.height,
        sha256: digest, originalMimeType: object.customMetadata?.originalMimeType || inspection.mime,
        originalSha256: object.customMetadata?.originalSha256 || digest,
        conversionType: object.customMetadata?.conversionType || null, technicalStatus: "TECHNICAL_OK",
      }).onConflictDoNothing();
      await getDb().update(materializationCandidates).set({
        status: "MATERIALIZED", failureReason: null, contentType: inspection.mime, contentLength: object.size,
        resolvedUrl: object.customMetadata?.sourceUrl || candidate.resolvedUrl || candidate.originalUrl, updatedAt: now(),
      }).where(eq(materializationCandidates.id, candidate.id));
      await getDb().update(materializationItems).set({
        status: "READY_FOR_VISUAL_QA", selectedCandidateId: candidate.id, selectedFileId: fileId,
        failureReason: null, updatedAt: now(),
      }).where(eq(materializationItems.id, item.id));
      await logEvent(batchId, item.id, candidate.id, "db_sync_recovered_from_r2", "READY_FOR_VISUAL_QA", { fileId, r2Key: listedObject.key });
      await bridgeMaterializationToSupervisor(item.id).catch(async (bridgeError) => {
        await logEvent(batchId, item.id, candidate.id, "supervisor_bridge_deferred", "DEFERRED", { reason: bridgeError instanceof Error ? bridgeError.message : "BRIDGE_FAILED", recovered_from_r2: true });
      });
      return fileId;
    } catch (error) {
      await logEvent(batchId, item.id, candidate.id, "db_sync_retry_failed", "DB_SYNC_PENDING", { r2Key: listedObject.key, error: error instanceof Error ? error.message : "D1_FAILURE" });
      throw new Error("DB_SYNC_PENDING");
    }
  }
  return null;
}

async function processItem(itemDbId: string, limiter: HostLimiter) {
  const db = getDb();
  const [item] = await db.select().from(materializationItems).where(eq(materializationItems.id, itemDbId)).limit(1);
  if (!item || ["FROZEN", "READY_FOR_VISUAL_QA", "CANCELLED"].includes(item.status)) return item;
  const [batch] = await db.select().from(materializationBatches).where(eq(materializationBatches.id, item.batchId)).limit(1);
  if (!batch || batch.cancelled) return item;
  const candidates = await db.select().from(materializationCandidates).where(eq(materializationCandidates.itemDbId, item.id)).orderBy(materializationCandidates.priority);
  if (!candidates.length) {
    await db.update(materializationItems).set({ status: "RELINK_REQUIRED", failureReason: "NO_CANDIDATES", updatedAt: now() }).where(eq(materializationItems.id, item.id));
    return;
  }
  const healthRows = await db.select().from(materializationHostHealth);
  const health = new Map(healthRows.map((row) => [row.host, row]));
  const remaining = candidates.slice(Math.max(0, item.candidateCursor)).sort((a, b) => {
    const healthScore = (candidate: typeof a) => {
      const host = candidate.host || validateExternalUrl(candidate.originalUrl).hostname.toLowerCase();
      const row = health.get(host);
      if (!row) return 55;
      if (row.circuitState === "OPEN" && row.blockedUntil && row.blockedUntil.getTime() > Date.now()) return -100;
      const total = row.successCount + row.failureCount;
      return total ? (row.successCount / total) * 100 - row.recentFailureCount * 15 : 50;
    };
    return healthScore(b) - healthScore(a) || a.priority - b.priority;
  });
  let lastReason = "ALL_CANDIDATES_FAILED";
  for (let offset = 0; offset < remaining.length; offset += 1) {
    const index = Math.max(0, item.candidateCursor) + offset;
    const candidate = remaining[offset];
    await db.update(materializationItems).set({ status: "RESOLVING_URL", candidateCursor: index, updatedAt: now() }).where(eq(materializationItems.id, item.id));
    try {
      await materializeCandidate(item.batchId, item, candidate, limiter);
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "DOWNLOAD_FAILED";
      lastReason = reason;
      if (reason === "DB_SYNC_PENDING") {
        await db.update(materializationItems).set({ status: "DB_SYNC_PENDING", failureReason: reason, updatedAt: now() }).where(eq(materializationItems.id, item.id)).catch(() => undefined);
        return;
      }
      await db.update(materializationItems).set({ status: "NEXT_CANDIDATE", candidateCursor: index + 1, failureReason: reason, updatedAt: now() }).where(eq(materializationItems.id, item.id));
    }
  }
  const technicalFailure = lastReason.startsWith("FORMAT_CONVERSION") || lastReason === "ANIMATED_CONVERSION_BLOCKED";
  await db.update(materializationItems).set({
    status: technicalFailure ? "TECHNICAL_CORRECTION_REQUIRED" : "RELINK_REQUIRED",
    failureReason: lastReason, updatedAt: now(),
  }).where(eq(materializationItems.id, item.id));
}

async function insertMaterializationItems(batchId: string, rawItems: ItemInput[], date: Date) {
  const db = getDb();
  const itemIds: string[] = [];
  for (let index = 0; index < rawItems.length; index += 1) {
    const raw = rawItems[index];
    const itemKey = clean(raw.item_id) || String(index + 1).padStart(3, "0");
    const targetName = safeName(clean(raw.arquivo_alvo) || itemKey + ".jpg");
    const concept = clean(raw.conceito) || itemKey;
    const itemDbId = await stableId("MATITEM", batchId + "\n" + itemKey);
    const inserted = await db.insert(materializationItems).values({
      id: itemDbId, batchId, itemId: itemKey, targetName, concept,
      visualReference: clean(raw.referencia_visual) || null, universe: clean(raw.universo) || null,
      preset: clean(raw.preset) || null, slot: clean(raw.slot) || null, kind: clean(raw.tipo) || "Imagem",
      subject: clean(raw.sujeito) || null, tags: JSON.stringify(toTags(raw.tags)),
      scriptReference: clean(raw.referencia_roteiro) || null, usedFor: clean(raw.usado_para) || null,
      minWidth: Math.max(1, Number(raw.largura_minima) || 64), minHeight: Math.max(1, Number(raw.altura_minima) || 64),
      requiresAlpha: raw.transparencia_necessaria === true,
      compositionClass: raw.composition_class || (raw.transparencia_necessaria === true || /png|transpar|isolad|render|sprite/i.test(clean(raw.tipo)) ? "ISOLATED" : "CONTEXTUAL"),
      status: "PENDING", createdAt: date, updatedAt: date,
    }).onConflictDoNothing().returning({ id: materializationItems.id });
    if (!inserted.length) continue;
    itemIds.push(itemDbId);
    const candidates = Array.isArray(raw.candidatas) ? raw.candidatas.slice(0, 5) : [];
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += 1) {
      const candidate = candidates[candidateIndex];
      const url = clean(candidate.url);
      const parsed = validateExternalUrl(url);
      const candidateId = await stableId("MATCAND", itemDbId + "\n" + url);
      await db.insert(materializationCandidates).values({
        id: candidateId, itemDbId, priority: Number(candidate.prioridade) || candidateIndex + 1,
        source: clean(candidate.fonte) || null, originalUrl: url, host: parsed.hostname.toLowerCase(), adapter: adapterFor(parsed),
        parentFileId: clean(candidate.parent_file_id) || null, technicalOperation: clean(candidate.technical_operation) || null, technicalParameters: candidate.technical_parameters ? JSON.stringify(candidate.technical_parameters) : null,
        status: "PENDING", createdAt: date, updatedAt: date,
      }).onConflictDoNothing();
    }
  }
  return itemIds;
}

async function processItems(itemIds: string[]) {
  const limiter = sharedHostLimiter;
  const [parallelismSetting] = await getDb().select().from(settings).where(eq(settings.key, "collection_parallelism")).limit(1);
  const configuredParallelism = Math.max(1, Math.min(GLOBAL_CONCURRENCY, Number(parallelismSetting?.value) || GLOBAL_CONCURRENCY));
  let cursor = 0;
  async function worker() {
    while (cursor < itemIds.length) {
      const next = itemIds[cursor++];
      await globalMaterializationLimiter.run(() => processItem(next, limiter));
    }
  }
  await Promise.all(Array.from({ length: Math.min(configuredParallelism, itemIds.length || 1) }, () => worker()));
}

export async function materializeBatch(input: Record<string, unknown>) {
  const db = getDb();
  const flags = await materializerFlags();
  if (flags.MATERIALIZER_V2_ENABLED.toLowerCase() === "false") throw new Error("MATERIALIZER_V2_DISABLED");
  const project = clean(input.projeto);
  const rawItems = Array.isArray(input.itens) ? input.itens as ItemInput[] : [];
  if (!project) throw new Error("PROJETO_REQUIRED");
  if (!rawItems.length || rawItems.length > 40) throw new Error("O lote deve conter de 1 a 40 itens.");
  for (const [index, raw] of rawItems.entries()) {
    const candidates = Array.isArray(raw.candidatas) ? raw.candidatas.slice(0, 5) : [];
    for (const candidate of candidates) {
      const url = clean(candidate.url);
      if (!url) throw new Error("CANDIDATE_URL_REQUIRED:item=" + (clean(raw.item_id) || index + 1));
      validateExternalUrl(url);
    }
  }
  const suppliedBatchId = clean(input.batch_id);
  const batchId = suppliedBatchId || makeId("MAT");
  const [existing] = await db.select().from(materializationBatches).where(eq(materializationBatches.id, batchId)).limit(1);
  if (existing) return syncBatchStatus(batchId);
  const date = now();
  await db.insert(materializationBatches).values({ id: batchId, project, status: "QUEUED", totalItems: rawItems.length, createdAt: date, updatedAt: date });
  let itemIds: string[] = [];
  try {
    itemIds = await insertMaterializationItems(batchId, rawItems, date);
  } catch (error) {
    await db.update(materializationBatches).set({ status: "INFRA_FAILURE", updatedAt: now() }).where(eq(materializationBatches.id, batchId));
    throw error;
  }
  await db.update(materializationBatches).set({ status: "PROCESSING", updatedAt: now() }).where(eq(materializationBatches.id, batchId));
  await logEvent(batchId, null, null, "batch_started", "PROCESSING", { project, total: itemIds.length });
  await processItems(itemIds);
  return syncBatchStatus(batchId);
}

export async function createMaterializationQueue(input: Record<string, unknown>) {
  const db = getDb();
  const project = clean(input.projeto);
  if (!project) throw new Error("PROJETO_REQUIRED");
  const batchId = clean(input.batch_id) || makeId("QUEUE");
  const [existing] = await db.select().from(materializationBatches).where(eq(materializationBatches.id, batchId)).limit(1);
  if (existing) return { fila: existing, criada: false };
  const date = now();
  await db.insert(materializationBatches).values({ id: batchId, project, status: "QUEUED", totalItems: 0, createdAt: date, updatedAt: date });
  await logEvent(batchId, null, null, "continuous_queue_created", "QUEUED", { project });
  return { fila: { id: batchId, project, status: "QUEUED", totalItems: 0, createdAt: date, updatedAt: date }, criada: true };
}

export async function enqueueMaterializationItems(input: Record<string, unknown>) {
  const db = getDb();
  const batchId = clean(input.batch_id);
  const rawItems = Array.isArray(input.itens) ? input.itens as ItemInput[] : [];
  if (!batchId) throw new Error("BATCH_ID_REQUIRED");
  if (!rawItems.length || rawItems.length > 40) throw new Error("A adição deve conter de 1 a 40 itens.");
  const [batch] = await db.select().from(materializationBatches).where(eq(materializationBatches.id, batchId)).limit(1);
  if (!batch) throw new Error("BATCH_NOT_FOUND");
  if (batch.cancelled) throw new Error("BATCH_CANCELLED");
  for (const raw of rawItems) for (const candidate of (raw.candidatas || []).slice(0, 5)) validateExternalUrl(clean(candidate.url));
  const itemIds = await insertMaterializationItems(batchId, rawItems, now());
  const [count] = await db.select({ value: sql<number>`count(*)` }).from(materializationItems).where(eq(materializationItems.batchId, batchId));
  await db.update(materializationBatches).set({ status: itemIds.length ? "PROCESSING" : batch.status, totalItems: Number(count?.value || 0), updatedAt: now() }).where(eq(materializationBatches.id, batchId));
  await logEvent(batchId, null, null, "continuous_queue_enqueued", "PROCESSING", { recebidos: rawItems.length, novos: itemIds.length });
  if (itemIds.length) await processItems(itemIds);
  return { ...(await syncBatchStatus(batchId)), adicionados: itemIds.length, idempotentes: rawItems.length - itemIds.length };
}

export async function materializeUrl(input: Record<string, unknown>) {
  const itemId = clean(input.item_id) || "001";
  const result = await materializeBatch({
    batch_id: input.batch_id,
    projeto: clean(input.projeto) || "Materialização avulsa",
    itens: [{
      item_id: itemId,
      arquivo_alvo: clean(input.arquivo_alvo) || itemId + ".jpg",
      conceito: clean(input.conceito) || itemId,
      referencia_visual: input.referencia_visual,
      universo: input.universo,
      candidatas: [{ prioridade: 1, url: input.url, fonte: input.fonte }],
    }],
  });
  const projectId = clean(input.projeto_id), projectItemId = clean(input.item_projeto_id);
  let supervisorBridge: unknown = null;
  if (projectId || projectItemId) {
    const batchId = clean(input.batch_id) || clean((result as Record<string, unknown>).id);
    const [created] = batchId ? await getDb().select().from(materializationItems).where(and(eq(materializationItems.batchId, batchId), eq(materializationItems.itemId, itemId))).limit(1) : [];
    if (created?.status === "READY_FOR_VISUAL_QA") supervisorBridge = await bridgeMaterializationToSupervisor(created.id, { projectId: projectId || undefined, itemId: projectItemId || undefined });
  }
  return { ...(result as Record<string, unknown>), supervisor_bridge: supervisorBridge };
}

export async function getBatchStatus(batchId: string) {
  return syncBatchStatus(batchId);
}

export async function getMaterializationStatus(input: Record<string, unknown>) {
  const db = getDb();
  const fileId = clean(input.materialization_id);
  if (fileId) {
    const [file] = await db.select().from(materializationFiles).where(eq(materializationFiles.id, fileId)).limit(1);
    if (!file) throw new Error("MATERIALIZATION_NOT_FOUND");
    const [item] = await db.select().from(materializationItems).where(eq(materializationItems.id, file.itemDbId)).limit(1);
    return { materialization: file, item };
  }
  const batchId = clean(input.batch_id), itemId = clean(input.item_id);
  const [item] = await db.select().from(materializationItems).where(and(eq(materializationItems.batchId, batchId), eq(materializationItems.itemId, itemId))).limit(1);
  if (!item) throw new Error("ITEM_NOT_FOUND");
  const candidates = await db.select().from(materializationCandidates).where(eq(materializationCandidates.itemDbId, item.id)).orderBy(materializationCandidates.priority);
  const files = await db.select().from(materializationFiles).where(eq(materializationFiles.itemDbId, item.id));
  return { item, candidates, files };
}

export async function addCandidates(input: Record<string, unknown>) {
  const db = getDb(), batchId = clean(input.batch_id), itemId = clean(input.item_id);
  const [item] = await db.select().from(materializationItems).where(and(eq(materializationItems.batchId, batchId), eq(materializationItems.itemId, itemId))).limit(1);
  if (!item) throw new Error("ITEM_NOT_FOUND");
  const candidates = Array.isArray(input.candidatas) ? input.candidatas as CandidateInput[] : [];
  const [countRow] = await db.select({ count: sql<number>`count(*)` }).from(materializationCandidates).where(eq(materializationCandidates.itemDbId, item.id));
  let position = Number(countRow?.count || 0);
  for (const raw of candidates.slice(0, 10)) {
    const url = clean(raw.url); validateExternalUrl(url); position += 1;
    const candidateId = await stableId("MATCAND", item.id + "\n" + url);
    await db.insert(materializationCandidates).values({
      id: candidateId, itemDbId: item.id, priority: Number(raw.prioridade) || position,
      source: clean(raw.fonte) || null, originalUrl: url, host: validateExternalUrl(url).hostname.toLowerCase(), adapter: adapterFor(validateExternalUrl(url)),
      parentFileId: clean(raw.parent_file_id) || null, technicalOperation: clean(raw.technical_operation) || null, technicalParameters: raw.technical_parameters ? JSON.stringify(raw.technical_parameters) : null,
      status: "PENDING", updatedAt: now(),
    }).onConflictDoNothing();
  }
  await db.update(materializationItems).set({ status: "PENDING", failureReason: null, updatedAt: now() }).where(eq(materializationItems.id, item.id));
  await processItems([item.id]);
  return getMaterializationStatus({ batch_id: batchId, item_id: itemId });
}

export async function retryItem(input: Record<string, unknown>) {
  const db = getDb(), batchId = clean(input.batch_id), itemId = clean(input.item_id);
  const [item] = await db.select().from(materializationItems).where(and(eq(materializationItems.batchId, batchId), eq(materializationItems.itemId, itemId))).limit(1);
  if (!item) throw new Error("ITEM_NOT_FOUND");
  if (item.status === "FROZEN" && input.forcar !== true) throw new Error("ITEM_FROZEN");
  const reset = input.reiniciar_candidatas === true;
  await db.update(materializationItems).set({ status: "PENDING", candidateCursor: reset ? 0 : item.candidateCursor, failureReason: null, updatedAt: now() }).where(eq(materializationItems.id, item.id));
  await processItems([item.id]);
  return getMaterializationStatus({ batch_id: batchId, item_id: itemId });
}

export async function qaFiles(batchId: string, origin: string, code: string, limit = 20) {
  const db = getDb();
  const flags = await materializerFlags();
  if (flags.DIRECT_FILE_DELIVERY_ENABLED.toLowerCase() === "false") throw new Error("DIRECT_FILE_DELIVERY_DISABLED");
  const ready = await db.select().from(materializationItems).where(and(eq(materializationItems.batchId, batchId), eq(materializationItems.status, "READY_FOR_VISUAL_QA"))).limit(Math.max(1, Math.min(20, limit)));
  const fileIds = ready.map((item) => item.selectedFileId).filter((value): value is string => Boolean(value));
  const files = fileIds.length ? await db.select().from(materializationFiles).where(inArray(materializationFiles.id, fileIds)) : [];
  const byId = new Map(files.map((file) => [file.id, file]));
  const expires = Date.now() + 30 * 60_000;
  const references = ready.flatMap((item) => {
    const file = item.selectedFileId ? byId.get(item.selectedFileId) : null;
    if (!file) return [];
    return [{
      item_id: item.itemId,
      materialization_id: file.id,
      nome: item.targetName,
      mime_type: file.mimeType,
      mime_original: file.originalMimeType,
      tamanho_bytes: file.sizeBytes,
      largura: file.width,
      altura: file.height,
      sha256: file.sha256,
      sha256_original: file.originalSha256,
      conversao_tipo: file.conversionType,
      rota_classificada: item.routeClass,
      uri: origin + "/api/materializations/" + encodeURIComponent(file.id) + "?code=" + encodeURIComponent(code) + "&exp=" + expires,
    }];
  });
  await logEvent(batchId, null, null, "qa_delivery", references.length ? "DELIVERED" : "EMPTY", { files: references.length });
  return {
    batch_id: batchId,
    total: references.length,
    arquivos: references,
    __resources: references.map((file) => ({ name: file.nome, uri: file.uri, mimeType: file.mime_type, description: "Materialização " + file.materialization_id + " pronta para QA visual" })),
  };
}

async function freezeApprovedItem(item: typeof materializationItems.$inferSelect, observation: string | null) {
  const db = getDb();
  if (!item.selectedFileId) throw new Error("ITEM_WITHOUT_FILE");
  const [file] = await db.select().from(materializationFiles).where(eq(materializationFiles.id, item.selectedFileId)).limit(1);
  if (!file) throw new Error("MATERIALIZATION_FILE_NOT_FOUND");
  const [batch] = await db.select().from(materializationBatches).where(eq(materializationBatches.id, item.batchId)).limit(1);
  const [candidate] = item.selectedCandidateId ? await db.select().from(materializationCandidates).where(eq(materializationCandidates.id, item.selectedCandidateId)).limit(1) : [];
  const [duplicate] = await db.select().from(assets).where(eq(assets.sha256, file.sha256)).limit(1);
  let assetId = duplicate?.id;
  if (!assetId) {
    assetId = await stableId("AST", file.sha256);
    const object = await env.BUCKET.get(file.r2Key);
    if (!object) throw new Error("R2_FILE_NOT_FOUND");
    const targetName = safeName(item.targetName);
    const r2Key = "assets/" + assetId + "/" + targetName;
    await env.BUCKET.put(r2Key, await object.arrayBuffer(), { httpMetadata: { contentType: file.mimeType } });
    try {
      await db.insert(assets).values({
        id: assetId, name: item.concept, universe: item.universe || "Sem universo", kind: item.kind || "Imagem",
        subject: item.subject, status: "Aprovado", tags: item.tags, r2Key, originalName: targetName,
        mimeType: file.mimeType, sizeBytes: file.sizeBytes, sha256: file.sha256,
        semanticFamily: [item.universe, item.subject || item.concept].filter(Boolean).join("::").toLocaleLowerCase("pt-BR"),
        projectOrigin: batch?.project || null, scriptReference: item.scriptReference,
        visualReference: item.visualReference, sourceUrl: candidate?.originalUrl || null,
        operationalNote: observation, qaStatus: "APROVADO", createdAt: now(), updatedAt: now(),
      });
    } catch (error) {
      await logEvent(item.batchId, item.id, item.selectedCandidateId, "asset_db_sync_pending", "DB_SYNC_PENDING", { assetId, r2Key, error: error instanceof Error ? error.message : "D1_FAILURE" });
      throw new Error("DB_SYNC_PENDING");
    }
  }
  if (batch?.project) {
    const usageId = await stableId("USE", assetId + "\n" + item.batchId + "\n" + item.itemId);
    const insertedUsage = await db.insert(assetUsage).values({
      id: usageId, assetId, project: batch.project, preset: item.preset, slot: item.slot,
      role: item.usedFor, scriptReference: item.scriptReference, note: observation, usedAt: now(),
    }).onConflictDoNothing().returning({ id: assetUsage.id });
    if (insertedUsage.length) {
      await db.update(assets).set({ useCount: sql`${assets.useCount} + 1`, lastUsedAt: now(), updatedAt: now() }).where(eq(assets.id, assetId));
    }
  }
  await db.update(materializationFiles).set({ finalAssetId: assetId }).where(eq(materializationFiles.id, file.id));
  await db.update(materializationItems).set({ status: "FROZEN", frozenAssetId: assetId, failureReason: null, updatedAt: now() }).where(eq(materializationItems.id, item.id));
  await logEvent(item.batchId, item.id, item.selectedCandidateId, "item_frozen", "FROZEN", { assetId, duplicate: Boolean(duplicate), observation });
  return { item_id: item.itemId, status: "FROZEN", asset_id: assetId, duplicata_reutilizada: Boolean(duplicate) };
}

export async function registerQaBatch(input: Record<string, unknown>) {
  const db = getDb(), batchId = clean(input.batch_id);
  const decisions = Array.isArray(input.decisoes) ? input.decisoes as Array<Record<string, unknown>> : [];
  if (!decisions.length) throw new Error("DECISOES_REQUIRED");

  type QaOutput = { ordinal:number; result:Record<string, unknown>; retryId?:string };
  const groups = new Map<string, Array<{ ordinal:number; decision:Record<string, unknown> }>>();
  decisions.forEach((decision, ordinal) => {
    const itemId = clean(decision.item_id) || `__invalid_${ordinal}`;
    const group = groups.get(itemId) || [];
    group.push({ ordinal, decision });
    groups.set(itemId, group);
  });

  const processDecision = async (decision: Record<string, unknown>, ordinal:number): Promise<QaOutput> => {
    const itemId = clean(decision.item_id), status = clean(decision.status).toUpperCase(), observation = clean(decision.observacao) || null;
    const [item] = await db.select().from(materializationItems).where(and(eq(materializationItems.batchId, batchId), eq(materializationItems.itemId, itemId))).limit(1);
    if (!item) return { ordinal, result:{ item_id: itemId, erro: "ITEM_NOT_FOUND" } };
    await logEvent(batchId, item.id, item.selectedCandidateId, "qa_decision", status, { observation }, Math.max(0, Date.now() - item.updatedAt.getTime()));
    if (status === "APROVADO") {
      try {
        const frozen = await freezeApprovedItem(item, observation);
        await db.update(collectionCandidates).set({ status: "APROVADO", assetId: frozen.asset_id, failureReason: null, updatedAt: now() }).where(eq(collectionCandidates.materializationItemId, item.id));
        if (item.routeClass === "FAST_PUSH_CANONICAL") {
          await db.update(fastPushCandidates).set({
            status: "PROMOTED_TO_ASSET", assetId: frozen.asset_id, decisionSource: "SUPERVISOR", decisionNote: observation,
            analyzedAt: now(), promotedAt: now(), projectLinkStatus: "RESOLVED_APPROVED", failureReason: null, updatedAt: now(),
          }).where(eq(fastPushCandidates.materializationItemId, item.id));
        }
        return { ordinal, result:frozen };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "QA_PERSISTENCE_FAILED";
        await db.update(materializationItems).set({ status: reason === "DB_SYNC_PENDING" ? "DB_SYNC_PENDING" : item.status, failureReason: reason, updatedAt: now() }).where(eq(materializationItems.id, item.id)).catch(() => undefined);
        await logEvent(batchId, item.id, item.selectedCandidateId, "qa_persistence_failed", reason, { observation });
        return { ordinal, result:{ item_id: itemId, status: reason, recuperavel_sem_download: reason === "DB_SYNC_PENDING" } };
      }
    }
    if (status === "REJEITADO" || status === "RELINK_REQUIRED") {
      if (item.selectedCandidateId) await db.update(materializationCandidates).set({ status: "VISUAL_QA_REJECTED", failureReason: observation || status, updatedAt: now() }).where(eq(materializationCandidates.id, item.selectedCandidateId));
      await db.update(materializationItems).set({
        status: status === "RELINK_REQUIRED" ? "RELINK_REQUIRED" : "PENDING",
        candidateCursor: item.candidateCursor + 1, failureReason: observation || status, updatedAt: now(),
      }).where(eq(materializationItems.id, item.id));
      await db.update(collectionCandidates).set({ status, failureReason: observation || status, updatedAt: now() }).where(eq(collectionCandidates.materializationItemId, item.id));
      if (item.routeClass === "FAST_PUSH_CANONICAL") {
        await db.update(fastPushCandidates).set({
          status: "REJECTED", decisionSource: "SUPERVISOR", decisionNote: observation || status, analyzedAt: now(),
          projectLinkStatus: "RESOLVED_REJECTED", failureReason: observation || status, updatedAt: now(),
        }).where(eq(fastPushCandidates.materializationItemId, item.id));
      }
      return { ordinal, result:{ item_id: itemId, status }, retryId: status === "REJEITADO" && item.routeClass !== "FAST_PUSH_CANONICAL" ? item.id : undefined };
    }
    if (status === "CORRECAO_TECNICA_PERMITIDA") {
      await db.update(materializationItems).set({ status: "TECHNICAL_CORRECTION_REQUIRED", failureReason: observation, updatedAt: now() }).where(eq(materializationItems.id, item.id));
      await db.update(collectionCandidates).set({ status: "CORRECAO_TECNICA", failureReason: observation, updatedAt: now() }).where(eq(collectionCandidates.materializationItemId, item.id));
      return { ordinal, result:{ item_id: itemId, status: "TECHNICAL_CORRECTION_REQUIRED" } };
    }
    return { ordinal, result:{ item_id: itemId, erro: "QA_STATUS_INVALID" } };
  };

  // V61.6: freezes de PITEMs distintos não aguardam uns aos outros. O mesmo item
  // continua sequencial para evitar corrida entre APROVAR/REJEITAR duplicados.
  const groupList = [...groups.values()];
  const groupOutputs = new Array<QaOutput[]>(groupList.length);
  let cursor = 0;
  const parallelism = Math.min(8, groupList.length);
  await Promise.all(Array.from({ length: parallelism }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= groupList.length) return;
      const output: QaOutput[] = [];
      for (const entry of groupList[index]) output.push(await processDecision(entry.decision, entry.ordinal));
      groupOutputs[index] = output;
    }
  }));
  const ordered = groupOutputs.flat().sort((a,b) => a.ordinal - b.ordinal);
  const results = ordered.map((row) => row.result);
  const retryIds = ordered.map((row) => row.retryId).filter((value): value is string => Boolean(value));
  if (retryIds.length) await processItems(retryIds);
  const batch = await syncBatchStatus(batchId);
  await logEvent(batchId, null, null, "qa_batch_registered", batch.status, { decisions: results.length, qa_parallelism: parallelism });
  return { batch_id: batchId, resultados: results, lote: batch, qa_parallelism: parallelism };
}

function clampByte(value: number) { return Math.max(0, Math.min(255, Math.round(value))); }

function resizeRgbaNearest(raw: Uint8Array, width: number, height: number, targetWidth: number, targetHeight: number) {
  const tw = Math.max(1, Math.round(targetWidth)), th = Math.max(1, Math.round(targetHeight));
  const output = new Uint8Array(tw * th * 4);
  for (let y = 0; y < th; y += 1) {
    const sy = Math.min(height - 1, Math.floor(y * height / th));
    for (let x = 0; x < tw; x += 1) {
      const sx = Math.min(width - 1, Math.floor(x * width / tw));
      const source = (sy * width + sx) * 4, target = (y * tw + x) * 4;
      output[target] = raw[source]; output[target + 1] = raw[source + 1]; output[target + 2] = raw[source + 2]; output[target + 3] = raw[source + 3];
    }
  }
  return { raw: output, width: tw, height: th };
}

function cropRgba(raw: Uint8Array, width: number, height: number, params: Record<string, unknown>) {
  const x = Math.max(0, Math.min(width - 1, Math.floor(Number(params.x) || 0)));
  const y = Math.max(0, Math.min(height - 1, Math.floor(Number(params.y) || 0)));
  const cropWidth = Math.max(1, Math.min(width - x, Math.floor(Number(params.width) || width - x)));
  const cropHeight = Math.max(1, Math.min(height - y, Math.floor(Number(params.height) || height - y)));
  const output = new Uint8Array(cropWidth * cropHeight * 4);
  for (let row = 0; row < cropHeight; row += 1) {
    const sourceStart = ((y + row) * width + x) * 4;
    output.set(raw.subarray(sourceStart, sourceStart + cropWidth * 4), row * cropWidth * 4);
  }
  return { raw: output, width: cropWidth, height: cropHeight };
}

function estimateBorderColor(raw: Uint8Array, width: number, height: number) {
  const samples: Array<[number, number, number]> = [];
  const stepX = Math.max(1, Math.floor(width / 24)), stepY = Math.max(1, Math.floor(height / 24));
  for (let x = 0; x < width; x += stepX) {
    for (const y of [0, Math.max(0, height - 1)]) { const i = (y * width + x) * 4; samples.push([raw[i], raw[i + 1], raw[i + 2]]); }
  }
  for (let y = 0; y < height; y += stepY) {
    for (const x of [0, Math.max(0, width - 1)]) { const i = (y * width + x) * 4; samples.push([raw[i], raw[i + 1], raw[i + 2]]); }
  }
  if (!samples.length) return [255, 255, 255] as const;
  const avg = [0, 1, 2].map((channel) => samples.reduce((sum, value) => sum + value[channel], 0) / samples.length);
  return [avg[0], avg[1], avg[2]] as const;
}

function removeSimpleBackground(raw: Uint8Array, width: number, height: number, params: Record<string, unknown>) {
  const output = new Uint8Array(raw);
  const [br, bg, bb] = estimateBorderColor(raw, width, height);
  const threshold = Math.max(8, Math.min(100, Number(params.threshold) || 28));
  const feather = Math.max(1, Math.min(80, Number(params.feather) || 24));
  for (let i = 0; i + 3 < output.length; i += 4) {
    const dr = output[i] - br, dg = output[i + 1] - bg, db = output[i + 2] - bb;
    const distance = Math.sqrt(dr * dr + dg * dg + db * db);
    if (distance <= threshold) output[i + 3] = 0;
    else if (distance < threshold + feather) output[i + 3] = Math.min(output[i + 3], clampByte(255 * (distance - threshold) / feather));
  }
  return output;
}

function cleanupAlpha(raw: Uint8Array, mode: "HALO" | "FRAGMENTOS" | "FEATHER") {
  const output = new Uint8Array(raw);
  if (mode === "FEATHER") {
    const alpha = new Uint8Array(raw.length / 4);
    for (let i = 3, p = 0; i < raw.length; i += 4, p += 1) alpha[p] = raw[i];
    for (let p = 0; p < alpha.length; p += 1) output[p * 4 + 3] = alpha[p] < 12 ? 0 : alpha[p];
    return output;
  }
  const cutoff = mode === "FRAGMENTOS" ? 36 : 18;
  for (let i = 3; i < output.length; i += 4) if (output[i] < cutoff) output[i] = 0;
  return output;
}

async function applyTechnicalOperationsToBytes(bytes: Uint8Array, mime: string, targetName: string, operations: string[], params: Record<string, unknown>) {
  if (!["image/jpeg", "image/png", "image/webp", "image/avif"].includes(mime)) throw new Error("TECHNICAL_FIX_UNSUPPORTED_MEDIA");
  const decoded = await sharp(bytes, { failOn: "error" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let width = decoded.info.width, height = decoded.info.height, raw = new Uint8Array(decoded.data);
  let forcePng = false;
  for (const operation of operations) {
    if (operation === "REMOVER_FUNDO" || operation === "ALPHA") { raw = removeSimpleBackground(raw, width, height, params); forcePng = true; continue; }
    if (operation === "HALO") { raw = cleanupAlpha(raw, "HALO"); forcePng = true; continue; }
    if (operation === "FRAGMENTOS") { raw = cleanupAlpha(raw, "FRAGMENTOS"); forcePng = true; continue; }
    if (operation === "FEATHER_LEVE") { raw = cleanupAlpha(raw, "FEATHER"); forcePng = true; continue; }
    if (operation === "CROP" || operation === "ENQUADRAMENTO") { const cropped = cropRgba(raw, width, height, params); raw = cropped.raw; width = cropped.width; height = cropped.height; continue; }
    if (operation === "RESIZE" || operation === "UPSCALE_TECNICO") {
      let targetWidth = Math.floor(Number(params.width) || 0), targetHeight = Math.floor(Number(params.height) || 0);
      if (!targetWidth && !targetHeight) {
        const maxSide = Math.max(64, Math.min(3840, Number(params.max_side) || (operation === "UPSCALE_TECNICO" ? Math.min(1920, Math.max(width, height) * 2) : 1920)));
        const scale = maxSide / Math.max(width, height); targetWidth = Math.max(1, Math.round(width * scale)); targetHeight = Math.max(1, Math.round(height * scale));
      } else if (!targetWidth) targetWidth = Math.max(1, Math.round(width * (targetHeight / height)));
      else if (!targetHeight) targetHeight = Math.max(1, Math.round(height * (targetWidth / width)));
      const resized = resizeRgbaNearest(raw, width, height, targetWidth, targetHeight); raw = resized.raw; width = resized.width; height = resized.height; continue;
    }
    if (operation === "FORMATO" || operation === "COMPRESSAO") continue;
    throw new Error(`TECHNICAL_OPERATION_NOT_IMPLEMENTED:${operation}`);
  }
  const target = targetImageFormat(targetName);
  const png = forcePng || target?.mime === "image/png" || hasAlpha(raw);
  let encoder = sharp(raw, { raw: { width, height, channels: 4 } });
  encoder = png ? encoder.png() : encoder.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality: Math.max(65, Math.min(98, Number(params.quality) || 92)) });
  const output = new Uint8Array(await encoder.toBuffer());
  const inspection = inspectBytes(output);
  if (!inspection.ok) throw new Error(inspection.reason);
  return { bytes: output, inspection, extension: inspection.extension, mimeType: inspection.mime };
}

export async function applyTechnicalCorrection(input: Record<string, unknown>) {
  const aliases: Record<string, string> = {
    REMOVE_BACKGROUND: "REMOVER_FUNDO", TRIM_HALO: "HALO", RESIZE_1920: "RESIZE", UPSCALE: "UPSCALE_TECNICO", CONVERT_FORMAT: "FORMATO",
  };
  const allowed = new Set(["REMOVER_FUNDO", "ALPHA", "HALO", "FEATHER_LEVE", "FRAGMENTOS", "CROP", "ENQUADRAMENTO", "RESIZE", "UPSCALE_TECNICO", "FORMATO", "COMPRESSAO"]);
  const rawOperations = Array.isArray(input.operacoes) ? input.operacoes : Array.isArray(input.technical_fixes) ? input.technical_fixes : [input.operacao];
  const operations = [...new Set(rawOperations.map((value) => aliases[clean(value).toUpperCase()] || clean(value).toUpperCase()).filter(Boolean))];
  if (!operations.length || operations.some((operation) => !allowed.has(operation))) throw new Error("CORRECAO_NAO_PERMITIDA");
  const batchId = clean(input.batch_id), itemId = clean(input.item_id);
  const db = getDb();
  const [item] = await db.select().from(materializationItems).where(and(eq(materializationItems.batchId, batchId), eq(materializationItems.itemId, itemId))).limit(1);
  if (!item) throw new Error("ITEM_NOT_FOUND");
  if (item.compositionClass !== "ISOLATED") throw new Error("TECHNICAL_FIX_ONLY_ALLOWED_FOR_ISOLATED");
  const parameters = input.parametros && typeof input.parametros === "object" ? input.parametros as Record<string, unknown> : input.technical_parameters && typeof input.technical_parameters === "object" ? input.technical_parameters as Record<string, unknown> : {};
  const correctedUrl = clean(input.url_resultado);
  if (correctedUrl) {
    const parentFileId = clean(input.parent_materialization_id) || item.selectedFileId || "";
    const result = await addCandidates({ batch_id: batchId, item_id: itemId, candidatas: [{ url: correctedUrl, fonte: "CORRECAO_TECNICA:" + operations.join("+"), parent_file_id: parentFileId, technical_operation: operations.join("+"), technical_parameters: parameters }] });
    await logEvent(batchId, item.id, null, "technical_correction_received", "CORRECAO_TECNICA", { operations, parent_materialization_id: parentFileId || null, parameters, composition_class: item.compositionClass, mode: "EXTERNAL_RESULT_URL" });
    return result;
  }
  if (!item.selectedFileId) throw new Error("TECHNICAL_FIX_SOURCE_FILE_REQUIRED");
  const [sourceFile] = await db.select().from(materializationFiles).where(eq(materializationFiles.id, item.selectedFileId)).limit(1);
  if (!sourceFile) throw new Error("TECHNICAL_FIX_SOURCE_FILE_NOT_FOUND");
  const priorTechnicalFiles = await db.select({ id: materializationFiles.id }).from(materializationFiles).where(and(eq(materializationFiles.itemDbId, item.id), sql`${materializationFiles.technicalOperation} IS NOT NULL`));
  if (priorTechnicalFiles.length >= 2 && input.reavaliado_antes_terceira !== true) throw new Error("TECHNICAL_FIX_LIMIT_REACHED_REEVALUATE_BEFORE_THIRD");
  const object = await env.BUCKET.get(sourceFile.r2Key);
  if (!object) throw new Error("TECHNICAL_FIX_SOURCE_OBJECT_NOT_FOUND");
  const sourceBytes = new Uint8Array(await object.arrayBuffer());
  const transformed = await applyTechnicalOperationsToBytes(sourceBytes, sourceFile.mimeType, item.targetName, operations, parameters);
  const digest = await sha256(transformed.bytes);
  const operationLabel = operations.join("+");
  const derivedFileId = await stableId("MATFILE", `${sourceFile.id}\n${operationLabel}\n${JSON.stringify(parameters)}\n${digest}`);
  const target = safeName(item.targetName.replace(/\.[^.]+$/, "") + "." + transformed.extension);
  const r2Key = `materialized/${batchId}/${item.itemId}/${derivedFileId}-${target}`;
  await env.BUCKET.put(r2Key, transformed.bytes, {
    httpMetadata: { contentType: transformed.mimeType },
    customMetadata: { batchId, itemDbId: item.id, candidateId: item.selectedCandidateId || sourceFile.candidateId, sha256: digest, technicalStatus: "TECHNICAL_OK", width: String(transformed.inspection.width || ""), height: String(transformed.inspection.height || ""), sourceFileId: sourceFile.id, technicalOperation: operationLabel, technicalParameters: JSON.stringify(parameters).slice(0, 900) },
  });
  await db.insert(materializationFiles).values({
    id: derivedFileId, itemDbId: item.id, candidateId: item.selectedCandidateId || sourceFile.candidateId, r2Key,
    mimeType: transformed.mimeType, sizeBytes: transformed.bytes.byteLength, width: transformed.inspection.width, height: transformed.inspection.height,
    sha256: digest, originalMimeType: sourceFile.mimeType, originalSha256: sourceFile.sha256, conversionType: "CORRECAO_TECNICA",
    sourceFileId: sourceFile.id, technicalOperation: operationLabel, technicalParameters: JSON.stringify(parameters), technicalStatus: "TECHNICAL_OK", createdAt: now(),
  }).onConflictDoNothing();
  await db.update(materializationItems).set({ status: "READY_FOR_VISUAL_QA", selectedFileId: derivedFileId, targetName: target, routeClass: "CORRECAO_TECNICA_SIMPLES", failureReason: null, updatedAt: now() }).where(eq(materializationItems.id, item.id));
  await logEvent(batchId, item.id, item.selectedCandidateId, "technical_correction_applied", "READY_FOR_VISUAL_QA", { operations, parameters, source_file_id: sourceFile.id, derived_file_id: derivedFileId, qa_status: "PENDING_VISUAL_QA" });
  return { batch_id: batchId, item_id: item.itemId, status: "READY_FOR_VISUAL_QA", source_file_id: sourceFile.id, derived_file_id: derivedFileId, technical_operation: operationLabel, technical_parameters: parameters, mime_type: transformed.mimeType, width: transformed.inspection.width, height: transformed.inspection.height };
}

export async function exportBatchZip(input: Record<string, unknown>, origin: string, code: string) {
  const db = getDb(), batchId = clean(input.batch_id);
  const [batch] = await db.select().from(materializationBatches).where(eq(materializationBatches.id, batchId)).limit(1);
  if (!batch) throw new Error("BATCH_NOT_FOUND");
  const allItems = await db.select().from(materializationItems).where(eq(materializationItems.batchId, batchId));
  const mappings = Array.isArray(input.arquivos) ? input.arquivos as Array<Record<string, unknown>> : [];
  const mapped = new Map<string, string>(mappings.map((entry): [string, string] => [clean(entry.item_id), safeName(clean(entry.arquivo_alvo))]).filter(([itemId]) => Boolean(itemId)));
  const knownIds = new Set(allItems.map((item) => item.itemId));
  const extras = [...mapped.keys()].filter((itemId) => !knownIds.has(itemId));
  if (extras.length) throw new Error("ZIP_GATE_FAILED extra_in_zip=" + extras.length + " extra=" + extras.join(","));
  const selectedItems = mapped.size ? allItems.filter((item) => mapped.has(item.itemId)) : allItems;
  if (!selectedItems.length) throw new Error("ZIP_EMPTY_SELECTION");
  const missing = selectedItems.filter((item) => item.status !== "FROZEN" || !item.frozenAssetId).map((item) => item.itemId);
  if (missing.length) throw new Error("ZIP_GATE_FAILED missing_from_zip=" + missing.length + " missing=" + missing.join(","));
  const assetIds = selectedItems.map((item) => item.frozenAssetId).filter((value): value is string => Boolean(value));
  const assetRows: Array<typeof assets.$inferSelect> = [];
  for (const ids of chunk([...new Set(assetIds)], 40)) if (ids.length) assetRows.push(...await db.select().from(assets).where(inArray(assets.id, ids)));
  const assetMap = new Map(assetRows.map((asset) => [asset.id, asset]));
  const files: Record<string, Uint8Array> = {};
  const bytesCache = new Map<string, Uint8Array>();
  const manifest: string[] = ["PROJETO_ORIGEM:", batch.project, "", "BATCH_ID:", batchId, "", "STATUS_QA:", "APROVADO", "", `TARGET_FILES_ESPERADOS: ${selectedItems.length}`, ""];
  let totalBytes = 0;
  const usedNames = new Set<string>();
  for (const item of selectedItems) {
    const asset = item.frozenAssetId ? assetMap.get(item.frozenAssetId) : null;
    if (!asset) throw new Error("ASSET_NOT_FOUND:" + item.itemId);
    let bytes = bytesCache.get(asset.id);
    if (!bytes) {
      const object = await env.BUCKET.get(asset.r2Key);
      if (!object) throw new Error("R2_FILE_NOT_FOUND:" + item.itemId);
      bytes = new Uint8Array(await object.arrayBuffer());
      bytesCache.set(asset.id, bytes);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > 50 * 1024 * 1024) throw new Error("ZIP_LIMIT_50_MB");
    let name = mapped.get(item.itemId) || item.targetName;
    if (!name.includes(".")) name += "." + (asset.originalName.split(".").pop() || "bin");
    name = safeName(name);
    const normalizedName = name.toLocaleLowerCase("pt-BR");
    if (usedNames.has(normalizedName)) throw new Error("DUPLICATE_TARGET_FILE:" + name);
    usedNames.add(normalizedName);
    files[name] = bytes;
    const [file] = item.selectedFileId ? await db.select().from(materializationFiles).where(eq(materializationFiles.id, item.selectedFileId)).limit(1) : [];
    const [candidate] = item.selectedCandidateId ? await db.select().from(materializationCandidates).where(eq(materializationCandidates.id, item.selectedCandidateId)).limit(1) : [];
    let parsedTags: string[] = [];
    try { parsedTags = JSON.parse(asset.tags) as string[]; } catch { parsedTags = []; }
    manifest.push(
      "[" + name + "]",
      "NOME_SEMANTICO: " + asset.name,
      "UNIVERSO: " + asset.universe,
      "PERSONAGEM: " + (asset.subject || ""),
      "TIPO: " + asset.kind,
      "TAGS: " + parsedTags.join(", "),
      "PROJETO_ORIGEM: " + batch.project,
      "PRESET: " + (item.preset || ""),
      "SLOT: " + (item.slot || ""),
      "USADO_PARA: " + (item.usedFor || ""),
      "REFERENCIA_ROTEIRO: " + (item.scriptReference || ""),
      "REFERENCIA_VISUAL: " + (item.visualReference || ""),
      "COMPOSITION_CLASS: " + item.compositionClass,
      "FONTE: " + (candidate?.source || ""),
      "URL_ORIGINAL: " + (candidate?.originalUrl || ""),
      "URL_RESOLVIDA: " + (candidate?.resolvedUrl || ""),
      "BATCH_ID: " + batchId,
      "MATERIALIZATION_ID: " + (file?.id || ""),
      "SOURCE_FILE_ID: " + (file?.sourceFileId || ""),
      "TECHNICAL_OPERATION: " + (file?.technicalOperation || ""),
      "TECHNICAL_PARAMETERS: " + (file?.technicalParameters || ""),
      "SHA256: " + (file?.sha256 || asset.sha256 || ""),
      "SHA256_ORIGINAL: " + (file?.originalSha256 || file?.sha256 || asset.sha256 || ""),
      "MIME_REAL: " + asset.mimeType,
      "MIME_ORIGINAL: " + (file?.originalMimeType || asset.mimeType),
      "MIME_FINAL: " + asset.mimeType,
      "EXTENSAO_FINAL: " + (name.split(".").pop()?.toLowerCase() || ""),
      "TIPO_CORRECAO: " + (file?.conversionType || file?.technicalOperation || ""),
      "LARGURA: " + (file?.width || ""),
      "ALTURA: " + (file?.height || ""),
      "ROTA_MATERIALIZACAO: " + item.routeClass,
      "ADAPTER: " + (candidate?.adapter || ""),
      "NUMERO_TENTATIVAS: " + (candidate?.attempts || 0),
      "HOST_FINAL: " + (candidate?.host || ""),
      "STATUS_QA: APROVADO",
      ""
    );
  }
  files["IMPORTACAO.txt"] = strToU8(manifest.join("\n"));
  const zip = zipSync(files, { level: 0 });
  const exportId = makeId("EXP");
  const partial = mapped.size > 0 && selectedItems.length < allItems.length;
  const fileName = safeName(clean(input.nome_zip) || "corvo-" + batchId + (partial ? "-parcial" : "") + ".zip").replace(/\.zip$/i, "") + ".zip";
  const r2Key = "exports/" + exportId + ".zip";
  const expires = Date.now() + 60 * 60_000;
  await env.BUCKET.put(r2Key, zip, { httpMetadata: { contentType: "application/zip" }, customMetadata: { fileName, expiresAt: String(expires), batchId, partial: String(partial), targetFiles: String(selectedItems.length) } });
  if (!partial) await db.update(materializationBatches).set({ status: "EXPORTED", updatedAt: now() }).where(eq(materializationBatches.id, batchId));
  await logEvent(batchId, null, null, partial ? "batch_partial_exported" : "batch_exported", partial ? "PARTIAL_EXPORTED" : "EXPORTED", { exportId, bytes: zip.byteLength, targetFiles: selectedItems.length });
  const uri = origin + "/api/exports/" + encodeURIComponent(exportId) + "?code=" + encodeURIComponent(code) + "&exp=" + expires;
  return {
    batch_id: batchId, exportacao_id: exportId, arquivo: fileName, tamanho_bytes: zip.byteLength,
    missing_from_zip: 0, extra_in_zip: 0, total_assets: new Set(assetIds).size, total_target_files: selectedItems.length, parcial: partial, url: uri,
    __resources: [{ name: fileName, uri, mimeType: "application/zip", description: (partial ? "ZIP parcial" : "ZIP final") + " do lote " + batchId }],
  };
}

export async function getMaterializationLog(input: Record<string, unknown>) {
  const db = getDb(), batchId = clean(input.batch_id), itemId = clean(input.item_id);
  let itemDbId = "";
  if (itemId) {
    const [item] = await db.select().from(materializationItems).where(and(eq(materializationItems.batchId, batchId), eq(materializationItems.itemId, itemId))).limit(1);
    itemDbId = item?.id || "";
  }
  const rows = itemDbId
    ? await db.select().from(materializationLogs).where(eq(materializationLogs.itemDbId, itemDbId)).orderBy(desc(materializationLogs.createdAt)).limit(200)
    : await db.select().from(materializationLogs).where(eq(materializationLogs.batchId, batchId)).orderBy(desc(materializationLogs.createdAt)).limit(500);
  return { batch_id: batchId, item_id: itemId || null, eventos: rows, total: rows.length };
}

export async function cancelMaterializationBatch(batchId: string) {
  const db = getDb();
  const [updated] = await db.update(materializationBatches).set({ cancelled: true, status: "CANCELLED", updatedAt: now() }).where(eq(materializationBatches.id, batchId)).returning();
  if (!updated) throw new Error("BATCH_NOT_FOUND");
  await db.update(materializationItems).set({ status: "CANCELLED", updatedAt: now() }).where(eq(materializationItems.batchId, batchId));
  return updated;
}

export async function getHostHealth(host?: string) {
  const db = getDb();
  const rows = host
    ? await db.select().from(materializationHostHealth).where(eq(materializationHostHealth.host, host.toLowerCase())).limit(1)
    : await db.select().from(materializationHostHealth).orderBy(desc(materializationHostHealth.updatedAt)).limit(200);
  return { hosts: rows, total: rows.length };
}

export async function probeMaterializationUrl(input: Record<string, unknown>) {
  const rawUrl = clean(input.url), force = input.forcar === true;
  const initial = validateExternalUrl(rawUrl);
  const urlHash = await sha256(new TextEncoder().encode(initial.toString()));
  const db = getDb();
  const [previousProbe] = await db.select().from(materializationHostProbes).where(eq(materializationHostProbes.urlHash, urlHash)).orderBy(desc(materializationHostProbes.createdAt)).limit(1);
  if (!force && previousProbe && Date.now() - previousProbe.createdAt.getTime() < CIRCUIT_BREAK_MS) {
    throw new Error(`PROBE_WINDOW_ACTIVE:${Math.ceil((CIRCUIT_BREAK_MS - (Date.now() - previousProbe.createdAt.getTime())) / 1000)}s`);
  }
  const [before] = await db.select().from(materializationHostHealth).where(eq(materializationHostHealth.host, initial.hostname.toLowerCase())).limit(1);
  let current = adaptInitialUrl(initial), redirects = 0, httpStatus: number | null = null, contentType: string | null = null, detail = "OK", success = false;
  try {
    while (redirects <= MAX_REDIRECTS) {
      current = validateExternalUrl(current.toString());
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(current.toString(), { redirect: "manual", signal: controller.signal, headers: { "range": "bytes=0-2047", "accept": "image/*,video/*,*/*;q=0.2", "user-agent": "CorvoLibraryProbe/1.0" } });
        httpStatus = response.status; contentType = (response.headers.get("content-type") || "").split(";")[0] || null;
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
          if (!location) throw new Error("REDIRECT_WITHOUT_LOCATION");
          current = validateExternalUrl(new URL(location, current).toString()); redirects += 1; continue;
        }
        success = response.ok || response.status === 206;
        if (!success) detail = `HTTP_${response.status}`;
        try { await response.body?.cancel(); } catch { /* no-op */ }
        break;
      } finally { clearTimeout(timer); }
    }
  } catch (error) {
    detail = error instanceof Error ? error.message : "PROBE_FAILED";
  }
  const host = current.hostname.toLowerCase();
  await recordHost(host, success).catch(() => undefined);
  await db.insert(materializationHostProbes).values({ id: makeId("PROBE"), urlHash, url: initial.toString(), host, status: success ? "SUCCESS" : "FAILED", httpStatus, contentType, detail, createdAt: now() });
  const [after] = await db.select().from(materializationHostHealth).where(eq(materializationHostHealth.host, host)).limit(1);
  return { action: "PROBE_URL", url: initial.toString(), resolved_host: host, success, http_status: httpStatus, content_type: contentType, detail, redirects, circuit_before: before || null, circuit_after: after || null };
}

export async function materializationStats() {
  const db = getDb();
  const [batchStats] = await db.select({ total: sql<number>`count(*)`, completed: sql<number>`sum(case when ${materializationBatches.status} in ('READY_TO_EXPORT','EXPORTED','COMPLETED') then 1 else 0 end)` }).from(materializationBatches);
  const [fileStats] = await db.select({
    total: sql<number>`count(*)`, bytes: sql<number>`sum(${materializationFiles.sizeBytes})`,
    conversoes: sql<number>`sum(case when ${materializationFiles.conversionType} is not null then 1 else 0 end)`,
  }).from(materializationFiles);
  const [candidateStats] = await db.select({ total: sql<number>`count(*)`, success: sql<number>`sum(case when ${materializationCandidates.status} in ('MATERIALIZED','DUPLICATE') then 1 else 0 end)` }).from(materializationCandidates);
  const recentBatches = await db.select({ id: materializationBatches.id }).from(materializationBatches).orderBy(desc(materializationBatches.createdAt)).limit(10);
  const batchIds = recentBatches.map((batch) => batch.id);
  const recentItems = batchIds.length ? await db.select().from(materializationItems).where(inArray(materializationItems.batchId, batchIds)) : [];
  const recentItemIds = recentItems.map((item) => item.id);
  const recentCandidates = recentItemIds.length ? await db.select().from(materializationCandidates).where(inArray(materializationCandidates.itemDbId, recentItemIds)) : [];
  const recentLogs = batchIds.length ? await db.select().from(materializationLogs).where(inArray(materializationLogs.batchId, batchIds)) : [];
  const successfulItems = recentItems.filter((item) => ["READY_FOR_VISUAL_QA", "FROZEN"].includes(item.status)).length;
  const timedLogs = recentLogs.filter((entry) => typeof entry.durationMs === "number");
  const failuresByHost: Record<string, number> = {};
  for (const candidate of recentCandidates.filter((entry) => entry.failureReason)) failuresByHost[candidate.host || "host_inicial_nao_resolvido"] = (failuresByHost[candidate.host || "host_inicial_nao_resolvido"] || 0) + 1;
  return {
    lotes: batchStats, arquivos: fileStats, candidatas: candidateStats,
    concorrencia: { global: GLOBAL_CONCURRENCY, por_host: PER_HOST_CONCURRENCY }, feature_flags: await materializerFlags(),
    primeiros_lotes: {
      lotes_monitorados: batchIds.length, itens: recentItems.length,
      taxa_materializacao: recentItems.length ? successfulItems / recentItems.length : 0,
      retries: recentCandidates.reduce((total, candidate) => total + Math.max(0, candidate.attempts - 1), 0),
      candidatas_usadas: recentCandidates.filter((candidate) => candidate.attempts > 0).length,
      tempo_medio_item_ms: timedLogs.length ? Math.round(timedLogs.reduce((total, entry) => total + (entry.durationMs || 0), 0) / timedLogs.length) : 0,
      falhas_d1: recentLogs.filter((entry) => entry.status === "DB_SYNC_PENDING").length,
      falhas_r2: recentLogs.filter((entry) => entry.status?.startsWith("R2_") || entry.event.includes("r2_")).length,
      falhas_conversao: recentLogs.filter((entry) => entry.event === "format_conversion_failed").length,
      entregas_qa_vazias: recentLogs.filter((entry) => entry.event === "qa_delivery" && entry.status === "EMPTY").length,
      exportacoes_zip: recentLogs.filter((entry) => entry.event === "batch_exported").length,
      falhas_por_host: failuresByHost,
    },
  };
}

export async function findDuplicateHash(hash: string) {
  const db = getDb();
  const permanent = await db.select().from(assets).where(eq(assets.sha256, hash)).limit(20);
  const temporary = await db.select().from(materializationFiles).where(eq(materializationFiles.sha256, hash)).limit(20);
  return { sha256: hash, assets: permanent, materializacoes: temporary, duplicata: permanent.length > 0 || temporary.length > 0 };
}

export async function resolveOrTestUrl(url: string, download = false) {
  validateExternalUrl(url);
  if (!download) {
    const result = await fetchMaterial(url);
    const inspection = inspectBytes(result.bytes);
    return { url_original: result.originalUrl, url_resolvida: result.resolvedUrl, host: result.host, adapter: result.adapter, http_status: result.httpStatus, content_type: result.declaredType, content_length: result.declaredLength, redirects_count: result.redirects, technical_preview: inspection };
  }
  return materializeUrl({ projeto: "Teste de URL", item_id: "teste", arquivo_alvo: "teste.bin", conceito: "Teste técnico", url });
}

export function listAdapters() {
  return {
    adapters: [
      { id: "generic", classe: "B", descricao: "Redirects e metatags Open Graph" },
      { id: "github-public", classe: "B", descricao: "Converte github.com/blob para raw.githubusercontent.com" },
      { id: "pinterest", classe: "B", descricao: "Aceita CDN direto e extrai Open Graph quando público" },
      { id: "fandom-wikia", classe: "B", descricao: "Resolve CDN e Open Graph de páginas públicas" },
      { id: "wikimedia", classe: "B", descricao: "Resolve mídia pública e redirects" },
      { id: "reddit-media", classe: "B", descricao: "Resolve hosts de mídia pública" },
      { id: "knowyourmeme", classe: "B", descricao: "Extrai Open Graph de página pública" },
    ],
    instalacao_automatica_codigo_publico: false,
  };
}

export async function cleanupBatchTemps(batchId: string, confirm: boolean) {
  if (!confirm) throw new Error("Defina confirmar=true.");
  const db = getDb();
  const items = await db.select().from(materializationItems).where(eq(materializationItems.batchId, batchId));
  if (items.some((item) => item.status === "READY_FOR_VISUAL_QA")) throw new Error("Há itens aguardando QA; cancele ou conclua antes de limpar.");
  const listed = await env.BUCKET.list({ prefix: "materialized/" + batchId + "/", limit: 1000 });
  if (listed.objects.length) await env.BUCKET.delete(listed.objects.map((object) => object.key));
  return { batch_id: batchId, objetos_removidos: listed.objects.length, truncado: listed.truncated };
}
