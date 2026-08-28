import { env } from "./platform/runtime";
import sharp from "sharp";
import { and, asc, desc, eq, inArray, like, notInArray, or, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  assets,
  automaticProjectEvents,
  automaticProjectItems,
  automaticProjects,
  materializationFiles,
  materializationItems,
  operationResults,
  settings,
  supervisorProjectCandidates,
} from "../db/schema";
import { createSignedR2GetUrl } from "./r2-download";
import { resolveMediaMime } from "./media-mime";

const CHAT_DELIVERY_KEY = "CHAT_FILE_DELIVERY_MODE";
const MCP_RESOURCE_KEY = "MCP_FILE_RESOURCE_DELIVERY";
const MODE_CACHE_MS = 5_000;
let modeCache: { value: ChatDeliveryMode; expiresAt: number } | null = null;

export type ChatDeliveryMode = {
  chat_file_delivery_mode: "OFF" | "ON";
  mcp_file_resource_delivery: "DISABLED" | "ENABLED";
  links_only: boolean;
  rule: string;
};

const clean = (value: unknown) => typeof value === "string" ? value.trim() : "";
const json = <T,>(value: string | null | undefined, fallback: T): T => { try { return value ? JSON.parse(value) as T : fallback; } catch { return fallback; } };
const now = () => new Date();
const safe = (value: string) => value.replace(/[^a-zA-Z0-9À-ÿ._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "project";
const terminalStatuses = ["APPROVED","FROZEN","LINKED_FROM_LIBRARY","LINKED_FROM_FAMILY","CANCELLED"];

async function signPreview(r2Key: string, mimeType: string, fileName?: string, includeOriginal = false) {
  try {
    const signed_preview_url = await createSignedR2GetUrl(r2Key, 30, undefined, mimeType);
    const signed_original_url = includeOriginal ? await createSignedR2GetUrl(r2Key, 30, fileName, mimeType) : null;
    return { signed_preview_url, signed_original_url, signing_error: null as string | null };
  } catch (error) {
    return { signed_preview_url: null, signed_original_url: null, signing_error: error instanceof Error ? error.message : String(error) };
  }
}

export async function getChatDeliveryMode(force = false): Promise<ChatDeliveryMode> {
  if (!force && modeCache && modeCache.expiresAt > Date.now()) return modeCache.value;
  const rows = await getDb().select().from(settings).where(inArray(settings.key, [CHAT_DELIVERY_KEY, MCP_RESOURCE_KEY]));
  const map = new Map(rows.map((row) => [row.key, row.value.trim().toUpperCase()]));
  // Industrial-safe default: no outgoing MCP file resources unless explicitly enabled.
  const chatMode = map.get(CHAT_DELIVERY_KEY) === "ON" ? "ON" : "OFF";
  const resourceMode = chatMode === "ON" && map.get(MCP_RESOURCE_KEY) === "ENABLED" ? "ENABLED" : "DISABLED";
  const value: ChatDeliveryMode = {
    chat_file_delivery_mode: chatMode,
    mcp_file_resource_delivery: resourceMode,
    links_only: resourceMode !== "ENABLED",
    rule: resourceMode === "ENABLED" ? "LEGACY_RESOURCE_LINKS_ALLOWED" : "IDS_METADATA_SIGNED_R2_URLS_ONLY",
  };
  modeCache = { value, expiresAt: Date.now() + MODE_CACHE_MS };
  return value;
}

export async function isMcpFileResourceDeliveryEnabled() {
  return (await getChatDeliveryMode()).mcp_file_resource_delivery === "ENABLED";
}

export async function configureChatDeliveryMode(modeInput: unknown) {
  const mode = clean(modeInput).toUpperCase();
  if (!["OFF","ON"].includes(mode)) throw new Error("CHAT_FILE_DELIVERY_MODE_INVALID");
  const date = now();
  const resource = mode === "ON" ? "ENABLED" : "DISABLED";
  const db = getDb();
  await db.batch([
    db.insert(settings).values({ key:CHAT_DELIVERY_KEY, value:mode, updatedAt:date }).onConflictDoUpdate({ target:settings.key, set:{ value:mode, updatedAt:date } }),
    db.insert(settings).values({ key:MCP_RESOURCE_KEY, value:resource, updatedAt:date }).onConflictDoUpdate({ target:settings.key, set:{ value:resource, updatedAt:date } }),
  ]);
  modeCache = null;
  return getChatDeliveryMode(true);
}

type PacketInput = {
  project_id: unknown;
  limit?: unknown;
  item_ids?: unknown;
  target_files?: unknown;
  only_waiting_qa?: unknown;
  include_original_url?: unknown;
};

function list(value: unknown, max = 100) {
  return [...new Set((Array.isArray(value) ? value : []).map(clean).filter(Boolean))].slice(0, max);
}

async function resolveProjectItemIds(projectId: string, itemIdsInput: unknown, targetFilesInput: unknown) {
  const selectors = [...list(itemIdsInput), ...list(targetFilesInput)];
  if (!selectors.length) return null;
  const db = getDb();
  const rows = await db.select({ id:automaticProjectItems.id, itemKey:automaticProjectItems.itemKey, targetFile:automaticProjectItems.targetFile })
    .from(automaticProjectItems).where(eq(automaticProjectItems.projectId, projectId));
  const resolved = new Set<string>();
  for (const selector of selectors) {
    for (const row of rows) if ([row.id,row.itemKey,row.targetFile].some((value) => clean(value) === selector)) resolved.add(row.id);
  }
  return [...resolved];
}

export async function getFastVisualPacket(input: PacketInput) {
  const startedAt = Date.now();
  const projectId = clean(input.project_id);
  if (!projectId) throw new Error("PROJECT_ID_REQUIRED");
  const limit = Math.max(1, Math.min(50, Number(input.limit) || 20));
  const onlyWaiting = input.only_waiting_qa !== false;
  const includeOriginal = input.include_original_url === true;
  const db = getDb();
  const [project] = await db.select({ id:automaticProjects.id, activeVersion:automaticProjects.activeVersion, stateVersion:automaticProjects.stateVersion }).from(automaticProjects).where(eq(automaticProjects.id, projectId)).limit(1);
  if (!project) throw new Error("PROJECT_NOT_FOUND");
  const resolvedIds = await resolveProjectItemIds(projectId, input.item_ids, input.target_files);
  if (resolvedIds && !resolvedIds.length) return { project_id:projectId, total:0, candidates:[], mode:"LINKS_ONLY", project_version:project.stateVersion, backend_ms:Date.now()-startedAt };

  const conditions = [eq(supervisorProjectCandidates.projectId, projectId)];
  if (onlyWaiting) conditions.push(eq(supervisorProjectCandidates.status, "PARA_QA_VISUAL"));
  else conditions.push(inArray(supervisorProjectCandidates.status, ["PARA_QA_VISUAL","PARA_ANALISE"]));
  if (resolvedIds?.length) conditions.push(inArray(supervisorProjectCandidates.itemId, resolvedIds));
  const bridges = await db.select().from(supervisorProjectCandidates).where(and(...conditions)).orderBy(
    sql`case when ${supervisorProjectCandidates.status} = 'PARA_QA_VISUAL' then 0 else 1 end`,
    asc(supervisorProjectCandidates.createdAt),
  ).limit(limit);
  if (!bridges.length) return { project_id:projectId, total:0, candidates:[], mode:"LINKS_ONLY", project_version:project.stateVersion, backend_ms:Date.now()-startedAt };

  const itemIds = [...new Set(bridges.map((row) => row.itemId))];
  const fileIds = [...new Set(bridges.map((row) => row.materializationFileId))];
  const matItemIds = [...new Set(bridges.map((row) => row.materializationItemId))];
  const [items, files, matItems] = await Promise.all([
    db.select().from(automaticProjectItems).where(and(inArray(automaticProjectItems.id, itemIds), eq(automaticProjectItems.version, project.activeVersion))),
    db.select().from(materializationFiles).where(inArray(materializationFiles.id, fileIds)),
    db.select().from(materializationItems).where(inArray(materializationItems.id, matItemIds)),
  ]);
  const itemMap = new Map(items.map((row) => [row.id, row]));
  const fileMap = new Map(files.map((row) => [row.id, row]));
  const matMap = new Map(matItems.map((row) => [row.id, row]));
  const rows = bridges.flatMap((bridge) => {
    const item = itemMap.get(bridge.itemId), file = fileMap.get(bridge.materializationFileId), matItem = matMap.get(bridge.materializationItemId);
    if (!item || !file || !matItem) return [];
    return [{ bridge, item, file, matItem }];
  });
  const signed = await Promise.all(rows.map(({ item, file }) => signPreview(file.r2Key, file.mimeType, item.targetFile || item.itemKey, includeOriginal)));
  const candidates = rows.map(({ bridge, item, file, matItem }, index) => {
    const metadata = json<Record<string, unknown>>(bridge.metadata, {});
    const urls = signed[index];
    return {
      project_id:projectId,
      item_id:item.id,
      pitem_id:item.id,
      item_key:item.itemKey,
      target_file:item.targetFile || item.itemKey,
      candidate_id:bridge.id,
      materialization_candidate_id:bridge.materializationCandidateId || null,
      matfile_id:file.id,
      materialization_item_id:bridge.materializationItemId,
      context:item.context || null,
      semantic_reference:item.semanticReference || item.term,
      visual_reference:matItem.visualReference || item.semanticReference || item.term,
      source:bridge.source || null,
      host:bridge.host || null,
      width:file.width,
      height:file.height,
      mime_type:file.mimeType,
      size_bytes:file.sizeBytes,
      technical_status:file.technicalStatus,
      status:bridge.status,
      signed_preview_url:urls.signed_preview_url,
      ...(includeOriginal ? { signed_original_url:urls.signed_original_url } : {}),
      ...(urls.signing_error ? { signing_error:urls.signing_error } : {}),
      metadata,
    };
  });
  return {
    project_id:projectId,
    project_version:project.stateVersion,
    total:candidates.length,
    mode:"LINKS_ONLY",
    canonical_source:"R2",
    candidates,
    backend_ms:Date.now() - startedAt,
  };
}

export async function getMaterializationQaLinks(batchIdInput: unknown, limitInput?: unknown) {
  const startedAt = Date.now(), batchId = clean(batchIdInput);
  if (!batchId) throw new Error("BATCH_ID_REQUIRED");
  const limit = Math.max(1, Math.min(50, Number(limitInput) || 20));
  const db = getDb();
  const items = await db.select().from(materializationItems).where(and(eq(materializationItems.batchId, batchId), eq(materializationItems.status, "READY_FOR_VISUAL_QA"))).limit(limit);
  const fileIds = items.map((row) => row.selectedFileId).filter((value): value is string => Boolean(value));
  const files = fileIds.length ? await db.select().from(materializationFiles).where(inArray(materializationFiles.id, fileIds)) : [];
  const fileMap = new Map(files.map((row) => [row.id, row]));
  const entries = items.flatMap((item) => { const file = item.selectedFileId ? fileMap.get(item.selectedFileId) : null; return file ? [{item,file}] : []; });
  const signed = await Promise.all(entries.map(({item,file}) => signPreview(file.r2Key,file.mimeType,item.targetName,true)));
  return { batch_id:batchId, mode:"LINKS_ONLY", total:entries.length, files:entries.map(({item,file},i) => ({ item_id:item.itemId, matfile_id:file.id, target_file:item.targetName, mime_type:file.mimeType, size_bytes:file.sizeBytes, width:file.width, height:file.height, technical_status:file.technicalStatus, signed_preview_url:signed[i].signed_preview_url, signed_original_url:signed[i].signed_original_url, ...(signed[i].signing_error ? { signing_error:signed[i].signing_error } : {}) })), backend_ms:Date.now()-startedAt };
}

export async function getPendingCatalogQaLinks(assetIdsInput?: unknown, limitInput?: unknown) {
  const startedAt = Date.now();
  const ids = list(assetIdsInput,50), limit=Math.max(1,Math.min(50,Number(limitInput)||20));
  const db=getDb(), conditions=[like(assets.status,"Pendente%")];
  if(ids.length) conditions.push(inArray(assets.id,ids));
  const rows=await db.select().from(assets).where(and(...conditions)).orderBy(desc(assets.updatedAt)).limit(limit);
  const mimeTypes=rows.map((asset)=>resolveMediaMime(asset.mimeType,asset.originalName,asset.r2Key));
  const signed=await Promise.all(rows.map((asset,i)=>signPreview(asset.r2Key,mimeTypes[i],asset.originalName,true)));
  return { mode:"LINKS_ONLY", total:rows.length, assets:rows.map((asset,i)=>({ asset_id:asset.id,name:asset.name,universe:asset.universe,status:asset.status,qa_status:asset.qaStatus,mime_type:mimeTypes[i],size_bytes:asset.sizeBytes,project_origin:asset.projectOrigin,script_reference:asset.scriptReference,visual_reference:asset.visualReference,signed_preview_url:signed[i].signed_preview_url,signed_original_url:signed[i].signed_original_url,...(signed[i].signing_error?{signing_error:signed[i].signing_error}:{}) })), backend_ms:Date.now()-startedAt };
}

export async function getWorkPacketLite(projectIdInput: unknown, limitInput?: unknown) {
  const startedAt=Date.now(), projectId=clean(projectIdInput), limit=Math.max(1,Math.min(50,Number(limitInput)||20));
  if(!projectId) throw new Error("PROJECT_ID_REQUIRED");
  const db=getDb();
  const [project]=await db.select().from(automaticProjects).where(eq(automaticProjects.id,projectId)).limit(1);
  if(!project) throw new Error("PROJECT_NOT_FOUND");
  const items=await db.select().from(automaticProjectItems).where(and(eq(automaticProjectItems.projectId,projectId),eq(automaticProjectItems.version,project.activeVersion),notInArray(automaticProjectItems.status,terminalStatuses))).orderBy(asc(automaticProjectItems.stageReadyAt),asc(automaticProjectItems.priority)).limit(limit);
  const ids=items.map((row)=>row.id);
  const bridges=ids.length?await db.select().from(supervisorProjectCandidates).where(and(inArray(supervisorProjectCandidates.itemId,ids),eq(supervisorProjectCandidates.status,"PARA_QA_VISUAL"))):[];
  const bridgeMap=new Map(bridges.map((row)=>[row.itemId,row]));
  const fileIds=[...new Set(bridges.map((row)=>row.materializationFileId))];
  const files=fileIds.length?await db.select().from(materializationFiles).where(inArray(materializationFiles.id,fileIds)):[];
  const fileMap=new Map(files.map((row)=>[row.id,row]));
  const signed=await Promise.all(items.map(async(item)=>{const bridge=bridgeMap.get(item.id),file=bridge?fileMap.get(bridge.materializationFileId):null; return bridge&&file?signPreview(file.r2Key,file.mimeType,item.targetFile||item.itemKey):{signed_preview_url:null,signed_original_url:null,signing_error:null};}));
  const counts={total:project.totalItems||0,approved:project.approvedCount||0,waiting_qa:project.waitingQaCount||0,relink:project.relinkCount||0,collecting:project.collectingCount||0,materializing:project.materializingCount||0,failed:project.failedCount||0,pending:project.pendingCount||0};
  const nextAction=counts.waiting_qa?"QA_VISUAL":counts.relink?"RELINK":counts.collecting?"COLETAR":counts.materializing?"MATERIALIZAR":counts.pending?"CONTINUAR":"GERAR_ZIP";
  return {project_id:projectId,project_version:project.stateVersion,status:project.status,counts,next_recommended_action:nextAction,items:items.map((item,i)=>{const bridge=bridgeMap.get(item.id);return{item_id:item.id,item_key:item.itemKey,target_file:item.targetFile||item.itemKey,status:item.status,semantic_reference:item.semanticReference||item.term,context:item.context||null,priority:item.priority,has_ready_candidate:Boolean(bridge),candidate_id:bridge?.id||null,matfile_id:bridge?.materializationFileId||null,preview_url:signed[i].signed_preview_url};}),backend_ms:Date.now()-startedAt};
}

export async function getOperationalSummaryShort(projectIdInput: unknown) {
  const startedAt=Date.now(),projectId=clean(projectIdInput); if(!projectId) throw new Error("PROJECT_ID_REQUIRED");
  const db=getDb();
  const [project,lastEvent,lastOperation]=await Promise.all([
    db.select().from(automaticProjects).where(eq(automaticProjects.id,projectId)).limit(1).then((rows)=>rows[0]),
    db.select().from(automaticProjectEvents).where(eq(automaticProjectEvents.projectId,projectId)).orderBy(desc(automaticProjectEvents.createdAt)).limit(1).then((rows)=>rows[0]),
    db.select().from(operationResults).where(eq(operationResults.projectId,projectId)).orderBy(desc(operationResults.updatedAt)).limit(1).then((rows)=>rows[0]),
  ]);
  if(!project) throw new Error("PROJECT_NOT_FOUND");
  const counts={total:project.totalItems||0,approved:project.approvedCount||0,waiting_qa:project.waitingQaCount||0,relink:project.relinkCount||0,collecting:project.collectingCount||0,failed:project.failedCount||0};
  const nextAction=counts.waiting_qa?"FAST_VISUAL_PACKET":counts.relink?"RELINK_ITENS_LOTE":counts.collecting?"AGUARDAR_COLETA":(project.pendingCount||0)>0?"CONTINUAR":"GERAR_ZIP";
  const operationWallMs=lastOperation?.createdAt&&lastOperation?.updatedAt?Math.max(0,lastOperation.updatedAt.getTime()-lastOperation.createdAt.getTime()):null;
  return {project_id:projectId,project_version:project.stateVersion,status:project.status,...counts,last_operation_ms:lastEvent?.durationMs??operationWallMs??null,last_operation_source:lastEvent?.durationMs!=null?"PROJECT_EVENT":operationWallMs!=null?"OPERATION_RECEIPT":null,last_operation_id:lastOperation?.operationId||null,next_recommended_action:nextAction,backend_ms:Date.now()-startedAt};
}

export async function exportQaPacketJson(input: PacketInput) {
  const packet=await getFastVisualPacket({...input,limit:Math.max(1,Math.min(50,Number(input.limit)||50)),include_original_url:true});
  const projectId=clean(input.project_id),candidates=(packet.candidates as Array<Record<string,unknown>>).map((candidate)=>({...candidate,preview_url:candidate.signed_preview_url,original_r2_url:candidate.signed_original_url}));
  const signature=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify({projectId,ids:candidates.map((row)=>row.candidate_id),version:packet.project_version})));
  const hash=Array.from(new Uint8Array(signature).subarray(0,12),(b)=>b.toString(16).padStart(2,"0")).join("");
  const key=`exports/qa-json/${safe(projectId)}/${hash}.json`;
  const payload={generated_at:new Date().toISOString(),project_id:projectId,project_version:packet.project_version,mode:"LINKS_ONLY",candidates};
  const bytes=new TextEncoder().encode(JSON.stringify(payload,null,2));
  await env.BUCKET.put(key,bytes,{httpMetadata:{contentType:"application/json"},customMetadata:{projectId,kind:"QA_LINKS_ONLY"}});
  let download_url:string|null=null,download_error:string|null=null;
  try{download_url=await createSignedR2GetUrl(key,60,`${safe(projectId)}-qa.json`,`application/json`);}catch(error){download_error=error instanceof Error?error.message:String(error);}
  return {project_id:projectId,total:packet.total,r2_key:key,size_bytes:bytes.byteLength,download_url,download_error,mode:"LINKS_ONLY",packet:payload};
}

