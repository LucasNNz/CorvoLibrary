import { env } from "./platform/runtime";
import { eq, sql } from "drizzle-orm";
import { inflateSync } from "fflate";
import { getDb } from "../db";
import { assetUsage, assets, imports } from "../db/schema";

type ZipEntry = {
  path: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
};

type ManifestData = {
  headers: Record<string, string>;
  sections: Map<string, Record<string, string>>;
};

const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
const MAX_ENTRY_BYTES = 150 * 1024 * 1024;
export const SUPPORTED_MEDIA_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
  svg: "image/svg+xml",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
};

const defaultKind = (extension: string) => extension === "gif" ? "GIF" : SUPPORTED_MEDIA_MIME[extension]?.startsWith("video/") ? "Vídeo" : "Imagem";

const u16 = (bytes: Uint8Array, offset: number) => bytes[offset] | (bytes[offset + 1] << 8);
const u32 = (bytes: Uint8Array, offset: number) => (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
const basename = (value: string) => normalizePath(value).split("/").pop() || "arquivo";
const cleanName = (value: string) => value.replace(/[^a-zA-Z0-9._-]/g, "-");
const normalizeLookup = (value: string) => normalizePath(value).normalize("NFC").toLocaleLowerCase("pt-BR");
const isYes = (value?: string) => /^(sim|s|yes|true|1)$/i.test((value || "").trim());

function parseZip(bytes: Uint8Array): ZipEntry[] {
  let eocd = -1;
  const floor = Math.max(0, bytes.length - 65_557);
  for (let cursor = bytes.length - 22; cursor >= floor; cursor -= 1) {
    if (u32(bytes, cursor) === 0x06054b50) { eocd = cursor; break; }
  }
  if (eocd < 0) throw new Error("ZIP inválido: diretório central não encontrado.");
  const totalEntries = u16(bytes, eocd + 10);
  const centralSize = u32(bytes, eocd + 12);
  const centralOffset = u32(bytes, eocd + 16);
  if (totalEntries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) throw new Error("ZIP64 ainda não é aceito neste importador.");
  if (centralOffset + centralSize > bytes.length) throw new Error("ZIP inválido: diretório central incompleto.");
  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  let totalUncompressed = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (u32(bytes, cursor) !== 0x02014b50) throw new Error("ZIP inválido: entrada central corrompida.");
    const flags = u16(bytes, cursor + 8);
    const method = u16(bytes, cursor + 10);
    const compressedSize = u32(bytes, cursor + 20);
    const uncompressedSize = u32(bytes, cursor + 24);
    const nameLength = u16(bytes, cursor + 28);
    const extraLength = u16(bytes, cursor + 30);
    const commentLength = u16(bytes, cursor + 32);
    const localOffset = u32(bytes, cursor + 42);
    const end = cursor + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new Error("ZIP inválido: metadados de entrada incompletos.");
    const rawPath = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const path = normalizePath(rawPath);
    if (path && !rawPath.endsWith("/")) {
      totalUncompressed += uncompressedSize;
      if (uncompressedSize > MAX_ENTRY_BYTES) throw new Error(`Entrada muito grande no ZIP: ${path}.`);
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) throw new Error("O conteúdo descompactado excede o limite de 1 GB.");
      entries.push({ path, method, flags, compressedSize, uncompressedSize, localOffset });
    }
    cursor = end;
  }
  return entries;
}

function extractEntry(zip: Uint8Array, entry: ZipEntry) {
  if (entry.flags & 1) throw new Error("arquivo criptografado não é aceito");
  if (u32(zip, entry.localOffset) !== 0x04034b50) throw new Error("cabeçalho local inválido");
  const nameLength = u16(zip, entry.localOffset + 26);
  const extraLength = u16(zip, entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const end = start + entry.compressedSize;
  if (end > zip.length) throw new Error("dados comprimidos incompletos");
  const compressed = zip.subarray(start, end);
  const output = entry.method === 0 ? new Uint8Array(compressed) : entry.method === 8 ? inflateSync(compressed) : null;
  if (!output) throw new Error(`método de compressão ${entry.method} não suportado`);
  if (output.byteLength !== entry.uncompressedSize) throw new Error("tamanho descompactado divergente");
  return output;
}

function parseManifest(raw: string): ManifestData {
  const headers: Record<string, string> = {};
  const sections = new Map<string, Record<string, string>>();
  const lines = raw.replace(/^\uFEFF/, "").replace(/\r/g, "").split("\n");
  let current = headers;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const section = line.match(/^\[(.+)]$/);
    if (section) {
      current = {};
      sections.set(normalizeLookup(section[1]), current);
      continue;
    }
    const field = line.match(/^([A-ZÀ-Ú0-9_]+)\s*:\s*(.*)$/i);
    if (!field) continue;
    const key = field[1].toLocaleUpperCase("pt-BR");
    let value = field[2].trim();
    if (!value) {
      for (let next = index + 1; next < lines.length; next += 1) {
        const candidate = lines[next].trim();
        if (!candidate) continue;
        if (/^\[.+]$/.test(candidate) || /^[A-ZÀ-Ú0-9_]+\s*:/i.test(candidate)) break;
        value = candidate;
        index = next;
        break;
      }
    }
    current[key] = value;
  }
  return { headers, sections };
}

