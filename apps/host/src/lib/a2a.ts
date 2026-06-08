// A2A ブローカー（ホスト）：団体間接続の作成・同意・一覧と、署名つき中継。
// 認証＝相手ライセンスの実在/有効＋接続の active。実行面は相手 client の /api/a2a/inbound（ctx.apps.call 経由・権限検査つき）。
import { randomId, signEnvelope, importSignKey, openLicense, type Envelope } from "@baku-office/shared";
import { nowSec, signingJwk } from "./host.ts";

// ライセンストークン（client が保持）→ licenseId を検証して取り出す。なりすまし防止。
export async function licenseFromToken(env: Env, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  let envlp: Envelope;
  try { envlp = JSON.parse(atob(token)) as Envelope; } catch { return null; }
  const payload = await openLicense(signingJwk(env), envlp, nowSec());
  return payload?.licenseId ?? null;
}

const RATE_PER_MIN = 60; // 1接続あたりの中継上限/分（暴走・ループ防止）。

export type ConnRow = { id: string; org_a_license: string; org_b_license: string | null; status: string; label_a: string | null; label_b: string | null };

// 接続を作成（招待コード発行）。作成側＝org_a。
export async function createConnection(env: Env, fromLicense: string, label?: string): Promise<string> {
  const id = randomId(8);
  const now = nowSec();
  await env.DB.prepare("INSERT INTO a2a_connections (id,org_a_license,status,label_a,created_at,updated_at) VALUES (?,?,'pending',?,?,?)")
    .bind(id, fromLicense, label ?? null, now, now).run();
  return id;
}

// 招待コードで参加（相互同意成立＝active）。自分自身・二重参加は不可。
export async function acceptConnection(env: Env, code: string, byLicense: string, label?: string): Promise<{ ok: boolean; error?: string }> {
  const c = await env.DB.prepare("SELECT id,org_a_license,org_b_license,status FROM a2a_connections WHERE id=?").bind(code).first<ConnRow>();
  if (!c) return { ok: false, error: "接続コードが見つかりません" };
  if (c.status !== "pending" || c.org_b_license) return { ok: false, error: "この接続は既に確定済みです" };
  if (c.org_a_license === byLicense) return { ok: false, error: "自団体の接続コードには参加できません" };
  await env.DB.prepare("UPDATE a2a_connections SET org_b_license=?, label_b=?, status='active', updated_at=? WHERE id=?")
    .bind(byLicense, label ?? null, nowSec(), code).run();
  return { ok: true };
}

export async function listConnections(env: Env, license: string): Promise<{ id: string; partner: string | null; status: string; role: "a" | "b" }[]> {
  const { results } = await env.DB.prepare("SELECT id,org_a_license,org_b_license,status,label_a,label_b FROM a2a_connections WHERE org_a_license=? OR org_b_license=? ORDER BY created_at DESC")
    .bind(license, license).all<ConnRow>();
  return results.map((c) => c.org_a_license === license
    ? { id: c.id, partner: c.org_b_license, status: c.status, role: "a" as const }
    : { id: c.id, partner: c.org_a_license, status: c.status, role: "b" as const });
}

export async function revokeConnection(env: Env, code: string, byLicense: string): Promise<void> {
  await env.DB.prepare("UPDATE a2a_connections SET status='revoked', updated_at=? WHERE id=? AND (org_a_license=? OR org_b_license=?)")
    .bind(nowSec(), code, byLicense, byLicense).run();
}

async function audit(env: Env, connId: string | null, from: string, to: string, action: string, status: string): Promise<void> {
  await env.DB.prepare("INSERT INTO a2a_audit (id,conn_id,from_license,to_license,action,status,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(randomId(8), connId, from, to, action, status, nowSec()).run().catch(() => {});
}

// 中継：from→to へ署名エンベロープを送り、相手 client の inbound 結果を返す。
export async function relay(env: Env, fromLicense: string, toLicense: string, appId: string, action: string, args: Record<string, unknown>): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  // active な接続（from と to のペア）を確認。
  const c = await env.DB.prepare("SELECT id,status FROM a2a_connections WHERE status='active' AND ((org_a_license=? AND org_b_license=?) OR (org_a_license=? AND org_b_license=?)) LIMIT 1")
    .bind(fromLicense, toLicense, toLicense, fromLicense).first<{ id: string; status: string }>();
  if (!c) { await audit(env, null, fromLicense, toLicense, `${appId}.${action}`, "denied"); return { ok: false, error: "有効な接続がありません（相互同意が必要です）" }; }
  // レート制限（接続×分）。
  const since = nowSec() - 60;
  const cnt = await env.DB.prepare("SELECT COUNT(*) AS n FROM a2a_audit WHERE conn_id=? AND created_at>=?").bind(c.id, since).first<{ n: number }>();
  if ((cnt?.n ?? 0) >= RATE_PER_MIN) { await audit(env, c.id, fromLicense, toLicense, `${appId}.${action}`, "denied"); return { ok: false, error: "レート上限に達しました。しばらく待って再試行してください" }; }
  // 宛先 client の URL。
  const to = await env.DB.prepare("SELECT deploy_url FROM licenses WHERE license_id=? AND status='active'").bind(toLicense).first<{ deploy_url: string | null }>();
  if (!to?.deploy_url) { await audit(env, c.id, fromLicense, toLicense, `${appId}.${action}`, "error"); return { ok: false, error: "相手のデプロイURLが未登録です" }; }
  const envlp = await signEnvelope(await importSignKey(signingJwk(env)), { from: fromLicense, appId, action, args, exp: nowSec() + 60 });
  try {
    const r = await fetch(to.deploy_url.replace(/\/$/, "") + "/api/a2a/inbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envlp) });
    const data = (await r.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; error?: string };
    await audit(env, c.id, fromLicense, toLicense, `${appId}.${action}`, r.ok && data.ok ? "ok" : "error");
    if (!r.ok || !data.ok) return { ok: false, error: data.error ?? `相手が応答しませんでした（${r.status}）` };
    return { ok: true, result: data.result };
  } catch (e) {
    await audit(env, c.id, fromLicense, toLicense, `${appId}.${action}`, "error");
    return { ok: false, error: "相手へ到達できません（カスタムドメイン等で到達可能である必要があります）：" + ((e as Error).message ?? "") };
  }
}
