// 固定資産と減価償却。定額法（straight_line）／定率法（declining_balance）。
// 減価償却費の計上は複式仕訳（借方:減価償却費／貸方:資産科目）として記録し、試算表・弥生出力に反映。
import { randomId } from "@baku-office/shared";
import { nowSec } from "./accounting.ts";
import { getAccountItemByCode } from "./account-items.ts";
import { createJournalEntry } from "./journal.ts";

export type DepMethod = "straight_line" | "declining_balance";
export type FixedAsset = {
  id: string; name: string; acquired_date: string; acquisition_cost: number; useful_life_years: number;
  method: DepMethod; residual_value: number; rate: number | null;
  asset_account_item_id: string | null; expense_account_item_id: string | null;
  fiscal_period_id: string | null; status: string; notes: string | null;
};

// 償却スケジュール（純粋関数）。年ごとの償却額と期末簿価。最終年は残存価額で調整。
export function depreciationSchedule(a: Pick<FixedAsset, "acquisition_cost" | "useful_life_years" | "method" | "residual_value" | "rate">): { year: number; amount: number; bookValue: number }[] {
  const life = Math.max(1, Math.floor(a.useful_life_years));
  const residual = Math.max(0, Math.floor(a.residual_value));
  const cost = Math.max(0, Math.floor(a.acquisition_cost));
  const out: { year: number; amount: number; bookValue: number }[] = [];
  let bv = cost;
  if (a.method === "declining_balance") {
    const r = a.rate && a.rate > 0 ? a.rate : 2 / life; // 既定は定率200%（簡易）
    for (let y = 0; y < life; y++) {
      let amt = Math.floor(bv * r);
      if (y === life - 1 || bv - amt < residual) amt = bv - residual;
      if (amt < 0) amt = 0;
      bv -= amt;
      out.push({ year: y + 1, amount: amt, bookValue: bv });
    }
  } else {
    const base = cost - residual;
    const annual = Math.floor(base / life);
    for (let y = 0; y < life; y++) {
      const amt = y === life - 1 ? base - annual * (life - 1) : annual;
      bv -= amt;
      out.push({ year: y + 1, amount: amt, bookValue: bv });
    }
  }
  return out;
}

export async function createFixedAsset(env: Env, a: {
  name: string; acquired_date: string; acquisition_cost: number; useful_life_years: number;
  method: DepMethod; residual_value?: number; rate?: number | null;
  asset_account_item_id?: string | null; expense_account_item_id?: string | null; fiscal_period_id?: string | null; notes?: string | null;
}): Promise<string> {
  const id = randomId();
  const now = nowSec();
  // 科目未指定なら既定（資産=工具器具備品170／費用=減価償却費640）。
  const assetAcc = a.asset_account_item_id ?? (await getAccountItemByCode(env, "170"))?.id ?? null;
  const expenseAcc = a.expense_account_item_id ?? (await getAccountItemByCode(env, "640"))?.id ?? null;
  await env.DB.prepare(
    `INSERT INTO fixed_assets (id,name,acquired_date,acquisition_cost,useful_life_years,method,residual_value,rate,asset_account_item_id,expense_account_item_id,fiscal_period_id,status,notes,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)`,
  ).bind(id, a.name, a.acquired_date, Math.round(a.acquisition_cost), Math.floor(a.useful_life_years), a.method, Math.round(a.residual_value ?? 0), a.rate ?? null, assetAcc, expenseAcc, a.fiscal_period_id ?? null, a.notes ?? null, now, now).run();
  return id;
}

export async function listFixedAssets(env: Env): Promise<FixedAsset[]> {
  return (await env.DB.prepare("SELECT * FROM fixed_assets WHERE deleted_at IS NULL ORDER BY acquired_date, created_at").all<FixedAsset>()).results;
}
export async function softDeleteFixedAsset(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE fixed_assets SET deleted_at=? WHERE id=?").bind(nowSec(), id).run();
}
export async function depreciationCount(env: Env, assetId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM depreciation_entries WHERE asset_id=?").bind(assetId).first<{ n: number }>();
  return r?.n ?? 0;
}

// 当期分の減価償却費を計上（借方:減価償却費／貸方:資産科目）。period_label UNIQUE で二重計上を防止。
// 既に当該 period_label で計上済み、または償却完了なら null。
export async function postDepreciation(env: Env, assetId: string, periodId: string, periodLabel: string, date: string): Promise<string | null> {
  const asset = await env.DB.prepare("SELECT * FROM fixed_assets WHERE id=? AND deleted_at IS NULL").bind(assetId).first<FixedAsset>();
  if (!asset) return null;
  const dup = await env.DB.prepare("SELECT id FROM depreciation_entries WHERE asset_id=? AND period_label=?").bind(assetId, periodLabel).first<{ id: string }>();
  if (dup) return null;
  const idx = await depreciationCount(env, assetId); // 既計上回数＝次の年インデックス
  const sched = depreciationSchedule(asset);
  if (idx >= sched.length) return null; // 償却完了
  const amount = sched[idx].amount;
  if (amount <= 0) return null;
  if (!asset.expense_account_item_id || !asset.asset_account_item_id) return null;
  const entryId = await createJournalEntry(env, {
    fiscal_period_id: periodId, date, description: `減価償却：${asset.name}（${periodLabel}）`,
    source: "depreciation", source_ref: assetId,
    lines: [
      { side: "debit", account_item_id: asset.expense_account_item_id, amount },
      { side: "credit", account_item_id: asset.asset_account_item_id, amount },
    ],
  });
  await env.DB.prepare("INSERT INTO depreciation_entries (id,asset_id,fiscal_period_id,period_label,amount,journal_entry_id,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(randomId(), assetId, periodId, periodLabel, amount, entryId, nowSec()).run();
  return entryId;
}