async function stableId(prefix: string, value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = Array.from(new Uint8Array(digest).subarray(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `${prefix}-${hex}`;
}

function tagsOf(value?: string) {
  if (!value) return [];
  return [...new Set(value.split(/[,;|]/).map((tag) => tag.trim()).filter(Boolean))];
}

function metadataFor(path: string, manifest: ManifestData | null) {
  const file = basename(path);
  const extension = (file.split(".").pop() || "").toLocaleLowerCase();
  const exact = manifest?.sections.get(normalizeLookup(path));
  const byName = manifest?.sections.get(normalizeLookup(file));
  const section = exact || byName || {};
  const headers = manifest?.headers || {};
  const qaStatus = (section.STATUS_QA || "NAO_AVALIADO").toLocaleUpperCase("pt-BR");
  const status = qaStatus === "APROVADO" ? "Aprovado" : qaStatus === "RESSALVA" ? "Pendente revisão" : "Pendente";
  const stem = file.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
  const mediaTags = [section.FUNCAO_VISUAL, section.MOVIMENTO, section.ORIENTACAO, section.FUNDO, section.TRANSPARENCIA, isYes(section.LOOP) ? "loop" : "", section.AUDIO].filter(Boolean).join(",");
  const technicalContext = [
    section.FUNCAO_VISUAL && `Função visual: ${section.FUNCAO_VISUAL}`,
    section.MOVIMENTO && `Movimento: ${section.MOVIMENTO}`,
    section.LOOP && `Loop: ${section.LOOP}`,
    section.AUDIO && `Áudio: ${section.AUDIO}`,
    section.DURACAO_SEGUNDOS && `Duração: ${section.DURACAO_SEGUNDOS} segundos`,
    section.ORIENTACAO && `Orientação: ${section.ORIENTACAO}`,
    section.RESOLUCAO && `Resolução: ${section.RESOLUCAO}`,
    section.FPS && `FPS: ${section.FPS}`,
    section.FUNDO && `Fundo: ${section.FUNDO}`,
    section.TRANSPARENCIA && `Transparência: ${section.TRANSPARENCIA}`,
  ].filter(Boolean).join("\n");
  return {
    section,
    hasSection: Boolean(exact || byName),
    name: section.NOME_SEMANTICO || stem || file,
    universe: section.UNIVERSO || headers.UNIVERSO_PADRAO || "Sem universo",
    kind: section.TIPO || section.TIPO_MIDIA || defaultKind(extension),
    subject: section.PERSONAGEM || section.OBJETO || section.LOCAL || section.SUJEITO || null,
    tags: tagsOf([section.TAGS, mediaTags].filter(Boolean).join(",")),
    projectOrigin: section.PROJETO_ORIGEM || headers.PROJETO_ORIGEM || null,
    scriptReference: section.REFERENCIA_ROTEIRO || null,
    visualReference: section.REFERENCIA_VISUAL || null,
    sourceUrl: section.URL_ORIGINAL || section.FONTE || null,
    operationalNote: [section.OBSERVACAO, technicalContext, headers.OBSERVACAO_GERAL].filter(Boolean).join("\n") || null,
    qaStatus,
    status,
    registerInitialUse: isYes(section.REGISTRAR_USO_INICIAL || headers.REGISTRAR_USO_INICIAL),
  };
}

export async function processZipImport(importId: string) {
  const db = getDb();
  const [job] = await db.select().from(imports).where(eq(imports.id, importId)).limit(1);
  if (!job) throw new Error(`Importação ${importId} não encontrada.`);
  await db.update(imports).set({ status: "Processando" }).where(eq(imports.id, importId));
  const warnings: string[] = (() => { try { return JSON.parse(job.warnings) as string[]; } catch { return []; } })();
  try {
    const object = await env.BUCKET.get(job.r2Key);
    if (!object) throw new Error("O ZIP da importação não foi encontrado no R2.");
    const zip = new Uint8Array(await object.arrayBuffer());
    const entries = parseZip(zip);
    const manifestEntry = entries.find((entry) => basename(entry.path).toLocaleUpperCase("pt-BR") === "IMPORTACAO.TXT");
    let manifestText = job.manifestText;
    if (!manifestText && manifestEntry) manifestText = new TextDecoder("utf-8").decode(extractEntry(zip, manifestEntry));
    const manifest = manifestText ? parseManifest(manifestText) : null;
    if (!manifest) warnings.push("IMPORTACAO.txt não encontrado; metadados desconhecidos foram mantidos como pendentes.");
    await db.update(imports).set({ manifestText, warnings: JSON.stringify([...new Set(warnings)]) }).where(eq(imports.id, importId));

    const mediaEntries = entries.filter((entry) => Boolean(SUPPORTED_MEDIA_MIME[(entry.path.split(".").pop() || "").toLocaleLowerCase()]));
    if (!mediaEntries.length) warnings.push("Nenhuma mídia compatível foi encontrada no ZIP.");
    let cataloged = 0;
    let updated = 0;
    let usages = 0;
    const matchedSections = new Set<string>();

    async function ensureInitialUsage(assetId: string, entry: ZipEntry, meta: ReturnType<typeof metadataFor>) {
      if (!meta.registerInitialUse) return;
      if (!meta.projectOrigin) {
        warnings.push(`${entry.path}: uso inicial ignorado porque PROJETO_ORIGEM está vazio.`);
        return;
      }
      const usageId = await stableId("USE", `${assetId}\ninicial\n${meta.projectOrigin}\n${meta.section.BLOCO || ""}\n${meta.section.PRESET || ""}\n${meta.section.SLOT || ""}`);
      const [existingUsage] = await db.select({ id: assetUsage.id }).from(assetUsage).where(eq(assetUsage.id, usageId)).limit(1);
      if (existingUsage) return;
      const now = new Date();
      await db.insert(assetUsage).values({ id: usageId, assetId, project: meta.projectOrigin, block: meta.section.BLOCO || null, preset: meta.section.PRESET || null, slot: meta.section.SLOT || null, role: meta.section.USADO_PARA || null, scriptReference: meta.section.REFERENCIA_ROTEIRO || null, note: meta.section.OBSERVACAO || null, usedAt: now });
      await db.update(assets).set({ useCount: sql`${assets.useCount} + 1`, lastUsedAt: now, updatedAt: now }).where(eq(assets.id, assetId));
      usages += 1;
    }

    let cursor = 0;
    async function processNextEntries() {
      while (cursor < mediaEntries.length) {
        const entry = mediaEntries[cursor++];
      try {
        const extension = (entry.path.split(".").pop() || "").toLocaleLowerCase();
        const meta = metadataFor(entry.path, manifest);
        if (meta.hasSection) {
          matchedSections.add(normalizeLookup(entry.path));
          matchedSections.add(normalizeLookup(basename(entry.path)));
        }
        const assetId = await stableId("AST", `${importId}\n${normalizeLookup(entry.path)}`);
        const targetName = cleanName(basename(entry.path));
        const r2Key = `assets/${assetId}/${targetName}`;
        const metadata = {
          name: meta.name,
          universe: meta.universe,
          kind: meta.kind,
          subject: meta.subject,
          status: meta.status,
          tags: JSON.stringify(meta.tags),
          projectOrigin: meta.projectOrigin,
          scriptReference: meta.scriptReference,
          visualReference: meta.visualReference,
          sourceUrl: meta.sourceUrl,
          operationalNote: meta.operationalNote,
          qaStatus: meta.qaStatus,
          updatedAt: new Date(),
        };
        const [existing] = await db.select({ id: assets.id }).from(assets).where(eq(assets.id, assetId)).limit(1);
        if (existing) {
          await db.update(assets).set(metadata).where(eq(assets.id, assetId));
          updated += 1;
        } else {
          const data = extractEntry(zip, entry);
          await env.BUCKET.put(r2Key, data, { httpMetadata: { contentType: SUPPORTED_MEDIA_MIME[extension] } });
          await db.insert(assets).values({ id: assetId, ...metadata, r2Key, originalName: basename(entry.path), mimeType: SUPPORTED_MEDIA_MIME[extension], sizeBytes: data.byteLength });
          cataloged += 1;
        }
        await ensureInitialUsage(assetId, entry, meta);
      } catch (error) {
        warnings.push(`${entry.path}: ${error instanceof Error ? error.message : "falha ao processar"}`);
      }
      }
    }
    await Promise.all(Array.from({ length: Math.min(6, mediaEntries.length || 1) }, () => processNextEntries()));

    if (manifest) {
      for (const section of manifest.sections.keys()) {
        if (!matchedSections.has(section)) warnings.push(`Manifesto sem mídia correspondente: ${section}.`);
      }
    }
    const uniqueWarnings = [...new Set(warnings)];
    const status = uniqueWarnings.length ? "Concluído com avisos" : "Concluído";
    await db.update(imports).set({ status, manifestText, warnings: JSON.stringify(uniqueWarnings) }).where(eq(imports.id, importId));
    return { importacao_id: importId, status, midias_no_zip: mediaEntries.length, imagens_no_zip: mediaEntries.filter((entry) => SUPPORTED_MEDIA_MIME[(entry.path.split(".").pop() || "").toLocaleLowerCase()].startsWith("image/")).length, videos_no_zip: mediaEntries.filter((entry) => SUPPORTED_MEDIA_MIME[(entry.path.split(".").pop() || "").toLocaleLowerCase()].startsWith("video/")).length, assets_catalogados: cataloged, assets_atualizados: updated, usos_iniciais_registrados: usages, manifesto_lido: Boolean(manifestText), avisos: uniqueWarnings };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha inesperada no processamento do ZIP.";
    warnings.push(message);
    await db.update(imports).set({ status: "Erro", warnings: JSON.stringify(warnings) }).where(eq(imports.id, importId));
    throw error;
  }
}
