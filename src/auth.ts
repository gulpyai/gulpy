import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { otpCode, randomId, randomToken, safeEqual, sha256 } from "./crypto.ts";
import type { Deps } from "./deps.ts";
import { isEmailAddress } from "./providers/mime.ts";
import type { User } from "./store.ts";

const SESSION_COOKIE = "gulpy_session";
const SIGNIN_COOKIE = "gulpy_signin";
const SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const SHORT_SESSION_TTL_MS = 24 * 60 * 60_000;
const OTP_TTL_MS = 10 * 60_000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_MAX_PER_WINDOW = 5;

export interface Viewer {
  user: User;
  /** Hidden field value that each form must send back. */
  csrf: string;
}

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return isEmailAddress(email) ? email : null;
}

/**
 * Accepts only a path on this site. Blocks an open redirect through values
 * such as `//evil.example` or `/\evil.example`.
 */
export function safeNext(value: string | undefined | null, fallback = "/"): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;
  return /[\x00-\x1f]/.test(value) ? fallback : value;
}

export function viewer(deps: Deps, c: Context): Viewer | null {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (!cookie) return null;
  const session = deps.store.session(sha256(cookie), deps.now());
  if (!session) return null;
  const user = deps.store.userById(session.userId);
  return user ? { user, csrf: session.csrf } : null;
}

export function checkCsrf(current: Viewer, sent: unknown): boolean {
  return typeof sent === "string" && safeEqual(sent, current.csrf);
}

/**
 * With `remember`, the cookie stays for 30 days: the person asked for it. Without
 * it, the cookie ends when the browser closes, and the session ends after 1 day.
 * A cookie that stays is exempt from consent in the EU only when the person asks for it.
 */
export function startSession(deps: Deps, c: Context, userId: string, remember = false): void {
  const id = randomToken("sess");
  const now = deps.now();
  const ttl = remember ? SESSION_TTL_MS : SHORT_SESSION_TTL_MS;
  deps.store.createSession(sha256(id), userId, randomToken("csrf"), now, now + ttl);
  setCookie(c, SESSION_COOKIE, id, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: deps.config.baseUrl.startsWith("https://"),
    ...(remember ? { maxAge: SESSION_TTL_MS / 1000 } : {}),
  });
}

export function endSession(deps: Deps, c: Context): void {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) deps.store.deleteSession(sha256(cookie));
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export type CodeRequest = { ok: true; otpId: string } | { ok: false; reason: "rate_limited" };

/**
 * Sends a sign-in code. The code works only in the browser that asked for it:
 * a cookie binds the two. This stops an attacker who makes the browser of a
 * different person complete the sign-in of the attacker (login CSRF).
 */
export async function requestCode(deps: Deps, c: Context, email: string): Promise<CodeRequest> {
  const now = deps.now();
  if (deps.store.countRecentOtps(email, now - OTP_TTL_MS) >= OTP_MAX_PER_WINDOW) {
    return { ok: false, reason: "rate_limited" };
  }
  const otpId = randomId("otp");
  const code = otpCode();
  const binding = getCookie(c, SIGNIN_COOKIE) ?? randomToken("signin");
  setCookie(c, SIGNIN_COOKIE, binding, {
    path: "/auth",
    httpOnly: true,
    sameSite: "Lax",
    secure: deps.config.baseUrl.startsWith("https://"),
    maxAge: OTP_TTL_MS / 1000,
  });
  deps.store.createOtp(
    // The id is part of the hash, so the same code in two requests gives two different hashes.
    { id: otpId, email, codeHash: sha256(`${otpId}:${code}`), bindingHash: sha256(binding) },
    now,
    now + OTP_TTL_MS,
  );
  await deps.mailer.sendCode(email, code);
  return { ok: true, otpId };
}

export type CodeCheck = { ok: true; user: User } | { ok: false; reason: "wrong" | "expired" };

export function verifyCode(deps: Deps, c: Context, otpId: string, code: string): CodeCheck {
  const now = deps.now();
  const otp = deps.store.otp(otpId);
  if (!otp || otp.usedAt !== null || otp.expiresAt <= now || otp.attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, reason: "expired" };
  }
  if (!safeEqual(sha256(getCookie(c, SIGNIN_COOKIE) ?? ""), otp.bindingHash)) {
    return { ok: false, reason: "expired" };
  }
  deps.store.addOtpAttempt(otpId);
  if (!safeEqual(sha256(`${otpId}:${code.trim()}`), otp.codeHash)) {
    return { ok: false, reason: otp.attempts + 1 >= OTP_MAX_ATTEMPTS ? "expired" : "wrong" };
  }
  if (!deps.store.useOtp(otpId, now)) return { ok: false, reason: "expired" };
  deleteCookie(c, SIGNIN_COOKIE, { path: "/auth" });
  const user = deps.store.userByEmail(otp.email) ?? deps.store.createUser(randomId("usr"), otp.email, now);
  return { ok: true, user };
}
