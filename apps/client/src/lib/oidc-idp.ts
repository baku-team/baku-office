// Worker を OIDC Identity Provider 化する最小実装（キーレス WIF＋DWD・案B の土台）。
// 各テナントの Worker が自分専用の RS256 鍵で短命 OIDC JWT を自署名し、それを Google の
// Workload Identity Federation（WIF）に提示してフェデレーション資格情報を得る。可搬な長期鍵（SA鍵JSON）は
// どこにも存在せず、当社(baku-team)は機密を一切預からない。秘密鍵は団体自身の CF アカウント内（暗号化KV）にのみ保持。
// WHY: 組織ポリシー iam.disableServiceAccountKeyCreation で鍵作成が禁止された組織でも動かすため、
// SA鍵に依存しない署名経路（WIF→signJwt）へ移行する。その入口が「Worker＝OIDC IdP」化（本モジュール）。
import { getApiKey, saveApiKey } from "./client.ts";
import { kvPut } from "./kv.ts";

const PRIVATE_JWK = "oidc_private_jwk"; // RS256 秘密鍵(JWK)・暗号化保管（apikey:*）
const PUBLIC_JWK = "oidc_public_jwk";   // 公開鍵(JWK・kid付)・平文KV（公開してよい）

const ALG = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

type Jwk = JsonWebKey & { kid?: string };

const enc = new TextEncoder();
const b64url = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlStr = (s: string): string => b64url(enc.encode(s));

// RFC 7638 JWK Thumbprint（SHA-256・b64url）。RSA は {e,kty,n} を辞書順で正規化してハッシュ。
// kid を鍵から決定的に導くことで、鍵ローテーション時も discovery/署名が一貫する。
async function jwkThumbprint(pub: JsonWebKey): Promise<string> {
  const canon = JSON.stringify({ e: pub.e, kty: pub.kty, n: pub.n });
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(canon));
  return b64url(digest);
}

// OIDC 署名鍵を遅延生成して取得。未生成なら RSA2048 を作り、秘密=暗号化KV／公開(kid付)=平文KV に保存。
export async function ensureOidcKey(env: Env): Promise<{ key: CryptoKey; kid: string; publicJwk: Jwk }> {
  const storedPriv = await getApiKey(env, PRIVATE_JWK);
  const storedPub = await env.LICENSE.get(PUBLIC_JWK);
  if (storedPriv && storedPub) {
    const privJwk = JSON.parse(storedPriv) as JsonWebKey;
    const publicJwk = JSON.parse(storedPub) as Jwk;
    const key = await crypto.subtle.importKey("jwk", privJwk, ALG, false, ["sign"]);
    return { key, kid: publicJwk.kid!, publicJwk };
  }
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const privJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const pubExport = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const kid = await jwkThumbprint(pubExport);
  const publicJwk: Jwk = { kty: pubExport.kty, n: pubExport.n, e: pubExport.e, alg: "RS256", use: "sig", kid };
  await saveApiKey(env, PRIVATE_JWK, JSON.stringify(privJwk)); // 暗号化保管
  await kvPut(env, PUBLIC_JWK, JSON.stringify(publicJwk));
  const key = await crypto.subtle.importKey("jwk", privJwk, ALG, false, ["sign"]);
  return { key, kid, publicJwk };
}

// 公開 JWKS（無認証で公開・Google STS が subject_token 検証に使う）。鍵未生成なら生成して返す。
export async function oidcJwks(env: Env): Promise<{ keys: Jwk[] }> {
  const { publicJwk } = await ensureOidcKey(env);
  return { keys: [publicJwk] };
}

// OIDC discovery ドキュメント（issuer はリクエスト origin＝この Worker の公開URL）。
// 最小限：WIF が要求する issuer / jwks_uri / 署名アルゴと、形式上必須の数項目のみ。
export function openidConfiguration(issuer: string): Record<string, unknown> {
  const iss = issuer.replace(/\/$/, "");
  return {
    issuer: iss,
    jwks_uri: `${iss}/.well-known/jwks.json`,
    authorization_endpoint: `${iss}/api/google/start`, // 形式上の必須項目（本IdPは認可フローを提供しない）
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  };
}

// 短命 OIDC JWT（WIF の subject_token）を自署名。header に kid を載せ、JWKS で検証可能にする。
export async function signOidcJwt(env: Env, claims: Record<string, unknown>): Promise<string> {
  const { key, kid } = await ensureOidcKey(env);
  const header = b64urlStr(JSON.stringify({ alg: "RS256", typ: "JWT", kid }));
  const payload = b64urlStr(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const sig = await crypto.subtle.sign(ALG.name, key, enc.encode(data));
  return `${data}.${b64url(sig)}`;
}
