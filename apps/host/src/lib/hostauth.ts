// ホストポータルのスタッフ認証（§7.3）。Google OAuth＋管理者allowlist。署名Cookieセッション。
// HMAC鍵は ADMIN_KEY（無ければdev固定）。GOOGLE未設定時は dev 管理者ログインで代替。

type HostSession = { email: string; isAdmin: boolean; exp: number };
const COOKIE = "bo_host_session";
const ENC = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function key(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", ENC.encode(env.ADMIN_KEY || "dev-host-secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function makeCookie(env: Env, s: HostSession): Promise<string> {
  const p = b64url(ENC.encode(JSON.stringify(s)));
  const sig = b64url(await crypto.subtle.sign("HMAC", await key(env), ENC.encode(p)));
  return `${COOKIE}=${p}.${sig}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

export async function getHostSession(env: Env, request: Request): Promise<HostSession | null> {
  const m = new RegExp(`${COOKIE}=([^;]+)`).exec(request.headers.get("cookie") ?? "");
  if (!m) return null;
  const [p, sig] = m[1].split(".");
  if (!p || !sig) return null;
  if (!(await crypto.subtle.verify("HMAC", await key(env), fromB64url(sig), ENC.encode(p)))) return null;
  try {
    const s = JSON.parse(new TextDecoder().decode(fromB64url(p))) as HostSession;
    return s.exp < Math.floor(Date.now() / 1000) ? null : s;
  } catch {
    return null;
  }
}

export const isAdminEmail = (env: Env, email: string): boolean =>
  (env.HOST_ADMIN_EMAILS ?? "").split(",").map((s) => s.trim()).filter(Boolean).includes(email);
export const googleEnabled = (env: Env): boolean => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
export const sessionExp = () => Math.floor(Date.now() / 1000) + 7 * 86400;

// Google OAuth（ホスト）。
export function googleAuthUrl(env: Env, origin: string, state: string): string {
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  u.searchParams.set("client_id", env.GOOGLE_CLIENT_ID!);
  u.searchParams.set("redirect_uri", `${origin}/api/auth/google/callback`);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  return u.toString();
}
export async function googleExchange(env: Env, code: string, origin: string): Promise<{ email: string } | null> {
  const tr = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: `${origin}/api/auth/google/callback`, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET! }),
  });
  if (!tr.ok) return null;
  const tok = (await tr.json()) as { access_token?: string };
  if (!tok.access_token) return null;
  const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${tok.access_token}` } });
  if (!r.ok) return null;
  const u = (await r.json()) as { email?: string };
  return u.email ? { email: u.email } : null;
}
