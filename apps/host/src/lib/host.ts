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

// 統合チェック（§13.1）：エンタイトルメント＋最新版＋通知＋失効アプリ（キルスイッチ）
// ＋除外された標準同梱アプリ＋この団体への対応返信。
export async function buildCheck(env: Env, entitlement: Entitlement, licenseId?: string): Promise<CheckResponse> {
  const { revokedAppIds, disabledBuiltinIds } = await import("./registry.ts");
  const { results } = await env.DB.prepare(
    "SELECT id, severity, body FROM notices WHERE active = 1 ORDER BY created_at DESC LIMIT 20",
  ).all<{ id: string; severity: string; body: string }>();
  // blocked/deleted のアプリ id をクライアントへ配り、取り込み済みでも無効化・撤去させる（緊急停止）。
  const revokedApps = await revokedAppIds(env);
  // ホストが「除外」した標準同梱アプリ（登録/除外）。
  const disabledBuiltins = await disabledBuiltinIds(env);
  // この団体が送った報告への対応返信（resolved/wontfix）。
  let reportUpdates: CheckResponse["reportUpdates"] = undefined;
  if (licenseId) {
    const { reportUpdatesFor } = await import("./reports.ts");
    const ups = await reportUpdatesFor(env, licenseId).catch(() => []);
    if (ups.length) reportUpdates = ups;
  }
  return {
    entitlement,
    latestVersion: env.LATEST_VERSION ?? "0.0.0",
    notices: results.map((n) => ({ id: n.id, severity: n.severity as "info" | "important" | "critical", body: n.body })),
    revokedApps,
    disabledBuiltins,
    reportUpdates,
  };
}

// A2A 等でホストがサーバーサイド fetch する宛先 URL の安全性検査（SSRF対策）。
// https 必須＋IPリテラル・内部ホスト名・credentials付き・ドットなし内部名を拒否。
// カスタムドメイン運用を壊さないため allowlist は採らない。
// 残存リスク：DNS rebinding（例 127.0.0.1.nip.io＝FQDNだが内部IPに解決）は名前解決後IP検査が必要で
//   Workers fetch では解決後IPを取れないため完全には防げない。呼び出し側は redirect:"manual" を併用すること。
export function isSafeDeployUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false; // credentials 付きURL（user:pass@host）は拒否
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(":")) return false; // IPv4/IPv6 リテラル拒否
  if (!h.includes(".") || h.endsWith(".")) return false; // FQDN 必須（ドットなし内部名・末尾ドット拒否）
  return true;
}

// ホスト管理操作の監査記録（誰がいつ何を）。失敗は握り潰す（監査が本処理を止めない）。
export async function recordAudit(env: Env, actor: string, action: string, target: string | null, detail?: string | null): Promise<void> {
  await env.DB.prepare("INSERT INTO host_audit (id,actor_email,action,target,detail,created_at) VALUES (?,?,?,?,?,?)")
    .bind(randomId(8), actor || "unknown", action, target ?? null, detail ?? null, nowSec()).run().catch(() => {});
}
export type AuditRow = { actor_email: string | null; action: string; target: string | null; detail: string | null; created_at: number };
export async function listAudit(env: Env, limit = 200): Promise<AuditRow[]> {
  return (await env.DB.prepare("SELECT actor_email,action,target,detail,created_at FROM host_audit ORDER BY created_at DESC LIMIT ?").bind(limit).all<AuditRow>()).results;
}

export { randomId };
