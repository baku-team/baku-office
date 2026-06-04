// Ed25519 署名/検証（WebCrypto subtle）。
// 設計の終点：ホスト(CP)が KMS/HSM で「署名のみ」、クライアント(顧客Worker)は公開鍵で「検証のみ」。
// そのため署名は「実際に署名したバイト列(body)をそのまま搬送し、その body を検証」する（再シリアライズ非依存）。
// これによりキー順・数値表現・空白差・別言語実装でも署名が一致し、可鍛性(malleability)の穴も塞ぐ。
const ENC = new TextEncoder();
const DEC = new TextDecoder();
const toB64 = (buf: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// 署名対象＝キー順を固定した決定的JSON（ホスト/クライアントが別実装でも同一バイト列を再現できる）。
function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

// 正準（新）形式：{ body, sig }。body=base64(署名した実バイト列=canonical JSON)、sig=base64(Ed25519(body))。
export type Envelope = { body: string; sig: string };
// 旧形式（移行期の後方互換・再発行で消える）：{ payload, sig }。検証は payload を再stringifyして照合。
type LegacyEnvelope = { payload: unknown; sig: string };
type AnyEnvelope = Envelope | LegacyEnvelope;
export type Ed25519Jwk = { kty: "OKP"; crv: "Ed25519"; x: string; d?: string };

// 秘密鍵JWK（d付き）→ 署名用キー（ホスト/KMS側）
export async function importSignKey(jwk: Ed25519Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk as JsonWebKey, { name: "Ed25519" }, false, ["sign"]);
}

// 公開部分（x のみ）→ 検証用キー（クライアント側）。秘密鍵(d)を渡しても x だけ使う。
export async function importVerifyKey(jwk: Ed25519Jwk): Promise<CryptoKey> {
  const pub: Ed25519Jwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  return crypto.subtle.importKey("jwk", pub as JsonWebKey, { name: "Ed25519" }, false, ["verify"]);
}

// 署名（ホスト/CP）：canonical JSON のバイト列に署名し、そのバイト列(body)ごと返す。
export async function signEnvelope(privateKey: CryptoKey, payload: unknown): Promise<Envelope> {
  const bytes = ENC.encode(canonicalize(payload));
  const sig = await crypto.subtle.sign("Ed25519", privateKey, bytes);
  return { body: toB64(bytes.buffer as ArrayBuffer), sig: toB64(sig) };
}

// 署名対象だったバイト列（新形式=bodyをそのまま／旧形式=payloadを再stringify）。
function signedBytes(env: AnyEnvelope): Uint8Array {
  if ("body" in env && typeof env.body === "string") return fromB64(env.body);
  return ENC.encode(JSON.stringify((env as LegacyEnvelope).payload));
}

// 署名検証（クライアント・公開鍵）。改ざん/偽造なら false。
export async function verifyEnvelope(publicKey: CryptoKey, env: AnyEnvelope): Promise<boolean> {
  return crypto.subtle.verify("Ed25519", publicKey, fromB64(env.sig), signedBytes(env));
}

// 検証済みエンベロープから payload を取り出す（新形式はbodyをdecode・旧形式はpayloadをそのまま）。
export function payloadOf(env: AnyEnvelope): unknown {
  if ("body" in env && typeof env.body === "string") return JSON.parse(DEC.decode(fromB64(env.body)));
  return (env as LegacyEnvelope).payload;
}
