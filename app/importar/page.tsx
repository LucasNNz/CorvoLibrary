"use client";

import { useEffect, useRef, useState } from "react";
import type { ChangeEvent, DragEvent } from "react";

type UploadState = "idle" | "sending" | "done" | "error";

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function ImportarPage() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [state, setState] = useState<UploadState>("idle");
  const [message, setMessage] = useState("");
  const [code, setCode] = useState<string | null>(null);

  useEffect(() => {
    const handle = window.setTimeout(() => setCode(new URLSearchParams(window.location.search).get("code") ?? ""), 0);
    return () => window.clearTimeout(handle);
  }, []);

  function chooseFile(next?: File) {
    if (!next) return;
    if (!next.name.toLowerCase().endsWith(".zip")) {
      setFile(null);
      setState("error");
      setMessage("Selecione um arquivo com extensão .zip.");
      return;
    }
    setFile(next);
    setState("idle");
    setMessage("");
  }

  async function upload() {
    if (!file || !code) return;
    setState("sending");
    setMessage("Enviando ao R2 e processando o conteúdo...");
    const body = new FormData();
    body.append("file", file);
    try {
      const response = await fetch(`/api/import?code=${encodeURIComponent(code)}`, { method: "POST", body });
      const payload = await response.json() as { error?: string; import?: { id: string }; processing?: { assets_catalogados: number; usos_iniciais_registrados: number } };
      if (!response.ok) throw new Error(payload.error || "Falha no envio.");
      setState("done");
      setMessage(`Importação ${payload.import?.id ?? "registrada"}: ${payload.processing?.assets_catalogados ?? 0} assets catalogados e ${payload.processing?.usos_iniciais_registrados ?? 0} usos iniciais registrados.`);
    } catch (error) {
      setState("error");
      setMessage(error instanceof Error ? error.message : "Não foi possível enviar o ZIP.");
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    chooseFile(event.dataTransfer.files[0]);
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    chooseFile(event.target.files?.[0]);
  }

  return <main className="direct-upload-shell">
    <section className="direct-upload-card">
      <header><div className="direct-upload-mark">C</div><div><span>CORVO LIBRARY</span><h1>Enviar ZIP para a biblioteca</h1></div></header>
      {code === null ? <div className="direct-upload-alert"><strong>Validando link</strong><p>Preparando o envio seguro...</p></div> : !code ? <div className="direct-upload-alert error"><strong>Link inválido</strong><p>Peça à IA para gerar um novo link com a ferramenta “Preparar upload de ZIP”.</p></div> : <>
        <div className="direct-upload-note"><strong>Sem URL pública</strong><p>O arquivo sai deste dispositivo e vai diretamente para o armazenamento R2 da biblioteca.</p></div>
        <div className={`direct-drop ${file ? "has-file" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
          <div className="direct-drop-icon">⇧</div>
          {file ? <><h2>{file.name}</h2><p>{formatBytes(file.size)} · pronto para enviar</p></> : <><h2>Selecione ou arraste o ZIP</h2><p>Inclua o IMPORTACAO.txt e imagens, GIFs ou vídeos MP4, WebM, MOV e M4V.</p></>}
          <button className="secondary" onClick={() => inputRef.current?.click()} disabled={state === "sending"}>{file ? "Trocar arquivo" : "Escolher ZIP"}</button>
          <input ref={inputRef} className="visually-hidden" type="file" accept=".zip,application/zip" onChange={onChange}/>
        </div>
        {message && <div className={`direct-upload-alert ${state}`} role="status"><strong>{state === "done" ? "Envio concluído" : state === "error" ? "Não foi possível concluir" : "Processando"}</strong><p>{message}</p></div>}
        <button className="primary direct-upload-submit" onClick={upload} disabled={!file || state === "sending" || state === "done"}>{state === "sending" ? "Enviando..." : state === "done" ? "ZIP recebido" : "Enviar para a Corvo Library"}</button>
      </>}
      <footer>Este link acompanha o código MCP atual. Ao renovar a conexão, o link anterior deixa de funcionar.</footer>
    </section>
  </main>;
}
