"use client";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="auth-shell"><section className="auth-card"><span>CORVO LIBRARY</span><h1>Não foi possível carregar esta área</h1><p>{error.message || "O serviço encontrou uma falha temporária."}</p><button className="primary auth-submit" onClick={reset}>Tentar novamente</button></section></main>;
}
