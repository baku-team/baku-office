// Google サービスアカウント＋ドメイン全体の委任(DWD)による Workspace 連携。
// per-user OAuth（client_id/secret＋refresh_token）の代替経路。SA鍵で Workspace ユーザーを代理し、
// Calendar/Gmail/Meet にアクセスする。鍵はクラウンジュエル＝暗号化KVに保管（saveApiKey 経由）。
// WHY: OAuth クライアントID/シークレットの自動発行は Google が許可しないため、SA鍵（gcloud で生成可能）＋
// 管理コンソールでの一度きりの DWD 承認に置き換えることで、資格情報の発行をほぼ自動化できる。
import { getApiKey, saveApiKey, deleteApiKey, hasApiKey } from "./client.ts";
import { kvPut } from "./kv.ts";
import { nowSec } from "./accounting.ts";
import { ensureOidcKey, signOidcJwt } from "./oidc-idp.ts";

const SA_KEY = "google_sa_key";          // SA鍵JSON（暗号化保管・key方式のみ）
const SA_SUBJECT = "google_sa_subject";   // 代理する Workspace ユーザーのメール（LICENSE KV）
const SA_TOKEN = "google_sa_token";       // アクセストークンのキャッシュ（LICENSE KV）
const SA_MODE = "google_sa_mode";         // "key" | "wif"（LICENSE KV）
const WIF_CONFIG = "google_wif_config";   // WIF設定JSON（非秘密・平文KV。秘密はOIDC秘密鍵のみで別保管）
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

// ── キーレス WIF＋DWD（案B） ────────────────────────────────────────────────
// SA鍵JSONを持たず、Worker 自署名の OIDC JWT を WIF に提示してフェデレーション資格情報を得て、
// iamcredentials.signJwt で DWD アサーションを SA に署名させる。可搬な長期鍵はどこにも存在しない。
export type WifConfig = {
  sa_email: string;        // DWD で代理する SA（鍵なし）
  client_id: string;       // 数値 oauth2ClientId（管理コンソールの委任登録に使う・表示のみ）
  project_number: string;  // GCP プロジェクト番号（WIF audience に使う・project_id ではない）
  pool: string;            // Workload Identity Pool ID
  provider: string;        // Pool 内の OIDC Provider ID
  issuer: string;          // この Worker の公開URL（OIDC iss＝WIF の issuer-uri と一致必須）
};

const STS_URL = "https://sts.googleapis.com/v1/token";

// WIF＋signJwt の4ホップで対象ユーザーの access_token を発行。OIDC 署名関数を注入しテスト可能にする。
export async function mintSaTokenWif(
  cfg: WifConfig,
  subject: string,
  scope: string,
  signOidc: (claims: Record<string, unknown>) => Promise<string>,
): Promise<{ ok: boolean; token?: string; expiresIn?: number; error?: string }> {
  if (!cfg.sa_email || !cfg.project_number || !cfg.pool || !cfg.provider || !cfg.issuer) {
    return { ok: false, error: "WIF設定（sa_email/project_number/pool/provider/issuer）が不足しています" };
  }
  const providerResource = `projects/${cfg.project_number}/locations/global/workloadIdentityPools/${cfg.pool}/providers/${cfg.provider}`;
  const iat = nowSec();

  // ホップ0：Worker が短命 OIDC JWT を自署名。aud は **スキーム有り**（https://iam.googleapis.com/...）。
  const oidcJwt = await signOidc({ iss: cfg.issuer, sub: "baku-office", aud: `https://iam.googleapis.com/${providerResource}`, iat, exp: iat + 300 });

  // ホップ1：STS でフェデレーション access_token に交換。audience は **先頭`//`・スキーム無し**（#0 と別形式！最頻バグ）。
  const sts = await fetch(STS_URL, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      audience: `//iam.googleapis.com/${providerResource}`,
      scope: "https://www.googleapis.com/auth/cloud-platform",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      subject_token: oidcJwt,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    }),
  });
  if (!sts.ok) return { ok: false, error: `STS交換に失敗（${sts.status}）：${(await sts.text()).slice(0, 200)}` };
  const federated = ((await sts.json()) as { access_token?: string }).access_token;
  if (!federated) return { ok: false, error: "STSがaccess_tokenを返しませんでした" };

  // ホップ2：iamcredentials.signJwt で DWD アサーションを SA に署名させる（鍵を持たずに SA として署名）。
  const dwdClaims = { iss: cfg.sa_email, sub: subject, scope, aud: TOKEN_URL, iat, exp: iat + 3600 };
  const sj = await fetch(`https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(cfg.sa_email)}:signJwt`, {
    method: "POST", headers: { authorization: `Bearer ${federated}`, "content-type": "application/json" },
    body: JSON.stringify({ payload: JSON.stringify(dwdClaims) }),
  });
  if (!sj.ok) return { ok: false, error: `signJwtに失敗（${sj.status}）：${(await sj.text()).slice(0, 200)}` };
  const signedJwt = ((await sj.json()) as { signedJwt?: string }).signedJwt;
  if (!signedJwt) return { ok: false, error: "signJwtがsignedJwtを返しませんでした" };

  // ホップ3：DWD トークンエンドポイントで対象ユーザーの access_token を得る。
  const r = await fetch(TOKEN_URL, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedJwt }),
  });
  if (!r.ok) return { ok: false, error: `DWDトークン取得に失敗（${r.status}）：${(await r.text()).slice(0, 200)}` };
  const t = (await r.json()) as { access_token?: string; expires_in?: number };
  if (!t.access_token) return { ok: false, error: "access_token が返りませんでした" };
  return { ok: true, token: t.access_token, expiresIn: t.expires_in ?? 3600 };
}

