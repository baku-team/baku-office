// 会員管理（会費）。氏名・連絡先・会費支払状況・支払い日時・ステータス変更日・任意項目（JSON）。
import { randomId } from "@baku-office/shared";
import { nowSec, ensureSeed, currentPeriod, createTx, listWallets, softDeleteTx } from "./accounting.ts";

export type Member = {
  id: string; name: string; contact: string | null; fee_status: string;
  paid_at: string | null; status_changed_at: number | null; extra: string | null;
  fee_amount: number | null; rank: string | null; fee_tx_id: string | null;
  stripe_customer: string | null; created_at: number; updated_at: number;
};

// 会費収入を会計へ自動計上。会費収入カテゴリ・既定口座（口座があれば優先・無ければ先頭）へ income 取引を作る。
// 取引IDを返す（前提が未整備なら null＝計上スキップし会員保存は止めない）。
async function postFeeIncome(env: Env, a: { name: string; amount: number; date?: string }): Promise<string | null> {
  try {
    await ensureSeed(env); // 会計期・口座・会費収入カテゴリを冪等に用意。
    const period = await currentPeriod(env);
    if (!period) return null;
    const cat = await env.DB.prepare("SELECT id FROM categories WHERE name='会費収入' AND kind='income' LIMIT 1").first<{ id: string }>();
    const wallets = await listWallets(env);
    const wallet = wallets.find((w) => w.type === "bank") ?? wallets[0];
    if (!wallet) return null;
    const date = (a.date && /^\d{4}-\d{2}-\d{2}/.test(a.date) ? a.date.slice(0, 10) : new Date().toISOString().slice(0, 10));
    return await createTx(env, {
      fiscal_period_id: period.id, date, wallet_id: wallet.id, kind: "income",
      category_id: cat?.id ?? null, amount: Math.round(a.amount), description: `会費：${a.name}`, counter_wallet_id: null,
    });
  } catch { return null; }
}
export const FEE_STATUSES = ["paid", "unpaid", "exempt", "withdrawn"] as const;
export const FEE_LABEL: Record<string, string> = { paid: "支払済", unpaid: "未払い", exempt: "免除", withdrawn: "退会" };

export async function listMembers(env: Env, q = ""): Promise<Member[]> {
  if (q) return (await env.DB.prepare("SELECT * FROM membership WHERE name LIKE ? OR contact LIKE ? ORDER BY created_at DESC LIMIT 500").bind("%" + q + "%", "%" + q + "%").all<Member>()).results;
  return (await env.DB.prepare("SELECT * FROM membership ORDER BY created_at DESC LIMIT 500").all<Member>()).results;
}

const toAmount = (v: unknown): number | null => { const n = Math.round(Number(v)); return Number.isFinite(n) && n > 0 ? n : null; };

export async function createMember(env: Env, a: { name: string; contact?: string; fee_status?: string; paid_at?: string; extra?: string; fee_amount?: unknown; rank?: string; stripe_customer?: string }): Promise<string> {
  const id = randomId();
  const now = nowSec();
  const fee = FEE_STATUSES.includes((a.fee_status ?? "unpaid") as typeof FEE_STATUSES[number]) ? a.fee_status! : "unpaid";
  const amount = toAmount(a.fee_amount);
  // 追加時にすでに支払済＋金額ありなら会計へ計上。
  const txId = fee === "paid" && amount ? await postFeeIncome(env, { name: a.name, amount, date: a.paid_at }) : null;
  await env.DB.prepare(
    "INSERT INTO membership (id,name,contact,fee_status,paid_at,status_changed_at,extra,fee_amount,rank,fee_tx_id,stripe_customer,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(id, a.name, a.contact ?? null, fee, a.paid_at ?? null, now, a.extra ?? null, amount, a.rank?.trim() || null, txId, a.stripe_customer ?? null, now, now).run();
  return id;
}

// 部分更新。fee_status が変わったら status_changed_at を更新（支払済への変更で paid_at 未指定なら現在時刻）。
// 支払済への遷移で会費金額があれば会計へ自動計上、支払済から外れたら計上を取り消す（fee_tx_id で二重計上防止）。
export async function updateMember(env: Env, id: string, patch: { name?: string; contact?: string; fee_status?: string; paid_at?: string; extra?: string; fee_amount?: unknown; rank?: string }): Promise<void> {
  const cur = await env.DB.prepare("SELECT name,fee_status,fee_amount,fee_tx_id FROM membership WHERE id=?").bind(id).first<{ name: string; fee_status: string; fee_amount: number | null; fee_tx_id: string | null }>();
  if (!cur) return;
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (patch.name !== undefined) { sets.push("name=?"); binds.push(patch.name); }
  if (patch.contact !== undefined) { sets.push("contact=?"); binds.push(patch.contact || null); }
  if (patch.extra !== undefined) { sets.push("extra=?"); binds.push(patch.extra || null); }
  if (patch.rank !== undefined) { sets.push("rank=?"); binds.push(patch.rank.trim() || null); }
  const newAmount = patch.fee_amount !== undefined ? toAmount(patch.fee_amount) : cur.fee_amount;
  if (patch.fee_amount !== undefined) { sets.push("fee_amount=?"); binds.push(newAmount); }
  let paidAt = patch.paid_at;
  const becamePaid = patch.fee_status !== undefined && FEE_STATUSES.includes(patch.fee_status as typeof FEE_STATUSES[number]) && patch.fee_status !== cur.fee_status && patch.fee_status === "paid";
  const leftPaid = patch.fee_status !== undefined && patch.fee_status !== cur.fee_status && cur.fee_status === "paid";
  if (patch.fee_status !== undefined && FEE_STATUSES.includes(patch.fee_status as typeof FEE_STATUSES[number]) && patch.fee_status !== cur.fee_status) {
    sets.push("fee_status=?", "status_changed_at=?"); binds.push(patch.fee_status, nowSec());
    if (patch.fee_status === "paid" && paidAt === undefined) paidAt = new Date().toISOString().slice(0, 16).replace("T", " ");
  }
  if (paidAt !== undefined) { sets.push("paid_at=?"); binds.push(paidAt || null); }
  // 会計連携：支払済へ→計上、支払済から外す→取り消し。
  let feeTxChange: { col: true; val: string | null } | null = null;
  if (becamePaid && newAmount && !cur.fee_tx_id) {
    const txId = await postFeeIncome(env, { name: patch.name ?? cur.name, amount: newAmount, date: paidAt });
    if (txId) feeTxChange = { col: true, val: txId };
  } else if (leftPaid && cur.fee_tx_id) {
    await softDeleteTx(env, cur.fee_tx_id).catch(() => {});
    feeTxChange = { col: true, val: null };
  }
  if (feeTxChange) { sets.push("fee_tx_id=?"); binds.push(feeTxChange.val); }
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
