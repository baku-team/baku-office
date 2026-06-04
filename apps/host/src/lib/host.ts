// ホスト側の共通ロジック：ライセンス署名鍵の取得・統合チェック応答の組み立て。
import { type Ed25519Jwk, type LicensePayload, type Entitlement, type CheckResponse, signLicense, randomId } from "@baku-office/shared";

export const nowSec = (): number => Math.floor(Date.now() / 1000);

// 署名鍵（ホストのみ・SIGNING_JWK）。本番はKMSへ（課題保留）。
export function signingJwk(env: Env): Ed25519Jwk {
  if (!env.SIGNING_JWK) throw new Error("SIGNING_JWK 未設定（ライセンス署名はホストのみ）");
  return JSON.parse(env.SIGNING_JWK) as Ed25519Jwk;
}

// ライセンストークン（30日）を発行。
export async function issueLicenseToken(env: Env, licenseId: string, entitlement: Entitlement): Promise<string> {
  const payload: LicensePayload = { licenseId, entitlement, iat: nowSec(), exp: nowSec() + 30 * 86400 };
  const env2 = await signLicense(signingJwk(env), payload);
  return btoa(JSON.stringify(env2)); // {body,sig} を base64 で1トークン化
}

// 統合チェック（§13.1）：エンタイトルメント＋最新版＋通知。
export async function buildCheck(env: Env, entitlement: Entitlement): Promise<CheckResponse> {
  const { results } = await env.DB.prepare(
    "SELECT id, severity, body FROM notices WHERE active = 1 ORDER BY created_at DESC LIMIT 20",
  ).all<{ id: string; severity: string; body: string }>();
  return {
    entitlement,
    latestVersion: env.LATEST_VERSION ?? "0.0.0",
    notices: results.map((n) => ({ id: n.id, severity: n.severity as "info" | "important" | "critical", body: n.body })),
  };
}

export { randomId };
