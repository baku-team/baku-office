// クライアント側の共通ロジック：ライセンストークンの保持・統合チェック・APIキーの暗号保存（§4/7/10）。
import { encryptField, decryptField, generateMasterKey, type CheckResponse, type Entitlement, type Ed25519Jwk } from "@baku-office/shared";
import { logDiag } from "./diag.ts";
import type { Ctx, KvPort } from "../core/ports.ts";

const KV_TOKEN = "license_token";
const KV_ENTITLEMENT = "entitlement";
const KV_ENTITLEMENT_AT = "entitlement_at"; // 直近の統合チェック時刻（鮮度ゲート用）
const KV_DISABLED_BUILTINS = "host_disabled_builtins"; // ホストが除外した標準同梱アプリ id（JSON配列）
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
export const APP_VERSION = "0.2.0";
export async function pollHost(env: Env, deployUrl?: string, apps?: { id: string; version: string }[]): Promise<CheckResponse | null> {
  const token = await getToken(env);
  if (!token) return null;
  // トークンはヘッダで送る（クエリだと host の observability ログに残るため・§5）。残りはPIIなしのメタ情報。
  const qs = new URLSearchParams({ version: APP_VERSION });
  if (deployUrl) qs.set("deploy_url", deployUrl);
  // 導入アプリを中枢へ申告（id:version・PIIなし）。ホストが「どのアプリがどこで使われているか」を集計。
  if (apps?.length) qs.set("apps", apps.map((a) => `${a.id}:${a.version}`).join(","));
  try {
    const r = await hostFetch(env, "/api/check?" + qs.toString(), { headers: { "x-bo-license": token } });
    if (!r.ok) return null;
    const data = (await r.json()) as CheckResponse;
    await env.LICENSE.put(KV_ENTITLEMENT, data.entitlement);
    await env.LICENSE.put(KV_ENTITLEMENT_AT, String(nowSec())); // 鮮度（重要ゲートのダウングレード窓を縮小）
    // 緊急停止：ホストが blocked/deleted にしたアプリを取り込み済みでも削除する（キルスイッチ）。
    if (Array.isArray(data.revokedApps) && data.revokedApps.length) {
      const ph = data.revokedApps.map(() => "?").join(",");
      await env.DB.prepare(`DELETE FROM external_apps WHERE id IN (${ph})`).bind(...data.revokedApps).run().catch(() => {});
      // ローカル生成ドラフト（再申請・有効化の余地）も無効化（external_apps だけでは止まらないため）。
      await env.DB.prepare(`UPDATE app_drafts SET gate_status='blocked' WHERE id IN (${ph})`).bind(...data.revokedApps).run().catch(() => {});
    }
    // 標準同梱アプリの除外：ホストが除外した同梱アプリ id を KV に保存（導入集合の絞り込みに使う）。
    if (Array.isArray(data.disabledBuiltins)) {
      await env.LICENSE.put(KV_DISABLED_BUILTINS, JSON.stringify(data.disabledBuiltins)).catch(() => {});
    }
    // ホストからの対応返信（resolved/wontfix）を保存（利用者へ「対応済み」を表示）。
    if (Array.isArray(data.reportUpdates) && data.reportUpdates.length) {
      const { applyReportUpdates } = await import("./reports.ts");
      await applyReportUpdates(env, data.reportUpdates).catch(() => {});
    }
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

// ホストが「除外」した標準同梱アプリ id（統合チェックで受領・KVキャッシュ）。導入集合の絞り込みに使う。
export async function disabledBuiltins(env: Env): Promise<string[]> {
  try {
    const raw = await env.LICENSE?.get(KV_DISABLED_BUILTINS);
    if (!raw) return [];
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch { return []; }
}

// 重要ゲート（autopilot/agent）用：キャッシュが maxAgeSec を超えて古ければ一度だけ再ポーリングして最新化を試みる。
// オンライン＝最新へ／オフライン（Profile C）＝pollHost 失敗でキャッシュ据え置き＝継続。解約後の Pro 残存窓を縮小する。
export async function entitlementForGate(env: Env, maxAgeSec = 6 * 3600): Promise<Entitlement> {
  const at = Number(await env.LICENSE.get(KV_ENTITLEMENT_AT));
  if (!Number.isFinite(at) || nowSec() - at > maxAgeSec) {
    await pollHost(env).catch(() => null); // 失敗（オフライン）はキャッシュ継続
  }
  return cachedEntitlement(env);
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
// デプロイ環境が本番か。env.production の vars に ENVIRONMENT="production" を設定する。
export function isProduction(env: Env): boolean {
  return env.ENVIRONMENT === "production";
}

// MASTER_KEY 未投入を本番で検出したときの重大ブロック用エラー。
// 暗号処理（APIキー/PII/ファイル）を停止し、管理画面で警告できるようにする。
export class MasterKeyMissingError extends Error {
  constructor() {
    super("MASTER_KEY が本番で未設定です。`wrangler secret put MASTER_KEY --env production` で投入してください（KV自動生成は本番では禁止・§10.1）。");
    this.name = "MasterKeyMissingError";
  }
}

// 鍵の「保管」を KvPort 経由に分離（§14-3）。secret(env.MASTER_KEY) 優先。
// 本番（ENVIRONMENT=production）では secret 未投入時に KV 自動生成せずブロック（鍵と暗号文の同居回避・§10.1）。
// dev/test のみ zero-config 維持のため KV 自動生成を許可する。
// 演算（HKDF/AES-GCM）は shared の純粋関数のまま。保管先だけ Profile で差し替え可能。
async function resolveMasterKey(env: Env, kv: KvPort): Promise<string> {
  let k = await kv.get("master_key");
  if (!k) {
    if (isProduction(env)) {
      await logDiag(env, "error", "security", "MASTER_KEY が本番で未設定です。暗号処理をブロックしました。Worker Secret(MASTER_KEY)を投入してください（§10.1）。");
      throw new MasterKeyMissingError();
    }
    k = generateMasterKey();
    await kv.put("master_key", k);
    await kv.put("master_key_source", "kv-autogen");
    await logDiag(env, "warn", "security", "MASTER_KEY 未設定のため KV に自動生成しました（dev/test）。本番は Worker Secret(MASTER_KEY)の投入が必須です（鍵と暗号文の同居を避けるため）。");
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

// 鍵の保管状態（管理画面の診断表示用）。
// "secret"=Worker Secret運用（推奨）、"kv-autogen"=KV自動生成（dev/test）、
// "missing-prod"=本番でsecret未投入＝暗号処理ブロック中（重大）、"unknown"=不明。
export async function masterKeySource(env: Env): Promise<"secret" | "kv-autogen" | "missing-prod" | "unknown"> {
  if (env.MASTER_KEY) return "secret";
  const stored = (await env.LICENSE.get("master_key_source")) as "kv-autogen" | null;
  if (stored) return stored;
  if (isProduction(env)) return "missing-prod";
  return "unknown";
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
export async function deleteApiKey(env: Env, name: string): Promise<void> {
  await env.LICENSE.delete(KEY_PREFIX + name);
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
