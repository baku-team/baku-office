// Google サービスアカウント＋ドメイン全体の委任(DWD)による Workspace 連携。
// per-user OAuth（client_id/secret＋refresh_token）の代替経路。SA鍵で Workspace ユーザーを代理し、
// Calendar/Gmail/Meet にアクセスする。鍵はクラウンジュエル＝暗号化KVに保管（saveApiKey 経由）。
// WHY: OAuth クライアントID/シークレットの自動発行は Google が許可しないため、SA鍵（gcloud で生成可能）＋
// 管理コンソールでの一度きりの DWD 承認に置き換えることで、資格情報の発行をほぼ自動化できる。
import { getApiKey, saveApiKey, deleteApiKey } from "./client.ts";
import { kvPut } from "./kv.ts";
import { nowSec } from "./accounting.ts";

const SA_KEY = "google_sa_key";          // SA鍵JSON（暗号化保管）
const SA_SUBJECT = "google_sa_subject";   // 代理する Workspace ユーザーのメール（LICENSE KV）
const SA_TOKEN = "google_sa_token";       // アクセストークンのキャッシュ（LICENSE KV）
const TOKEN_URL = "https://oauth2.googleapis.com/token";

type SaKey = { client_email?: string; client_id?: string; private_key?: string; token_uri?: string };

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlStr = (s: string): string => b64url(enc.encode(s));

// PEM(PKCS8) → DER(ArrayBuffer)。SA鍵の private_key を Web Crypto に渡せる形へ。
function pemToDer(pem: string): ArrayBuffer {
  const body = pem.replace(/-----BEGIN [^-]+-----/, "").replace(/-----END [^-]+-----/, "").replace(/\s+/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export async function signJwt(privateKeyPem: string, claims: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey("pkcs8", pemToDer(privateKeyPem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const header = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = b64urlStr(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

// SA鍵＋代理subject＋scopeでアクセストークンを発行（DWD）。テスト容易化のため鍵オブジェクトを直接受ける版も公開。
export async function mintSaToken(key: SaKey, subject: string, scope: string): Promise<{ ok: boolean; token?: string; expiresIn?: number; error?: string }> {
  if (!key.client_email || !key.private_key) return { ok: false, error: "SA鍵に client_email / private_key がありません" };
  const iat = nowSec();
  const assertion = await signJwt(key.private_key, {
    iss: key.client_email, sub: subject, scope, aud: key.token_uri || TOKEN_URL, iat, exp: iat + 3600,
  });
  const r = await fetch(TOKEN_URL, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  if (!r.ok) return { ok: false, error: `トークン取得に失敗（${r.status}）：${(await r.text()).slice(0, 200)}` };
  const t = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!t.access_token) return { ok: false, error: "access_token が返りませんでした" };
  return { ok: true, token: t.access_token, expiresIn: t.expires_in ?? 3600 };
}

async function loadKey(env: Env): Promise<SaKey | null> {
  const raw = await getApiKey(env, SA_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as SaKey; } catch { return null; }
}

// SA連携の設定：鍵JSON（暗号化保管）＋代理subjectメール。client_email/private_key/client_id を検証。
export async function saveServiceAccount(env: Env, keyJson: string, subject: string): Promise<{ ok: boolean; error?: string }> {
  let key: SaKey;
  try { key = JSON.parse(keyJson) as SaKey; } catch { return { ok: false, error: "鍵ファイルが JSON として読み込めません" }; }
  if (!key.client_email || !key.private_key || !key.client_id) return { ok: false, error: "サービスアカウント鍵（client_email / private_key / client_id を含む JSON）を指定してください" };
  const sub = subject.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sub)) return { ok: false, error: "代理するユーザーのメールアドレスを正しく入力してください" };
  await saveApiKey(env, SA_KEY, JSON.stringify(key)); // 暗号化保管
  await kvPut(env, SA_SUBJECT, sub);
  await env.LICENSE.delete(SA_TOKEN); // 設定変更でキャッシュ破棄
  return { ok: true };
}

export async function serviceAccountConfigured(env: Env): Promise<boolean> {
  return !!(await getApiKey(env, SA_KEY)) && !!(await env.LICENSE.get(SA_SUBJECT));
}

// 表示用情報（秘密鍵は返さない）。DWD登録に使う client_id（数値）とメールを返す。
export async function getServiceAccountInfo(env: Env): Promise<{ clientEmail: string; clientId: string; subject: string } | null> {
  const key = await loadKey(env);
  const subject = await env.LICENSE.get(SA_SUBJECT);
  if (!key?.client_email || !key.client_id || !subject) return null;
  return { clientEmail: key.client_email, clientId: key.client_id, subject };
}

export async function clearServiceAccount(env: Env): Promise<void> {
  await deleteApiKey(env, SA_KEY);
  await env.LICENSE.delete(SA_SUBJECT);
  await env.LICENSE.delete(SA_TOKEN);
}

// SA経由のアクセストークン（scope指定）。同一scopeのキャッシュが有効ならそれを返す。
export async function serviceAccountAccessToken(env: Env, scope: string): Promise<string | null> {
  const key = await loadKey(env);
  const subject = await env.LICENSE.get(SA_SUBJECT);
  if (!key || !subject) return null;
  try {
    const cached = JSON.parse((await env.LICENSE.get(SA_TOKEN)) ?? "null") as { token: string; exp: number; scope: string } | null;
    if (cached && cached.scope === scope && cached.exp > nowSec() + 60) return cached.token;
  } catch { /* fallthrough */ }
  const res = await mintSaToken(key, subject, scope);
  if (!res.ok || !res.token) return null;
  await kvPut(env, SA_TOKEN, JSON.stringify({ token: res.token, exp: nowSec() + (res.expiresIn ?? 3600), scope }));
  return res.token;
}

// 接続テスト：実際にトークンを発行してみる（成否＋理由を返す）。
export async function testServiceAccount(env: Env, scope: string): Promise<{ ok: boolean; error?: string }> {
  const key = await loadKey(env);
  const subject = await env.LICENSE.get(SA_SUBJECT);
  if (!key || !subject) return { ok: false, error: "サービスアカウントが未設定です" };
  const res = await mintSaToken(key, subject, scope);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
