// 複式仕訳。単式取引（transactions）は橋渡し関数で都度仕訳化し、journal_entries には
// 手動仕訳・減価償却・レジ締め差異のみ保存（二重記帳の回避）。出力（弥生/将来freee）と試算表は
// buildEntriesForPeriod で「橋渡し仕訳＋保存仕訳」を統合した仕訳ベースで行う。
import { randomId } from "@baku-office/shared";
import { nowSec, type Tx } from "./accounting.ts";
import { listAccountItems, type AccountItem } from "./account-items.ts";

export type Side = "debit" | "credit";
export type JournalLine = { side: Side; account_item_id: string; amount: number; memo?: string | null };
export type LedgerLine = { side: Side; account_item_id: string; code: string; name: string; amount: number; memo: string | null };
export type LedgerEntry = { id: string; date: string; description: string | null; source: string; lines: LedgerLine[] };

// 借方合計＝貸方合計、かつ正、を検証して保存。複式の整合性を構造的に担保。
export async function createJournalEntry(env: Env, e: {
  fiscal_period_id: string; date: string; description?: string | null;
  source?: string; source_ref?: string | null; created_by?: string | null; lines: JournalLine[];
}): Promise<string> {
  const debit = e.lines.filter((l) => l.side === "debit").reduce((s, l) => s + l.amount, 0);
  const credit = e.lines.filter((l) => l.side === "credit").reduce((s, l) => s + l.amount, 0);
  if (e.lines.length < 2 || debit <= 0 || debit !== credit) {
    throw new Error(`仕訳の借方(${debit})と貸方(${credit})が一致しません`);
  }
  const id = randomId();
  const now = nowSec();
  await env.DB.prepare(
    "INSERT INTO journal_entries (id,fiscal_period_id,date,description,source,source_ref,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).bind(id, e.fiscal_period_id, e.date, e.description ?? null, e.source ?? "manual", e.source_ref ?? null, e.created_by ?? null, now, now).run();
  let i = 0;
  for (const l of e.lines) {
    await env.DB.prepare(
      "INSERT INTO journal_lines (id,entry_id,side,account_item_id,amount,memo,sort_order) VALUES (?,?,?,?,?,?,?)",
    ).bind(randomId(), id, l.side, l.account_item_id, l.amount, l.memo ?? null, i++).run();
  }
  return id;
}

export async function softDeleteJournalEntry(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE journal_entries SET deleted_at=? WHERE id=?").bind(nowSec(), id).run();
}

// 単式取引→仕訳の橋渡し（純粋関数・保存しない）。
// income: 借方=口座 / 貸方=収益科目、expense: 借方=費用科目 / 貸方=口座、transfer: 借方=振替先口座 / 貸方=振替元口座。
export function txToJournalLines(tx: Pick<Tx, "kind" | "amount">, acc: { walletAccId: string; counterAccId?: string | null; categoryAccId?: string | null }): JournalLine[] {
  const amt = tx.amount;
  if (tx.kind === "income") return [{ side: "debit", account_item_id: acc.walletAccId, amount: amt }, { side: "credit", account_item_id: acc.categoryAccId || acc.walletAccId, amount: amt }];
  if (tx.kind === "expense") return [{ side: "debit", account_item_id: acc.categoryAccId || acc.walletAccId, amount: amt }, { side: "credit", account_item_id: acc.walletAccId, amount: amt }];
  // transfer
  return [{ side: "debit", account_item_id: acc.counterAccId || acc.walletAccId, amount: amt }, { side: "credit", account_item_id: acc.walletAccId, amount: amt }];
}

type Maps = { items: Map<string, AccountItem>; byCode: Map<string, AccountItem>; walletAcc: Map<string, string | null>; catAcc: Map<string, string | null> };
async function loadMaps(env: Env): Promise<Maps> {
  const items = await listAccountItems(env);
  const byId = new Map(items.map((a) => [a.id, a]));
  const byCode = new Map(items.map((a) => [a.code, a]));
  const wallets = (await env.DB.prepare("SELECT id,account_item_id FROM wallets").all<{ id: string; account_item_id: string | null }>()).results;
  const cats = (await env.DB.prepare("SELECT id,account_item_id FROM categories").all<{ id: string; account_item_id: string | null }>()).results;
  return { items: byId, byCode, walletAcc: new Map(wallets.map((w) => [w.id, w.account_item_id])), catAcc: new Map(cats.map((c) => [c.id, c.account_item_id])) };
}
const toLedgerLines = (lines: JournalLine[], items: Map<string, AccountItem>): LedgerLine[] =>
  lines.map((l) => { const a = items.get(l.account_item_id); return { side: l.side, account_item_id: l.account_item_id, code: a?.code ?? "", name: a?.name ?? "(不明)", amount: l.amount, memo: l.memo ?? null }; });

// 当期の仕訳一覧（橋渡し＋保存仕訳）。試算表・弥生CSV・将来freee出力の共通入力。
export async function buildEntriesForPeriod(env: Env, periodId: string): Promise<LedgerEntry[]> {
  const m = await loadMaps(env);
  const fallbackWallet = m.byCode.get("111")?.id ?? "";
  const fallbackIncome = m.byCode.get("501")?.id ?? fallbackWallet;
  const fallbackExpense = m.byCode.get("690")?.id ?? fallbackWallet;
  const out: LedgerEntry[] = [];
  // 単式取引を橋渡し。
  const txs = (await env.DB.prepare(
    "SELECT id,kind,amount,date,description,wallet_id,counter_wallet_id,category_id FROM transactions WHERE fiscal_period_id=? AND deleted_at IS NULL ORDER BY date, created_at",
  ).bind(periodId).all<Tx & { wallet_id: string; counter_wallet_id: string | null; category_id: string | null }>()).results;
  for (const t of txs) {
    const walletAccId = (m.walletAcc.get(t.wallet_id) ?? null) || fallbackWallet;
    const counterAccId = t.counter_wallet_id ? (m.walletAcc.get(t.counter_wallet_id) ?? null) || fallbackWallet : null;
    const categoryAccId = t.category_id ? (m.catAcc.get(t.category_id) ?? null) || (t.kind === "income" ? fallbackIncome : fallbackExpense) : (t.kind === "income" ? fallbackIncome : fallbackExpense);
    const lines = txToJournalLines(t, { walletAccId, counterAccId, categoryAccId });
    out.push({ id: t.id, date: t.date, description: t.description ?? null, source: "tx", lines: toLedgerLines(lines, m.items) });
  }
  // 保存済み仕訳（手動・減価償却・レジ締め差異など。tx由来は橋渡しと重複するため除外）。
  const entries = (await env.DB.prepare(
    "SELECT id,date,description,source FROM journal_entries WHERE fiscal_period_id=? AND deleted_at IS NULL AND source != 'tx' ORDER BY date, created_at",
  ).bind(periodId).all<{ id: string; date: string; description: string | null; source: string }>()).results;
  for (const e of entries) {
    const ls = (await env.DB.prepare("SELECT side,account_item_id,amount,memo FROM journal_lines WHERE entry_id=? ORDER BY sort_order").bind(e.id).all<JournalLine>()).results;
    out.push({ id: e.id, date: e.date, description: e.description, source: e.source, lines: toLedgerLines(ls, m.items) });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

// 試算表（最小）：勘定科目ごとに借方・貸方を集計し、通常残高側で残高を出す。
export async function trialBalance(env: Env, periodId: string): Promise<{ code: string; name: string; major: string; debit: number; credit: number; balance: number }[]> {
  const m = await loadMaps(env);
  const entries = await buildEntriesForPeriod(env, periodId);
  const agg = new Map<string, { debit: number; credit: number }>();
  for (const e of entries) for (const l of e.lines) {
    const cur = agg.get(l.account_item_id) ?? { debit: 0, credit: 0 };
    if (l.side === "debit") cur.debit += l.amount; else cur.credit += l.amount;
    agg.set(l.account_item_id, cur);
  }
  const rows: { code: string; name: string; major: string; debit: number; credit: number; balance: number }[] = [];
  for (const [id, v] of agg) {
    const a = m.items.get(id);
    if (!a) continue;
    const balance = a.normal_balance === "debit" ? v.debit - v.credit : v.credit - v.debit;
    rows.push({ code: a.code, name: a.name, major: a.major, debit: v.debit, credit: v.credit, balance });
  }
  rows.sort((x, y) => (x.code < y.code ? -1 : 1));
  return rows;
}
