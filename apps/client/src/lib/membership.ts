// 会員管理（会費）。氏名・連絡先・会費支払状況・支払い日時・ステータス変更日・任意項目（JSON）。
import { randomId } from "@baku-office/shared";
import { nowSec } from "./accounting.ts";

export type Member = {
  id: string; name: string; contact: string | null; fee_status: string;
  paid_at: string | null; status_changed_at: number | null; extra: string | null;
  stripe_customer: string | null; created_at: number; updated_at: number;
};
export const FEE_STATUSES = ["paid", "unpaid", "exempt", "withdrawn"] as const;
export const FEE_LABEL: Record<string, string> = { paid: "支払済", unpaid: "未払い", exempt: "免除", withdrawn: "退会" };

export async function listMembers(env: Env, q = ""): Promise<Member[]> {
  if (q) return (await env.DB.prepare("SELECT * FROM membership WHERE name LIKE ? OR contact LIKE ? ORDER BY created_at DESC LIMIT 500").bind("%" + q + "%", "%" + q + "%").all<Member>()).results;
  return (await env.DB.prepare("SELECT * FROM membership ORDER BY created_at DESC LIMIT 500").all<Member>()).results;
}

export async function createMember(env: Env, a: { name: string; contact?: string; fee_status?: string; paid_at?: string; extra?: string; stripe_customer?: string }): Promise<string> {
  const id = randomId();
  const now = nowSec();
  const fee = FEE_STATUSES.includes((a.fee_status ?? "unpaid") as typeof FEE_STATUSES[number]) ? a.fee_status! : "unpaid";
  await env.DB.prepare(
    "INSERT INTO membership (id,name,contact,fee_status,paid_at,status_changed_at,extra,stripe_customer,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).bind(id, a.name, a.contact ?? null, fee, a.paid_at ?? null, now, a.extra ?? null, a.stripe_customer ?? null, now, now).run();
  return id;
}

// 部分更新。fee_status が変わったら status_changed_at を更新（支払済への変更で paid_at 未指定なら現在時刻）。
export async function updateMember(env: Env, id: string, patch: { name?: string; contact?: string; fee_status?: string; paid_at?: string; extra?: string }): Promise<void> {
  const cur = await env.DB.prepare("SELECT fee_status FROM membership WHERE id=?").bind(id).first<{ fee_status: string }>();
  if (!cur) return;
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.name !== undefined) { sets.push("name=?"); binds.push(patch.name); }
  if (patch.contact !== undefined) { sets.push("contact=?"); binds.push(patch.contact || null); }
  if (patch.extra !== undefined) { sets.push("extra=?"); binds.push(patch.extra || null); }
  let paidAt = patch.paid_at;
  if (patch.fee_status !== undefined && FEE_STATUSES.includes(patch.fee_status as typeof FEE_STATUSES[number]) && patch.fee_status !== cur.fee_status) {
    sets.push("fee_status=?", "status_changed_at=?"); binds.push(patch.fee_status, nowSec());
    if (patch.fee_status === "paid" && paidAt === undefined) paidAt = new Date().toISOString().slice(0, 16).replace("T", " ");
  }
  if (paidAt !== undefined) { sets.push("paid_at=?"); binds.push(paidAt || null); }
  if (!sets.length) return;
  sets.push("updated_at=?"); binds.push(nowSec());
  binds.push(id);
  await env.DB.prepare(`UPDATE membership SET ${sets.join(",")} WHERE id=?`).bind(...binds).run();
}

export async function deleteMember(env: Env, id: string): Promise<void> {
  await env.DB.prepare("DELETE FROM membership WHERE id=?").bind(id).run();
}

export async function memberStats(env: Env): Promise<{ total: number; paid: number; unpaid: number }> {
  try {
    const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM membership").first<{ n: number }>())?.n ?? 0;
    const paid = (await env.DB.prepare("SELECT COUNT(*) AS n FROM membership WHERE fee_status='paid'").first<{ n: number }>())?.n ?? 0;
    const unpaid = (await env.DB.prepare("SELECT COUNT(*) AS n FROM membership WHERE fee_status='unpaid'").first<{ n: number }>())?.n ?? 0;
    return { total, paid, unpaid };
  } catch { return { total: 0, paid: 0, unpaid: 0 }; }
}
