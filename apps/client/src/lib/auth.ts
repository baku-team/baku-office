import { kvPut } from "./kv.ts";
// セッション認証（署名Cookie）。組織=Google（本番・P6）／個人=LINE/Discord/local（devはlocal）。
// 署名は MASTER_KEY 由来のHMAC。Cookie=base64url(payload).hmac。
import { masterKey } from "./client.ts";
import type { Role } from "@baku-office/shared";

export type Ctx = "org" | "personal";
// iat=発行時刻（失効判定用・§3-3）。旧Cookie互換のため optional（無ければ失効チェックをスキップ＝7日で自然失効）。
export type Session = { uid: string; role: Role; ctx: Ctx; name?: string; exp: number; iat?: number };

const COOKIE = "bo_session";
const ENC = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64urlToBytes = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

// セッション/一時Cookie 署名用 HMAC 鍵。MASTER_KEY を生のまま使わず HKDF で用途別サブ鍵に分離する。
// WHY: 暗号化（AES）とセッション署名で同一鍵材を直接共用しない（用途分離＝クロスプロトコル耐性）。
// 注：MASTER_KEY 自体が漏れれば派生鍵も再現可能＝根本対策は MASTER_KEY の Worker Secret 必須化（L3）。
async function hmacKey(env: Env): Promise<CryptoKey> {
  const raw = Uint8Array.from(atob(await masterKey(env)), (c) => c.charCodeAt(0)); // MASTER_KEYは標準base64
  const ikm = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: ENC.encode("bo-session-v1"), info: ENC.encode("session-hmac") },
    ikm,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export async function makeSessionCookie(env: Env, s: Session): Promise<string> {
  // 発行時刻 iat を必ず埋める（失効エポックとの比較に使う・§3-3）。呼び出し側は意識しなくてよい。
  const full: Session = { ...s, iat: s.iat ?? Math.floor(Date.now() / 1000) };
  const payload = b64url(ENC.encode(JSON.stringify(full)));
  const sig = b64url(await crypto.subtle.sign("HMAC", await hmacKey(env), ENC.encode(payload)));
  const value = `${payload}.${sig}`;
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}
export function clearSessionCookie(): string {
  return `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// 一時 OAuth 引き継ぎ（pending_oauth）の署名付きペイロード。WHY: 以前は btoa(JSON) で改竄可能（externalId 偽装の余地）。
export async function signPending(env: Env, data: unknown): Promise<string> {
  const payload = b64url(ENC.encode(JSON.stringify(data)));
  const sig = b64url(await crypto.subtle.sign("HMAC", await hmacKey(env), ENC.encode(payload)));
  return `${payload}.${sig}`;
}
export async function verifyPending<T>(env: Env, value: string): Promise<T | null> {
  const [payload, sig] = value.split(".");
  if (!payload || !sig) return null;
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(env), b64urlToBytes(sig), ENC.encode(payload));
  if (!ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as T;
  } catch {
    return null;
  }
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
    // 即時失効（§3-3）：除名・権限降格・admin解任時に revoke エポックを更新する。
    // セッション発行(iat)が失効時刻より前なら無効＝再ログインを強制（ステートレスCookieの7日ラグを解消）。
    if (typeof s.iat === "number") {
      const cut = await env.LICENSE.get(`${REVOKE_PREFIX}${s.uid}`);
      if (cut && s.iat < Number(cut)) return null;
    }
    return s;
  } catch {
    return null;
  }
}

// セッション失効エポックの KV キー接頭辞。値=失効時刻(epoch秒)。これ以前に発行されたセッションを無効化。
const REVOKE_PREFIX = "revoke:";

// 指定ユーザーの既存セッションを即時失効させる（次アクセスで再ログイン）。§3-3。
// WHY: role を内包するステートレスCookieは個別失効手段が無く、権限変更が最大7日反映されない穴があった。
// TTL はセッション最大寿命と同じ＝それ以降は自然失効するため失効レコードも不要になる。
export async function revokeSessions(env: Env, uid: string): Promise<void> {
  try {
    await kvPut(env, `${REVOKE_PREFIX}${uid}`, String(Math.floor(Date.now() / 1000)), {
      expirationTtl: SESSION_DAYS * 86400,
    });
  } catch (e) {
    // KV書き込み上限超過などで失効レコードを書けなくても、管理操作（却下/権限変更）自体は失敗させない（=500を出さない）。
    // WHY 実害小: 申請却下の対象(pending)は有効セッションを持たない。権限変更時も最大 SESSION_DAYS で自然失効する。
    console.warn("revokeSessions: KV put failed (quota?):", (e as Error)?.message);
  }
}

// CSRF 多層防御（P1-1）：状態変更リクエストが同一オリジン由来かを軽量判定する。
// SameSite=Lax Cookie だけに依存せず Origin / Sec-Fetch-Site を併用（CFの有料WAFや外部依存なし）。
// 判定優先: Sec-Fetch-Site（モダンブラウザは必ず付与）→ Origin。どちらも無い変更系は安全側で拒否。
export function sameOrigin(request: Request): boolean {
  const sfs = request.headers.get("sec-fetch-site"); // same-origin / same-site / cross-site / none
  if (sfs) return sfs === "same-origin" || sfs === "none";
  const o = request.headers.get("origin");
  if (!o) return false;
  try {
    return new URL(o).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

// 組織管理者ゲート（admin かつ org 文脈）。多くの管理系APIで使う共通判定。
// 返り値: 条件を満たせば Session、満たさなければ null（呼び出し側で 403）。
export async function requireOrgAdmin(env: Env, request: Request): Promise<Session | null> {
  const ses = await getSession(env, request);
  if (!ses || ses.role !== "admin" || ses.ctx !== "org") return null;
  return ses;
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