async function loadKey(env: Env): Promise<SaKey | null> {
  const raw = await getApiKey(env, SA_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as SaKey; } catch { return null; }
}

async function loadWif(env: Env): Promise<WifConfig | null> {
  const raw = await env.LICENSE.get(WIF_CONFIG);
  if (!raw) return null;
  try { return JSON.parse(raw) as WifConfig; } catch { return null; }
}

// 連携方式の判定。明示保存（SA_MODE）を優先し、未設定の旧データは実体から推定（key 既存連携の後退防止）。
async function saMode(env: Env): Promise<"key" | "wif" | null> {
  const m = await env.LICENSE.get(SA_MODE);
  if (m === "key" || m === "wif") return m;
  if (await env.LICENSE.get(WIF_CONFIG)) return "wif";
  if (await hasApiKey(env, SA_KEY)) return "key";
  return null;
}

// 方式に応じてトークンを発行（key=mintSaToken / wif=mintSaTokenWif）。subject/scope は共通。
async function mintForMode(env: Env, subject: string, scope: string): Promise<{ ok: boolean; token?: string; expiresIn?: number; error?: string }> {
  const mode = await saMode(env);
  if (mode === "wif") {
    const cfg = await loadWif(env);
    if (!cfg) return { ok: false, error: "WIF設定が見つかりません" };
    return mintSaTokenWif(cfg, subject, scope, (claims) => signOidcJwt(env, claims));
  }
  if (mode === "key") {
    const key = await loadKey(env);
    if (!key) return { ok: false, error: "サービスアカウント鍵が見つかりません" };
    return mintSaToken(key, subject, scope);
  }
  return { ok: false, error: "サービスアカウントが未設定です" };
}

// WIF（キーレス）連携の設定：鍵JSONを保存せず、非秘密の WIF 設定＋代理subjectのみ保存。
// OIDC 署名鍵を先に生成して JWKS を確実に公開状態にする（WIFプロバイダの検証に備える）。
export async function saveWifConfig(env: Env, cfg: WifConfig, subject: string): Promise<{ ok: boolean; error?: string }> {
  const sub = subject.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sub)) return { ok: false, error: "代理するユーザーのメールアドレスを正しく入力してください" };
  if (!cfg.sa_email || !cfg.client_id || !cfg.project_number || !cfg.pool || !cfg.provider) {
    return { ok: false, error: "WIF設定（sa_email / client_id / project_number / pool / provider）が不足しています" };
  }
  if (!/^\d+$/.test(String(cfg.project_number))) return { ok: false, error: "project_number は数値（プロジェクト番号）を指定してください" };
  await ensureOidcKey(env); // JWKS 存在保証
  const clean: WifConfig = {
    sa_email: cfg.sa_email.trim(), client_id: String(cfg.client_id).trim(), project_number: String(cfg.project_number).trim(),
    pool: cfg.pool.trim(), provider: cfg.provider.trim(), issuer: cfg.issuer.replace(/\/$/, ""),
  };
  await kvPut(env, WIF_CONFIG, JSON.stringify(clean));
  await kvPut(env, SA_MODE, "wif");
  await kvPut(env, SA_SUBJECT, sub);
  await env.LICENSE.delete(SA_TOKEN); // 設定変更でキャッシュ破棄
  return { ok: true };
}

