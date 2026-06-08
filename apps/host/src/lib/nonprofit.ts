// NonProfit 申込・審査（ホスト）。承認で licenses.entitlement='nonprofit'（全機能・無料）。
import { nowSec } from "./host.ts";

export type NonprofitApp = { license_id: string; org_type: string | null; doc_ref: string | null; description: string | null; status: string; reason: string | null; reviewed_at: number | null; created_at: number };

// 申込時に審査レコードを作成（apply から呼ぶ）。
export async function createApplication(env: Env, licenseId: string, a: { orgType?: string; docRef?: string; description?: string }): Promise<void> {
  await env.DB.prepare("INSERT INTO nonprofit_applications (license_id,org_type,doc_ref,description,status,created_at) VALUES (?,?,?,?,'pending',?) ON CONFLICT(license_id) DO UPDATE SET org_type=excluded.org_type, doc_ref=excluded.doc_ref, description=excluded.description, status='pending', created_at=excluded.created_at")
    .bind(licenseId, a.orgType ?? null, a.docRef ?? null, a.description ?? null, nowSec()).run();
}

export async function listApplications(env: Env, status = "pending"): Promise<(NonprofitApp & { org_name?: string | null })[]> {
  const { results } = await env.DB.prepare(
    `SELECT n.*, c.org_name FROM nonprofit_applications n
     LEFT JOIN licenses l ON l.license_id=n.license_id LEFT JOIN customers c ON c.id=l.customer_id
     WHERE n.status=? ORDER BY n.created_at`,
  ).bind(status).all<NonprofitApp & { org_name: string | null }>();
  return results;
}

// 承認：審査ステータス＋ライセンスのエンタイトルメントを nonprofit に。
export async function approve(env: Env, licenseId: string): Promise<void> {
  await env.DB.prepare("UPDATE nonprofit_applications SET status='approved', reviewed_at=? WHERE license_id=?").bind(nowSec(), licenseId).run();
  await env.DB.prepare("UPDATE licenses SET entitlement='nonprofit' WHERE license_id=?").bind(licenseId).run();
}
export async function reject(env: Env, licenseId: string, reason: string): Promise<void> {
  await env.DB.prepare("UPDATE nonprofit_applications SET status='rejected', reason=?, reviewed_at=? WHERE license_id=?").bind(reason || null, nowSec(), licenseId).run();
}
