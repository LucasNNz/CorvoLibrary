import { createHash } from "node:crypto";
import { getLibsqlClient } from "./platform/runtime";

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

function fingerprint(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "";
  const ip = forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
  return createHash("sha256").update(`corvo-login:${ip}`).digest("hex");
}

export async function assertLoginAllowed(request: Request) {
  const result = await getLibsqlClient().execute({ sql:"SELECT blocked_until FROM auth_rate_limits WHERE fingerprint=?", args:[fingerprint(request)] });
  const blockedUntil = Number(result.rows[0]?.blocked_until || 0);
  if (blockedUntil > Date.now()) throw new Error(`LOGIN_RATE_LIMITED:${Math.ceil((blockedUntil - Date.now()) / 1000)}`);
}

export async function recordLoginFailure(request: Request) {
  const now = Date.now(), cutoff = now - WINDOW_MS, key = fingerprint(request);
  await getLibsqlClient().execute({
    sql:`INSERT INTO auth_rate_limits(fingerprint,attempts,window_started_at,blocked_until,updated_at)
         VALUES(?,1,?,0,?)
         ON CONFLICT(fingerprint) DO UPDATE SET
           attempts=CASE WHEN auth_rate_limits.window_started_at < ? THEN 1 ELSE auth_rate_limits.attempts+1 END,
           window_started_at=CASE WHEN auth_rate_limits.window_started_at < ? THEN ? ELSE auth_rate_limits.window_started_at END,
           blocked_until=CASE
             WHEN (CASE WHEN auth_rate_limits.window_started_at < ? THEN 1 ELSE auth_rate_limits.attempts+1 END) >= ? THEN ?
             ELSE auth_rate_limits.blocked_until END,
           updated_at=?`,
    args:[key,now,now,cutoff,cutoff,now,cutoff,MAX_ATTEMPTS,now+WINDOW_MS,now],
  });
}

export async function clearLoginFailures(request: Request) {
  await getLibsqlClient().execute({ sql:"DELETE FROM auth_rate_limits WHERE fingerprint=?", args:[fingerprint(request)] });
}
