// セッション認証（署名Cookie）。組織=Google（本番・P6）／個人=LINE/Discord/local（devはlocal）。
// 署名は MASTER_KEY 由来のHMAC。Cookie=base64url(payload).hmac。
import { masterKey } from "./client.ts";
import type { Role } from "@baku-office/shared";

export type Ctx = "org" | "personal";
export type Session = { uid: string; role: Role; ctx: Ctx; name?: string; exp: number };

const COOKIE = "bo_session";
const ENC = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlToBytes = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmacKey(env: Env): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(await masterKey(env)), (c) => c.charCodeAt(0)); // MASTER_KEYは標準base64
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function makeSessionCookie(env: Env, s: Session): Promise<string> {
  const payload = b64url(ENC.encode(JSON.stringify(s)));
  const sig = b64url(await crypto.subtle.sign("HMAC", await hmacKey(env), ENC.encode(payload)));
  const value = `${payload}.${sig}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}
export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function getSession(env: Env, request: Request): Promise<Session | null> {
  const cookie = request.headers.get("cookie") ?? "";
  const m = new RegExp(`${COOKIE}=([^;]+)`).exec(cookie);
  if (!m) return null;
  const [payload, sig] = m[1].split(".");
  if (!payload || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), b64urlToBytes(sig), ENC.encode(payload));
  if (!ok) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as Session;
    if (s.exp < Math.floor(Date.now() / 1000)) return null;
    return s;
  } catch {
    return null;
  }
}

// ロール→アクセス可能セクション（設計書§6.4の既定）。
export function canAccess(role: Role, section: "accounting" | "documents" | "members" | "billing" | "review_accounting" | "review_documents"): boolean {
  if (role === "admin") return true;
  switch (section) {
    case "accounting": return role === "accounting";
    case "review_accounting": return role === "accounting";
    case "documents": return role === "clerical";
    case "review_documents": return role === "clerical";
    case "members": return false;
    case "billing": return false;
    default: return false;
  }
}

export const SESSION_DAYS = 7;
export const sessionExp = () => Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
