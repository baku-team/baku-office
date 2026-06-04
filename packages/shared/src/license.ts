// ライセンストークン：当社(ホスト)が Ed25519 で署名し、クライアントが公開鍵で検証する（§4）。
// 署名対象バイト列(body)を搬送してそのbodyを検証＝KMS分離・別実装でも一致（crypto.ts）。
import { type Envelope, type Ed25519Jwk, importSignKey, importVerifyKey, signEnvelope, verifyEnvelope, payloadOf } from "./crypto.ts";
import type { LicensePayload } from "./types.ts";

// 署名（ホスト側・秘密鍵）。
export async function signLicense(jwk: Ed25519Jwk, payload: LicensePayload): Promise<Envelope> {
  return signEnvelope(await importSignKey(jwk), payload);
}

// 検証（クライアント側・公開鍵のみ）。改ざん/失効なら null。
export async function openLicense(jwk: Ed25519Jwk, env: Envelope, nowSec: number): Promise<LicensePayload | null> {
  if (!(await verifyEnvelope(await importVerifyKey(jwk), env))) return null;
  const p = payloadOf(env) as LicensePayload;
  if (typeof p?.exp !== "number" || nowSec >= p.exp) return null;
  return p;
}
