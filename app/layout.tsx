import type { Metadata } from "next";
import "./globals.css";

const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL || "localhost:3000";
const appUrl = new URL(host.startsWith("http") ? host : `https://${host}`);

export const metadata: Metadata = {
  metadataBase: appUrl,
  title: "Corvo Library",
  description: "Biblioteca visual inteligente para organizar, reutilizar e entregar assets do Corvo Quiz.",
  openGraph: {
    title: "Corvo Library",
    description: "Seu patrimônio visual, organizado e pronto para reutilizar.",
    type: "website",
    url: "/",
    images: [{ url: "/og.png", width: 1664, height: 919, alt: "Acervo visual do Corvo Library" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Corvo Library",
    description: "Seu patrimônio visual, organizado e pronto para reutilizar.",
    images: ["/og.png"],
  },
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="pt-BR"><body>{children}</body></html>;
}
