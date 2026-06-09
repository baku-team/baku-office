// 共有暗号ユーティリティ（WebCrypto・Worker/Node22共通）。
// 1) アプリ層暗号化：MASTER_KEY による AES-256-GCM（APIキー・PII。設計書§10.1/付録A）。
// 2) ライセンス署名：Ed25519。署名した実バイト列(body)を搬送してそのbodyを検証（KMS分離耐性）。

const ENC = new TextEncoder();
const DEC = new TextDecoder();
const toB64 = (buf: ArrayBuffer): string => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ---------- AES-256-GCM（MASTER_KEY・用途別サブ鍵をHKDFで派生） ----------

// MASTER_KEY（base64の32バイト乱数）から用途別の AES-GCM 鍵を導出。
async function deriveKey(masterKeyB64: string, domain: string): Promise<CryptoKey> {
  const ikm = fromB64(masterKeyB64);
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: ENC.encode(`baku-office/${domain}`) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

// 平文 → base64( IV(12) ‖ 暗号文‖タグ )。domain で用途分離（api-keys / member-pii / files）。
export async function encryptField(masterKeyB64: string, plaintext: string, domain = "default"): Promise<string> {
  const key = await deriveKey(masterKeyB64, domain);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, ENC.encode(plaintext));
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return toB64(out.buffer);
}

export async function decryptField(masterKeyB64: string, stored: string, domain = "default"): Promise<string> {
  const key = await deriveKey(masterKeyB64, domain);
  const buf = fromB64(stored);
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return DEC.decode(pt);
}

// ファイル本体など大容量バイナリの保存時暗号化（base64化しない＝R2/KVへバイト列のまま保存）。
// 返り値 = IV(12) ‖ 暗号文‖タグ。domain 既定 "files" で他用途(api-keys/member-pii)と鍵分離（§10.1）。
export async function encryptBytes(masterKeyB64: string, data: ArrayBuffer, domain = "files"): Promise<ArrayBuffer> {
  const key = await deriveKey(masterKeyB64, domain);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), iv.length);
  return out.buffer;
}
export async function decryptBytes(masterKeyB64: string, stored: ArrayBuffer, domain = "files"): Promise<ArrayBuffer> {
  const key = await deriveKey(masterKeyB64, domain);
  const buf = new Uint8Array(stored);
  const iv = buf.slice(0, 12);
  const ct = buf.slice(12);
  return crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
}

// 32バイト乱数の MASTER_KEY を生成（base64）。「無ければ生成」用。
export function generateMasterKey(): string {
  return toB64(crypto.getRandomValues(new Uint8Array(32)).buffer);
}

// ---------- Ed25519（ライセンス署名／検証・worker/src/crypto.ts より移設） ----------

export type Envelope = { body: string; sig: string };
type LegacyEnvelope = { payload: unknown; sig: string };
type AnyEnvelope = Envelope | LegacyEnvelope;
export type Ed25519Jwk = { kty: "OKP"; crv: "Ed25519"; x: string; d?: string };

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(",")}}`;
}

export async function importSignKey(jwk: Ed25519Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk as JsonWebKey, { name: "Ed25519" }, false, ["sign"]);
}
export async function importVerifyKey(jwk: Ed25519Jwk): Promise<CryptoKey> {
  const pub: Ed25519Jwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  return crypto.subtle.importKey("jwk", pub as JsonWebKey, { name: "Ed25519" }, false, ["verify"]);
}
export async function signEnvelope(privateKey: CryptoKey, payload: unknown): Promise<Envelope> {
  const bytes = ENC.encode(canonicalize(payload));
  const sig = await crypto.subtle.sign("Ed25519", privateKey, bytes);
  return { body: toB64(bytes.buffer as ArrayBuffer), sig: toB64(sig) };
}
function signedBytes(env: AnyEnvelope): Uint8Array<ArrayBuffer> {
  if ("body" in env && typeof env.body === "string") return fromB64(env.body);
  return ENC.encode(JSON.stringify((env as LegacyEnvelope).payload));
}
export async function verifyEnvelope(publicKey: CryptoKey, env: AnyEnvelope): Promise<boolean> {
  return crypto.subtle.verify("Ed25519", publicKey, fromB64(env.sig), signedBytes(env));
}
export function payloadOf(env: AnyEnvelope): unknown {
  if ("body" in env && typeof env.body === "string") return JSON.parse(DEC.decode(fromB64(env.body)));
  return (env as LegacyEnvelope).payload;
}

// 乱数IDユーティリティ（ライセンスID・招待コード・アクティベーションコード等）。
export function randomId(bytes = 16): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}
