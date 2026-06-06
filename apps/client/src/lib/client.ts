// クライアント側の共通ロジック：ライセンストークンの保持・統合チェック・APIキーの暗号保存（§4/7/10）。
import { encryptField, decryptField, generateMasterKey, type CheckResponse, type Entitlement, type Ed25519Jwk } from "@baku-office/shared";
import { logDiag } from "./diag.ts";
import type { Ctx, KvPort } from "../core/ports.ts";

const KV_TOKEN = "license_token";
const KV_ENTITLEMENT = "entitlement";
const KEY_PREFIX = "apikey:"; // KV: apikey:gemini / apikey:line_secret / apikey:line_token / apikey:claude

export const nowSec = (): number => Math.floor(Date.now() / 1000);

// host への呼び出し：同一アカウントは Service Binding（HOST）、別アカウントは URL fetch（カスタムドメイン推奨）。
// 同一 workers.dev 同士の直fetchは CF がループ防止で遮断するため（error 1042）。
export function hostFetch(env: Env, path: string, init?: RequestInit): Promise<Response> {
  if (env.HOST) return env.HOST.fetch(new Request("https://host.internal" + path, init));
  return fetch(env.HOST_BASE_URL.replace(/\/$/, "") + path, init);
}

// 保存済みライセンストークン（base64の{body,sig}）。
export async function getToken(env: Env): Promise<string | null> {
  return env.LICENSE.get(KV_TOKEN);
}
export async function saveToken(env: Env, token: string): Promise<void> {
  await env.LICENSE.put(KV_TOKEN, token);
}

// 統合チェック（§13.1）：ホストへトークン＋deploy_url/version を送り {entitlement,latestVersion,notices}。
// 稼働中バンドルのバージョン（リリース時に build-release.mjs の VERSION と揃えて更新）。
export const APP_VERSION = "0.1.0";
export async function pollHost(env: Env, deployUrl?: string): Promise<CheckResponse | null> {
  const token = await getToken(env);
  if (!token) return null;
  const qs = new URLSearchParams({ token, version: APP_VERSION });
  if (deployUrl) qs.set("deploy_url", deployUrl);
  try {
    const r = await hostFetch(env, "/api/check?" + qs.toString());
    if (!r.ok) return null;
    const data = (await r.json()) as CheckResponse;
    await env.LICENSE.put(KV_ENTITLEMENT, data.entitlement);
    return data;
  } catch {
    return null;
  }
}

// 保存済みトークンから licenseId を取り出す（課金導線で host へ渡す）。
export async function getLicenseId(env: Env): Promise<string | null> {
  const token = await getToken(env);
  if (!token) return null;
  try {
    const env2 = JSON.parse(atob(token)) as { body: string };
    const payload = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(env2.body), (c) => c.charCodeAt(0)))) as { licenseId: string };
    return payload.licenseId;
  } catch {
    return null;
  }
}

// 直近に保存したエンタイトルメント（オフライン時のフォールバック表示用）。
export async function cachedEntitlement(env: Env): Promise<Entitlement> {
  return ((await env.LICENSE.get(KV_ENTITLEMENT)) as Entitlement) ?? "free";
}

