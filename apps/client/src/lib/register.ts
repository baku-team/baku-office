// レジ締め（日次/月次/年度末）。想定残高 vs 実査額の差異を記録し、原因をAIが推定（任意）。
// 差異は「現金過不足」科目で調整仕訳を起こせる（複式・任意）。
import { randomId } from "@baku-office/shared";
import { nowSec } from "./accounting.ts";
import { getAccountItemByCode } from "./account-items.ts";
import { createJournalEntry } from "./journal.ts";
import { estimateDiscrepancy } from "./media-ai.ts";

export type ClosureKind = "daily" | "monthly" | "year_end";

// 指定日(asOf)までの口座残高（opening_balance＋日付≤asOfの入出金・振替）。出納帳ロジックと整合。
export async function expectedBalance(env: Env, periodId: string, walletId: string, asOf: string): Promise<number> {
  const wallet = await env.DB.prepare("SELECT opening_balance FROM wallets WHERE id=?").bind(walletId).first<{ opening_balance: number }>();
  let bal = wallet?.opening_balance ?? 0;
  const { results } = await env.DB.prepare(
    "SELECT kind,wallet_id,counter_wallet_id,amount FROM transactions WHERE fiscal_period_id=? AND deleted_at IS NULL AND date<=? AND (wallet_id=? OR counter_wallet_id=?)",
  ).bind(periodId, asOf, walletId, walletId).all<{ kind: string; wallet_id: string; counter_wallet_id: string | null; amount: number }>();
  for (const t of results) {
    if (t.kind === "income" && t.wallet_id === walletId) bal += t.amount;
    else if (t.kind === "expense" && t.wallet_id === walletId) bal -= t.amount;
    else if (t.kind === "transfer") { if (t.wallet_id === walletId) bal -= t.amount; else if (t.counter_wallet_id === walletId) bal += t.amount; }
  }
  return bal;
}

// 直近取引（差異原因の推定材料）。
async function recentTx(env: Env, periodId: string, walletId: string, asOf: string): Promise<{ date: string; kind: string; amount: number; description: string | null }[]> {
  return (await env.DB.prepare(
    "SELECT date,kind,amount,description FROM transactions WHERE fiscal_period_id=? AND deleted_at IS NULL AND date<=? AND (wallet_id=? OR counter_wallet_id=?) ORDER BY date DESC, created_at DESC LIMIT 30",
  ).bind(periodId, asOf, walletId, walletId).all<{ date: string; kind: string; amount: number; description: string | null }>()).results;
}

export type ClosureInput = { fiscal_period_id: string; wallet_id: string; kind: ClosureKind; period_label: string; asOf: string; counted_amount: number; closed_by?: string | null };
export async function createClosure(env: Env, c: ClosureInput): Promise<{ id: string; expected: number; difference: number; ai_reason: string | null }> {
  const expected = await expectedBalance(env, c.fiscal_period_id, c.wallet_id, c.asOf);
  const difference = expected - c.counted_amount; // プラス=実査が想定より不足
  let ai_reason: string | null = null;
  if (difference !== 0) {
    const recent = await recentTx(env, c.fiscal_period_id, c.wallet_id, c.asOf);
    ai_reason = await estimateDiscrepancy(env, difference, recent).catch(() => null);
  }
  const id = randomId();
  await env.DB.prepare(
    "INSERT INTO register_closures (id,fiscal_period_id,wallet_id,kind,period_label,expected_amount,counted_amount,difference,ai_reason,closed_by,closed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).bind(id, c.fiscal_period_id, c.wallet_id, c.kind, c.period_label, expected, c.counted_amount, difference, ai_reason, c.closed_by ?? null, nowSec()).run();
  return { id, expected, difference, ai_reason };
}

export async function listClosures(env: Env, periodId: string): Promise<Record<string, unknown>[]> {
  return (await env.DB.prepare(
    "SELECT * FROM register_closures WHERE fiscal_period_id=? ORDER BY closed_at DESC LIMIT 50",
  ).bind(periodId).all<Record<string, unknown>>()).results;
}

// 差異を「現金過不足」で調整する仕訳を起こす（複式・任意）。帳簿残高を実査額に合わせる。
export async function postCashOverShort(env: Env, closureId: string, date: string): Promise<string | null> {
  const c = await env.DB.prepare("SELECT * FROM register_closures WHERE id=?").bind(closureId).first<{ id: string; fiscal_period_id: string; wallet_id: string; difference: number; adjustment_entry_id: string | null }>();
  if (!c || c.difference === 0 || c.adjustment_entry_id) return null;
  const wallet = await env.DB.prepare("SELECT account_item_id FROM wallets WHERE id=?").bind(c.wallet_id).first<{ account_item_id: string | null }>();
  const overShort = await getAccountItemByCode(env, "195");
  if (!wallet?.account_item_id || !overShort) return null;
  const amount = Math.abs(c.difference);
  // difference>0（実査が不足＝帳簿の現金が多い）→ 現金を減らす：借方 現金過不足 / 貸方 現金。
  const lines = c.difference > 0
    ? [{ side: "debit" as const, account_item_id: overShort.id, amount }, { side: "credit" as const, account_item_id: wallet.account_item_id, amount }]
    : [{ side: "debit" as const, account_item_id: wallet.account_item_id, amount }, { side: "credit" as const, account_item_id: overShort.id, amount }];
  const entryId = await createJournalEntry(env, { fiscal_period_id: c.fiscal_period_id, date, description: "レジ締め：現金過不足の調整", source: "closure", source_ref: closureId, lines });
  await env.DB.prepare("UPDATE register_closures SET adjustment_entry_id=? WHERE id=?").bind(entryId, closureId).run();
  return entryId;
}
