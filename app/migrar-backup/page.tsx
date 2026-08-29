export default function MigrarBackupPage(){
  return <main style={{minHeight:"100vh",background:"#081321",color:"#eaf2ff",padding:"48px 20px",fontFamily:"Arial, sans-serif"}}>
    <section style={{maxWidth:760,margin:"0 auto",background:"#0e1d30",border:"1px solid #29405d",borderRadius:18,padding:28}}>
      <small style={{color:"#78aef7",letterSpacing:1.2}}>CORVO LIBRARY · MIGRAÇÃO DEFINITIVA</small>
      <h1 style={{fontSize:30,margin:"10px 0"}}>Migração integral antes do deploy</h1>
      <p style={{color:"#a9bdd8",lineHeight:1.55}}>A importação parcial pelo navegador foi desativada. O pacote definitivo inclui o dump completo do Sites e um migrador retomável que valida as 47 tabelas e os 39.294 registros diretamente no Turso.</p>
      <div style={{marginTop:22,padding:16,borderRadius:10,background:"#081321",lineHeight:1.65}}>
        Execute uma única vez: <code>npm run db:migrate:vercel</code><br/>
        Depois valide: <code>npm run db:verify:vercel</code>
      </div>
      <p style={{fontSize:12,color:"#7f98b8",marginTop:20}}>Esta página não altera banco nem R2. As instruções completas estão em DEPLOY_VERCEL_DEFINITIVO.md.</p>
    </section>
  </main>;
}