// MASTER_KEY：secret があれば優先、無ければ生成して LICENSE KV に保存（セルフ導入＝secret投入不要）。
// 鍵は団体自身の CF アカウント内（KV）に保持。当社は保持しない。
// WHY: KV自動生成は zero-config 維持のためだが、鍵が暗号文（apikey:*・PII）と同一 LICENSE KV に同居し、
// アカウント侵害時に暗号化が無力化する（設計書§10.1の自己警告）。本番は MASTER_KEY を Worker Secret で投入推奨。
// secret 未投入時は重大診断を残し、管理画面で警告できるようにする。
// KVNamespace を KvPort（移植性アーキ §14-3）に薄く包む。
function kvOf(ns: KVNamespace): KvPort {
  return {
    get: (k) => ns.get(k),
    put: (k, v, o) => ns.put(k, v, o),
    delete: (k) => ns.delete(k),
    list: async (p) => (await ns.list({ prefix: p })).keys.map((x) => x.name),
  };
}
// 鍵の「保管」を KvPort 経由に分離（§14-3）。secret(env.MASTER_KEY) 優先、無ければ kv に自動生成。
// 演算（HKDF/AES-GCM）は shared の純粋関数のまま。保管先だけ Profile で差し替え可能。
async function resolveMasterKey(env: Env, kv: KvPort): Promise<string> {
  let k = await kv.get("master_key");
  if (!k) {
    k = generateMasterKey();
    await kv.put("master_key", k);
    await kv.put("master_key_source", "kv-autogen");
    await logDiag(env, "warn", "security", "MASTER_KEY 未設定のため KV に自動生成しました。本番は Worker Secret(MASTER_KEY)の投入を推奨します（鍵と暗号文の同居を避けるため）。");
  }
  return k;
}
export async function masterKey(env: Env): Promise<string> {
  if (env.MASTER_KEY) return env.MASTER_KEY;
  return resolveMasterKey(env, kvOf(env.LICENSE));
}
// ctx 版（鍵保管 Port 経由）。パーツ/コアからは原則こちらを使う。
export async function masterKeyCtx(ctx: Ctx): Promise<string> {
  if (ctx.env.MASTER_KEY) return ctx.env.MASTER_KEY;
  return resolveMasterKey(ctx.env, ctx.storage.kv);
}

// 鍵の保管状態（管理画面の診断表示用）。"secret"=Worker Secret運用（推奨）、"kv-autogen"=KV自動生成（要対応）。
export async function masterKeySource(env: Env): Promise<"secret" | "kv-autogen" | "unknown"> {
  if (env.MASTER_KEY) return "secret";
  return ((await env.LICENSE.get("master_key_source")) as "kv-autogen" | null) ?? "unknown";
}

// ライセンス署名の検証鍵（公開鍵）。secret があれば優先、無ければホストの /api/pubkey から取得して KV キャッシュ。
export async function getVerifyJwk(env: Env): Promise<Ed25519Jwk | null> {
  const parse = (s: string): Ed25519Jwk | null => { try { return JSON.parse(s) as Ed25519Jwk; } catch { return null; } };
  if (env.VERIFY_PUBLIC_JWK) return parse(env.VERIFY_PUBLIC_JWK);
  const cached = await env.LICENSE.get("verify_jwk");
  if (cached) return parse(cached);
  try {
    const r = await hostFetch(env, "/api/pubkey");
    if (r.ok) { const t = await r.text(); if (parse(t)) { await env.LICENSE.put("verify_jwk", t); return parse(t); } }
  } catch { /* offline */ }
  return null;
}

// APIキーの暗号保存（§10.3）。domain=api-keys でサブ鍵分離。
export async function saveApiKey(env: Env, name: string, value: string): Promise<void> {
  const enc = await encryptField(await masterKey(env), value, "api-keys");
  await env.LICENSE.put(KEY_PREFIX + name, enc);
}
export async function getApiKey(env: Env, name: string): Promise<string | null> {
  const stored = await env.LICENSE.get(KEY_PREFIX + name);
  if (!stored) return null;
  return decryptField(await masterKey(env), stored, "api-keys");
}
export async function hasApiKey(env: Env, name: string): Promise<boolean> {
  return (await env.LICENSE.get(KEY_PREFIX + name)) !== null;
}

// 保存時バリデーション（§7.2/付録A）：対象サービスへテスト呼び出し。
export async function validateApiKey(name: string, value: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    if (name === "gemini") {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(value)}`);
      return r.ok ? { ok: true } : { ok: false, detail: `Gemini ${r.status}` };
    }
    if (name === "claude") {
      // 軽量な検証：models 一覧（401/403なら無効）。
      const r = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": value, "anthropic-version": "2023-06-01" },
      });
      return r.ok ? { ok: true } : { ok: false, detail: `Claude ${r.status}` };
    }
    if (name === "notion") {
      const r = await fetch("https://api.notion.com/v1/users/me", {
        headers: { authorization: `Bearer ${value}`, "Notion-Version": "2022-06-28" },
      });
      return r.ok ? { ok: true } : { ok: false, detail: `Notion ${r.status}` };
    }
    // line_secret / line_token は単体検証が難しいため形式チェックのみ。
    return value.length > 0 ? { ok: true } : { ok: false, detail: "空" };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}
