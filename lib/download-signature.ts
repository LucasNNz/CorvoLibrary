import { createHmac, timingSafeEqual } from "node:crypto";

function signingSecret() {
  const value = process.env.DOWNLOAD_SIGNING_SECRET?.trim() || process.env.TURSO_AUTH_TOKEN?.trim() || "";
  if (value.length < 20) throw new Error("DOWNLOAD_SIGNING_SECRET_REQUIRED");
  return value;
}

function canonical(url: URL) {
  const entries = [...url.searchParams.entries()]
    .filter(([key]) => key !== "sig")
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
  const query = new URLSearchParams(entries).toString();
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

function signature(url: URL) {
  return createHmac("sha256", signingSecret()).update(canonical(url)).digest("base64url");
}

export function signedDownloadUrl(origin: string, path: string, expiresAt: number) {
  const url = new URL(path, origin);
  url.searchParams.set("exp", String(expiresAt));
  url.searchParams.set("sig", signature(url));
  return url.toString();
}

export function validDownloadSignature(request: Request) {
  try {
    const url = new URL(request.url);
    const expires = Number(url.searchParams.get("exp"));
    if (!Number.isFinite(expires) || expires < Date.now() || expires > Date.now() + 24 * 60 * 60_000) return false;
    const supplied = Buffer.from(url.searchParams.get("sig") || "", "base64url");
    const expected = Buffer.from(signature(url), "base64url");
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}
