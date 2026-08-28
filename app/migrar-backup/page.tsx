"use client";
import { useEffect, useState } from "react";

type Preflight={ready?:boolean;assets?:number;assetUsage?:number;schemaTables?:number;expectedSchemaTables?:number;error?:string};

export default function MigrarBackupPage(){
  const [file,setFile]=useState<File|null>(null);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState("");
  const [preflight,setPreflight]=useState<Preflight|null>(null);
  useEffect(()=>{fetch("/api/migration/production-recovery",{cache:"no-store"}).then(r=>r.json()).then(setPreflight).catch(()=>setPreflight({error:"Falha ao consultar o Turso."}));},[]);
  async function run(){
    if(!file)return;
    setBusy(true);setMessage("Lendo pacote de recuperação…");
    try{
      const text=await file.text();
      const payload=JSON.parse(text);
      setMessage("Mesclando acervo e estado útil no Turso…");
      const response=await fetch("/api/migration/production-recovery",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||`HTTP ${response.status}`);
      setMessage(`Concluído: ${Number(result.matchedAssets||0).toLocaleString("pt-BR")} assets, ${Number(result.matchedUsage||0).toLocaleString("pt-BR")} usos e ${Number(result.schemaTables||0)} tabelas no schema atual. Extras já existentes foram preservados.`);
      const next=await fetch("/api/migration/production-recovery",{cache:"no-store"}).then(r=>r.json());setPreflight(next);
    }catch(error){setMessage(`Erro: ${error instanceof Error?error.message:String(error)}`);}finally{setBusy(false);}
  }
  return <main style={{minHeight:"100vh",background:"#081321",color:"#eaf2ff",padding:"48px 20px",fontFamily:"Arial, sans-serif"}}>
    <section style={{maxWidth:760,margin:"0 auto",background:"#0e1d30",border:"1px solid #29405d",borderRadius:18,padding:28}}>
      <small style={{color:"#78aef7",letterSpacing:1.2}}>CORVO LIBRARY · FIX13</small>
      <h1 style={{fontSize:30,margin:"10px 0"}}>Restaurar base de produção</h1>
      <p style={{color:"#a9bdd8",lineHeight:1.55}}>Importação não destrutiva do snapshot sanitizado. Preserva login, sessão, chave mestra e credenciais R2 atuais. Restaura acervo, histórico de uso e configurações operacionais úteis; filas, leases, logs e telemetria de teste permanecem somente no backup completo.</p>
      <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:10,margin:"22px 0"}}>
        <div style={{background:"#0a1727",padding:14,borderRadius:10}}><small>ASSETS ATUAIS</small><b style={{display:"block",fontSize:22}}>{preflight?.assets??"—"}</b></div>
        <div style={{background:"#0a1727",padding:14,borderRadius:10}}><small>USOS ATUAIS</small><b style={{display:"block",fontSize:22}}>{preflight?.assetUsage??"—"}</b></div>
        <div style={{background:"#0a1727",padding:14,borderRadius:10}}><small>SCHEMA</small><b style={{display:"block",fontSize:22}}>{preflight?.schemaTables??"—"}/{preflight?.expectedSchemaTables??53}</b></div>
      </div>
      <label style={{display:"block",margin:"20px 0 8px",fontSize:13}}>PACOTE JSON DE PRODUÇÃO</label>
      <input type="file" accept="application/json,.json" disabled={busy} onChange={e=>setFile(e.target.files?.[0]||null)} style={{width:"100%",padding:14,background:"#081321",color:"#dceaff",border:"1px solid #365170",borderRadius:10}}/>
      {file&&<p style={{color:"#9db6d6",fontSize:13}}>Selecionado: <b>{file.name}</b> · {(file.size/1024/1024).toFixed(2)} MB</p>}
      <button disabled={busy||!file} onClick={()=>void run()} style={{marginTop:14,width:"100%",padding:14,border:0,borderRadius:10,background:busy||!file?"#3b4b61":"#2878e8",color:"white",fontWeight:700,cursor:busy?"wait":"pointer"}}>{busy?"Importando…":"Mesclar backup e validar"}</button>
      {message&&<div style={{marginTop:18,padding:14,borderRadius:10,background:"#081321",whiteSpace:"pre-wrap"}}>{message}</div>}
      <p style={{fontSize:12,color:"#7f98b8",marginTop:20}}>Esta rotina nunca apaga registros existentes. Credenciais e chaves do backup antigo são ignoradas por design.</p>
    </section>
  </main>;
}
