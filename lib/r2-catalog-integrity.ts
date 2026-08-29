import { getLibsqlClient, env } from "./platform/runtime";

const MARKER_KEY = "r2_catalog_integrity_v1";
const TTL_MS = 15 * 60 * 1000;
let inFlight: Promise<R2CatalogIntegrity> | null = null;

export type R2CatalogIntegrity = {
  version:1;
  checkedAt:string;
  expectedUniqueKeys:number;
  presentUniqueKeys:number;
  missingUniqueKeys:number;
  coveragePercent:number;
  missing:Array<{assetId:string;r2Key:string}>;
};

async function readFreshMarker() {
  const result=await getLibsqlClient().execute({sql:"SELECT value,updated_at FROM settings WHERE key=? LIMIT 1",args:[MARKER_KEY]});
  const value=String(result.rows[0]?.value||"");
  const updatedAt=Number(result.rows[0]?.updated_at||0);
  if(!value||!updatedAt||Date.now()-updatedAt>TTL_MS)return null;
  try{return JSON.parse(value) as R2CatalogIntegrity;}catch{return null;}
}

async function runIntegrity():Promise<R2CatalogIntegrity>{
  const fresh=await readFreshMarker();
  if(fresh)return fresh;
  const result=await getLibsqlClient().execute("SELECT id,r2_key FROM assets WHERE r2_key IS NOT NULL AND r2_key <> ''");
  const refs=result.rows.map((row)=>({assetId:String(row.id),r2Key:String(row.r2_key)}));
  const expected=new Map<string,string>();
  for(const ref of refs)if(!expected.has(ref.r2Key))expected.set(ref.r2Key,ref.assetId);

  const present=new Set<string>();
  let cursor:string|undefined;
  do{
    const page=await env.BUCKET.list({prefix:"assets/",limit:1000,cursor});
    for(const object of page.objects)if(object.key)present.add(object.key);
    cursor=page.truncated?page.cursor:undefined;
  }while(cursor);

  const missing=[...expected.entries()].filter(([key])=>!present.has(key)).map(([r2Key,assetId])=>({assetId,r2Key}));
  const expectedUniqueKeys=expected.size;
  const presentUniqueKeys=expectedUniqueKeys-missing.length;
  const value:R2CatalogIntegrity={
    version:1,
    checkedAt:new Date().toISOString(),
    expectedUniqueKeys,
    presentUniqueKeys,
    missingUniqueKeys:missing.length,
    coveragePercent:expectedUniqueKeys?Math.round((presentUniqueKeys/expectedUniqueKeys)*10000)/100:100,
    missing,
  };
  await getLibsqlClient().execute({
    sql:"INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
    args:[MARKER_KEY,JSON.stringify(value),Date.now()],
  });
  return value;
}

export function reconcileR2CatalogIntegrity(){
  if(!inFlight){const task=runIntegrity().finally(()=>{if(inFlight===task)inFlight=null;});inFlight=task;}
  return inFlight;
}
