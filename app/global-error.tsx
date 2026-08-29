"use client";

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <html lang="pt-BR"><body><main style={{minHeight:"100vh",display:"grid",placeItems:"center",background:"#080b12",color:"#f5f7fb",fontFamily:"system-ui"}}><section style={{maxWidth:520,padding:32}}><h1>Corvo Library temporariamente indisponível</h1><p>A conexão com os serviços persistentes falhou. Nenhum dado foi apagado.</p><button onClick={reset} style={{padding:"12px 18px",borderRadius:8}}>Tentar novamente</button></section></main></body></html>;
}