function fillRect(raw:Uint8Array,width:number,x:number,y:number,w:number,h:number,r:number,g:number,b:number,a=255){
  const height=Math.floor(raw.length/(width*4));
  for(let yy=Math.max(0,y);yy<Math.min(height,y+h);yy++) for(let xx=Math.max(0,x);xx<Math.min(width,x+w);xx++){const i=(yy*width+xx)*4;raw[i]=r;raw[i+1]=g;raw[i+2]=b;raw[i+3]=a;}
}
function resizeNearest(raw:Uint8Array,width:number,height:number,targetW:number,targetH:number){const out=new Uint8Array(targetW*targetH*4);for(let y=0;y<targetH;y++){const sy=Math.min(height-1,Math.floor(y*height/targetH));for(let x=0;x<targetW;x++){const sx=Math.min(width-1,Math.floor(x*width/targetW));const s=(sy*width+sx)*4,t=(y*targetW+x)*4;out[t]=raw[s];out[t+1]=raw[s+1];out[t+2]=raw[s+2];out[t+3]=raw[s+3];}}return out;}
const DIGITS:Record<string,string[]>={"0":["111","101","101","101","111"],"1":["010","110","010","010","111"],"2":["111","001","111","100","111"],"3":["111","001","111","001","111"],"4":["101","101","111","001","001"],"5":["111","100","111","001","111"],"6":["111","100","111","101","111"],"7":["111","001","001","001","001"],"8":["111","101","111","101","111"],"9":["111","101","111","001","111"]};
function drawIndex(raw:Uint8Array,width:number,x:number,y:number,value:number){const text=String(value),scale=4;fillRect(raw,width,x-4,y-4,text.length*16+8,28,255,255,255,230);[...text].forEach((ch,di)=>{(DIGITS[ch]||[]).forEach((line,ry)=>[...line].forEach((pixel,rx)=>{if(pixel==="1")fillRect(raw,width,x+di*16+rx*scale,y+ry*scale,scale,scale,0,0,0,255);}));});}

