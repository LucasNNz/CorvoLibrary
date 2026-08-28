import { timingSafeEqual, randomBytes, createHash } from "node:crypto";
import { eq, like } from "drizzle-orm";
import { getDb } from "../db";
import { settings } from "../db/schema";
import { ensureBootstrapSettingsTable } from "./bootstrap-db";
import { ensureLibraryMasterKey, rewrapLibraryMasterKeyForPassword } from "./master-key";

const AUTH_KEY = "library_auth_v1";
const SESSION_PREFIX = "library_auth_session:";
const COOKIE = "corvo_library_session";
const PASSWORD_ITERATIONS = 210_000;

type AuthRecord = { version:1; username:string; salt:string; passwordHash:string; iterations:number; updatedAt:string };
type SessionRecord = { username:string; createdAt:number; expiresAt:number; remember:boolean };

function b64(bytes: Uint8Array) { return Buffer.from(bytes).toString("base64"); }
function unb64(value: string) { return Uint8Array.from(Buffer.from(value, "base64")); }

async function derivePassword(password: string, salt: Uint8Array, iterations = PASSWORD_ITERATIONS) {
  const raw = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name:"PBKDF2", salt, iterations, hash:"SHA-256" }, raw, 256));
}

function normalizeUsername(value: string) {
  const username = value.trim().replace(/\s+/g, " ");
  if (username.length < 2 || username.length > 64) throw new Error("USERNAME_INVALID");
  return username;
}

function validatePassword(password: string) {
  if (password.length < 4 || password.length > 128) throw new Error("PASSWORD_INVALID");
}

async function getAuth(): Promise<AuthRecord | null> {
  await ensureBootstrapSettingsTable();
  const [row] = await getDb().select().from(settings).where(eq(settings.key, AUTH_KEY)).limit(1);
  if (!row?.value) return null;
  try { return JSON.parse(row.value) as AuthRecord; } catch { throw new Error("AUTH_RECORD_INVALID"); }
}

async function saveAuth(username: string, password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt);
  const now = new Date();
  const value: AuthRecord = { version:1, username, salt:b64(salt), passwordHash:b64(hash), iterations:PASSWORD_ITERATIONS, updatedAt:now.toISOString() };
  await getDb().insert(settings).values({ key:AUTH_KEY, value:JSON.stringify(value), updatedAt:now })
    .onConflictDoUpdate({ target:settings.key, set:{ value:JSON.stringify(value), updatedAt:now } });
  return value;
}

async function verifyPassword(record: AuthRecord, password: string) {
  const expected = Buffer.from(unb64(record.passwordHash));
  const actual = Buffer.from(await derivePassword(password, unb64(record.salt), record.iterations || PASSWORD_ITERATIONS));
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sessionHash(token: string) { return createHash("sha256").update(token).digest("hex"); }
function readCookie(request: Request, name: string) {
  const cookies = request.headers.get("cookie") || "";
  for (const chunk of cookies.split(";")) {
    const [key, ...rest] = chunk.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}

function cookieHeader(token: string, remember: boolean) {
  const parts = [`${COOKIE}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (process.env.NODE_ENV === "production") parts.push("Secure");
  if (remember) parts.push(`Max-Age=${60 * 60 * 24 * 180}`);
  return parts.join("; ");
}

export function clearSessionCookieHeader() { return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax;${process.env.NODE_ENV === "production" ? " Secure;" : ""} Max-Age=0`; }

async function createSession(username: string, remember: boolean) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + (remember ? 180 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000);
  const key = SESSION_PREFIX + sessionHash(token);
  const value: SessionRecord = { username, createdAt:now, expiresAt, remember };
  await getDb().insert(settings).values({ key, value:JSON.stringify(value), updatedAt:new Date(now) })
    .onConflictDoUpdate({ target:settings.key, set:{ value:JSON.stringify(value), updatedAt:new Date(now) } });
  return { token, cookie:cookieHeader(token, remember), expiresAt };
}

async function clearAllSessions() {
  await getDb().delete(settings).where(like(settings.key, `${SESSION_PREFIX}%`));
}

export async function setupLibraryAuth(usernameRaw: string, password: string, remember = true) {
  if (await getAuth()) throw new Error("AUTH_ALREADY_CONFIGURED");
  const username = normalizeUsername(usernameRaw); validatePassword(password);
  await saveAuth(username, password);
  await ensureLibraryMasterKey(password);
  await clearAllSessions();
  const session = await createSession(username, remember);
  return { configured:true, authenticated:true, username, ...session };
}

export async function loginLibrary(usernameRaw: string, password: string, remember = true) {
  const record = await getAuth();
  if (!record) throw new Error("AUTH_NOT_CONFIGURED");
  const username = normalizeUsername(usernameRaw);
  if (username.toLocaleLowerCase("pt-BR") !== record.username.toLocaleLowerCase("pt-BR") || !(await verifyPassword(record, password))) throw new Error("INVALID_LOGIN");
  // Also heals the master-key wrapper automatically after a Turso token rotation.
  await ensureLibraryMasterKey(password);
  const session = await createSession(record.username, remember);
  return { configured:true, authenticated:true, username:record.username, ...session };
}

export async function getLibrarySession(request: Request) {
  const auth = await getAuth();
  if (!auth) return { configured:false, authenticated:false, username:"" };
  const token = readCookie(request, COOKIE);
  if (!token) return { configured:true, authenticated:false, username:auth.username };
  const [row] = await getDb().select().from(settings).where(eq(settings.key, SESSION_PREFIX + sessionHash(token))).limit(1);
  if (!row?.value) return { configured:true, authenticated:false, username:auth.username };
  try {
    const session = JSON.parse(row.value) as SessionRecord;
    if (session.expiresAt <= Date.now()) {
      await getDb().delete(settings).where(eq(settings.key, SESSION_PREFIX + sessionHash(token))).catch(() => undefined);
      return { configured:true, authenticated:false, username:auth.username };
    }
    return { configured:true, authenticated:true, username:session.username, remember:session.remember };
  } catch {
    return { configured:true, authenticated:false, username:auth.username };
  }
}

export async function logoutLibrary(request: Request) {
  const token = readCookie(request, COOKIE);
  if (token) await getDb().delete(settings).where(eq(settings.key, SESSION_PREFIX + sessionHash(token))).catch(() => undefined);
}

export async function changeLibraryCredentials(request: Request, currentPassword: string, usernameRaw: string, newPassword: string, remember = true) {
  const session = await getLibrarySession(request);
  if (!session.authenticated) throw new Error("UNAUTHORIZED");
  const current = await getAuth();
  if (!current || !(await verifyPassword(current, currentPassword))) throw new Error("CURRENT_PASSWORD_INVALID");
  const username = normalizeUsername(usernameRaw); validatePassword(newPassword);
  await rewrapLibraryMasterKeyForPassword(currentPassword, newPassword);
  await saveAuth(username, newPassword);
  await clearAllSessions();
  const nextSession = await createSession(username, remember);
  return { configured:true, authenticated:true, username, ...nextSession };
}