// SA連携の設定：鍵JSON（暗号化保管）＋代理subjectメール。client_email/private_key/client_id を検証。
export async function saveServiceAccount(env: Env, keyJson: string, subject: string): Promise<{ ok: boolean; error?: string }> {
  let key: SaKey;
  try { key = JSON.parse(keyJson) as SaKey; } catch { return { ok: false, error: "鍵ファイルが JSON として読み込めません" }; }
  if (!key.client_email || !key.private_key || !key.client_id) return { ok: false, error: "サービスアカウント鍵（client_email / private_key / client_id を含む JSON）を指定してください" };
  const sub = subject.trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(sub)) return { ok: false, error: "代理するユーザーのメールアドレスを正しく入力してください" };
  await saveApiKey(env, SA_KEY, JSON.stringify(key)); // 暗号化保管
  await kvPut(env, SA_MODE, "key");
  await kvPut(env, SA_SUBJECT, sub);
  await env.LICENSE.delete(SA_TOKEN); // 設定変更でキャッシュ破棄
  return { ok: true };
}

export async function serviceAccountConfigured(env: Env): Promise<boolean> {
  if (!(await env.LICENSE.get(SA_SUBJECT))) return false;
  const mode = await saMode(env);
  if (mode === "wif") return !!(await env.LICENSE.get(WIF_CONFIG));
  if (mode === "key") return await hasApiKey(env, SA_KEY);
  return false;
}

// 表示用情報（秘密は返さない）。DWD登録に使う client_id（数値）・SAメール・方式・subject を返す。
export async function getServiceAccountInfo(env: Env): Promise<{ mode: "key" | "wif"; clientEmail: string; clientId: string; subject: string } | null> {
  const subject = await env.LICENSE.get(SA_SUBJECT);
  if (!subject) return null;
  const mode = await saMode(env);
  if (mode === "wif") {
    const cfg = await loadWif(env);
    if (!cfg?.sa_email || !cfg.client_id) return null;
    return { mode, clientEmail: cfg.sa_email, clientId: cfg.client_id, subject };
  }
  if (mode === "key") {
    const key = await loadKey(env);
    if (!key?.client_email || !key.client_id) return null;
    return { mode, clientEmail: key.client_email, clientId: key.client_id, subject };
  }
  return null;
}

export async function clearServiceAccount(env: Env): Promise<void> {
  await deleteApiKey(env, SA_KEY);
  await env.LICENSE.delete(WIF_CONFIG);
  await env.LICENSE.delete(SA_MODE);
  await env.LICENSE.delete(SA_SUBJECT);
  await env.LICENSE.delete(SA_TOKEN);
}

// SA経由のアクセストークン（scope指定）。方式(key/wif)に応じて発行。同一scopeのキャッシュが有効ならそれを返す。
export async function serviceAccountAccessToken(env: Env, scope: string): Promise<string | null> {
  const subject = await env.LICENSE.get(SA_SUBJECT);
  if (!subject) return null;
  try {
    const cached = JSON.parse((await env.LICENSE.get(SA_TOKEN)) ?? "null") as { token: string; exp: number; scope: string } | null;
    if (cached && cached.scope === scope && cached.exp > nowSec() + 60) return cached.token;
  } catch { /* fallthrough */ }
  const res = await mintForMode(env, subject, scope);
  if (!res.ok || !res.token) return null;
  await kvPut(env, SA_TOKEN, JSON.stringify({ token: res.token, exp: nowSec() + (res.expiresIn ?? 3600), scope }));
  return res.token;
}

// 接続テスト：実際にトークンを発行してみる（成否＋理由を返す）。方式(key/wif)に応じて発行。
export async function testServiceAccount(env: Env, scope: string): Promise<{ ok: boolean; error?: string }> {
  const subject = await env.LICENSE.get(SA_SUBJECT);
  if (!subject) return { ok: false, error: "サービスアカウントが未設定です" };
  const res = await mintForMode(env, subject, scope);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
}