export async function generateCandidateContactSheet(input: PacketInput & { columns?:unknown }) {
  const projectId=clean(input.project_id),limit=Math.max(1,Math.min(20,Number(input.limit)||20)),columns=Math.max(2,Math.min(5,Number(input.columns)||4));
  const packet=await getFastVisualPacket({...input,limit,include_original_url:false});
  const candidates=packet.candidates as Array<Record<string,unknown>>;
  if(!candidates.length) return {project_id:projectId,total:0,grid_url:null,mapping:[],mode:"LINKS_ONLY"};
  const cellW=320,cellH=180,gap=8,rows=Math.ceil(candidates.length/columns),canvasW=columns*cellW+(columns+1)*gap,canvasH=rows*cellH+(rows+1)*gap;
  const canvas=new Uint8Array(canvasW*canvasH*4); fillRect(canvas,canvasW,0,0,canvasW,canvasH,238,238,238,255);
  const mapping:Array<Record<string,unknown>>=[];
  for(let index=0;index<candidates.length;index++){
    const candidate=candidates[index],fileId=clean(candidate.matfile_id); const [file]=fileId?await getDb().select().from(materializationFiles).where(eq(materializationFiles.id,fileId)).limit(1):[];
    const col=index%columns,row=Math.floor(index/columns),x=gap+col*cellW,y=gap+row*cellH; fillRect(canvas,canvasW,x,y,cellW,cellH,210,210,210,255);
    let decoded=false,error:string|null=null;
    if(file){try{const object=await env.BUCKET.get(file.r2Key);if(!object)throw new Error("R2_SOURCE_NOT_FOUND");const bytes=new Uint8Array(await object.arrayBuffer());const resized=await sharp(bytes,{failOn:"error"}).ensureAlpha().resize(cellW,cellH,{fit:"inside",withoutEnlargement:false}).raw().toBuffer({resolveWithObject:true});const tw=resized.info.width,th=resized.info.height,ox=x+Math.floor((cellW-tw)/2),oy=y+Math.floor((cellH-th)/2),raw=new Uint8Array(resized.data);for(let yy=0;yy<th;yy++){const target=((oy+yy)*canvasW+ox)*4;canvas.set(raw.subarray(yy*tw*4,(yy+1)*tw*4),target);}decoded=true;}catch(err){error=err instanceof Error?err.message:String(err);}}
    drawIndex(canvas,canvasW,x+8,y+8,index+1);
    mapping.push({position:index+1,row:row+1,column:col+1,candidate_id:candidate.candidate_id,item_id:candidate.item_id,target_file:candidate.target_file,decoded,...(error?{decode_error:error}:{})});
  }
  const png=new Uint8Array(await sharp(canvas,{raw:{width:canvasW,height:canvasH,channels:4}}).png().toBuffer());
  const signature=(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(candidates.map((row)=>row.candidate_id).join("|"))));const hash=Array.from(new Uint8Array(signature).subarray(0,10),(b)=>b.toString(16).padStart(2,"0")).join("");
  const key=`qa-grids/${safe(projectId)}/${hash}.png`;await env.BUCKET.put(key,png,{httpMetadata:{contentType:"image/png"},customMetadata:{projectId,kind:"QA_CONTACT_SHEET",count:String(candidates.length)}});
  let grid_url:string|null=null,signing_error:string|null=null;try{grid_url=await createSignedR2GetUrl(key,30,undefined,"image/png");}catch(error){signing_error=error instanceof Error?error.message:String(error);}
  return {project_id:projectId,total:candidates.length,columns,rows,width:canvasW,height:canvasH,r2_key:key,grid_url,signing_error,mapping,mode:"LINKS_ONLY",rule:"row-major positions; no MCP file resource"};
}
