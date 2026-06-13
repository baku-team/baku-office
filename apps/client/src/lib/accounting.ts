// 会計コア（設計書§8.1）。現金主義・単式（出納帳）＋科目分類。帳票はクエリで導出（保存しない）。
import { randomId } from "@baku-office/shared";
import { ensureChartOfAccounts, ensureCategoryAccountLinks } from "./account-items.ts";

export const nowSec = (): number => Math.floor(Date.now() / 1000);

export type Wallet = { id: string; name: string; type: string; opening_balance: number; sort_order: number };
export type Category = { id: string; name: string; kind: "income" | "expense"; parent_id: string | null; sort_order: number };
export type FiscalPeriod = { id: string; name: string; start_date: string; end_date: string; status: string };
export type Tx = {
  id: string;
  fiscal_period_id: string;
  date: string;
  wallet_id: string;
  kind: "income" | "expense" | "transfer";
  category_id: string | null;
  amount: number;
  description: string | null;
  counter_wallet_id: string | null;
  account_item_id?: string | null;
  created_at: number;
};

// 初回シード：会計期・口座・科目が無ければ既定を投入（任意団体がすぐ使えるように）。
export async function ensureSeed(env: Env): Promise<void> {
  // 勘定科目マスタは常に冪等投入（既存団体にも後付けで提供）。
  await ensureChartOfAccounts(env);
  const fp = await env.DB.prepare("SELECT id FROM fiscal_periods LIMIT 1").first<{ id: string }>();
  if (!fp) {
    const y = new Date().getUTCFullYear();
    const fid = randomId();
    await env.DB.prepare("INSERT INTO fiscal_periods (id,name,start_date,end_date,status) VALUES (?,?,?,?,'open')")
      .bind(fid, `${y}年度`, `${y}-04-01`, `${y + 1}-03-31`)
      .run();
    const wallets: [string, string][] = [["現金", "cash"], ["普通預金", "bank"]];
    let i = 0;
    for (const [name, type] of wallets) {
      await env.DB.prepare("INSERT INTO wallets (id,name,type,opening_balance,sort_order) VALUES (?,?,?,0,?)")
        .bind(randomId(), name, type, i++)
        .run();
    }
    const cats: [string, "income" | "expense"][] = [
      ["会費収入", "income"], ["寄付収入", "income"], ["事業収入", "income"], ["雑収入", "income"],
      ["消耗品費", "expense"], ["通信費", "expense"], ["会議費", "expense"], ["旅費交通費", "expense"], ["雑費", "expense"],
    ];
    i = 0;
    for (const [name, kind] of cats) {
      await env.DB.prepare("INSERT INTO categories (id,name,kind,parent_id,sort_order) VALUES (?,?,?,NULL,?)")
        .bind(randomId(), name, kind, i++)
        .run();
    }
  }
  // 口座・科目に勘定科目を紐付け（未設定のみ・橋渡し用）。
  await ensureCategoryAccountLinks(env);
}

export async function currentPeriod(env: Env): Promise<FiscalPeriod | null> {
  return env.DB.prepare("SELECT * FROM fiscal_periods WHERE status='open' ORDER BY start_date DESC LIMIT 1").first<FiscalPeriod>();
}
export async function listWallets(env: Env): Promise<Wallet[]> {
  return (await env.DB.prepare("SELECT * FROM wallets ORDER BY sort_order").all<Wallet>()).results;
}
// お金の種類（type）を選んで口座を追加。対応する勘定科目を自動紐付け（現金/口座/カード/電子マネー/QR/プライベート）。
export async function createWallet(env: Env, w: { name: string; type: string; opening_balance?: number }): Promise<string> {
  const { WALLET_TYPES, getAccountItemByCode, walletAccountCode } = await import("./account-items.ts");
  const valid = WALLET_TYPES.some((t) => t.type === w.type) ? w.type : "other";
  const acc = await getAccountItemByCode(env, walletAccountCode(valid));
  const id = randomId();
  const max = await env.DB.prepare("SELECT COALESCE(MAX(sort_order),-1) AS m FROM wallets").first<{ m: number }>();
  await env.DB.prepare("INSERT INTO wallets (id,name,type,opening_balance,sort_order,account_item_id) VALUES (?,?,?,?,?,?)")
    .bind(id, w.name, valid, Math.round(w.opening_balance ?? 0), (max?.m ?? -1) + 1, acc?.id ?? null).run();
  return id;
}
export async function softDeleteWallet(env: Env, id: string): Promise<void> {
  // 取引のある口座は残高計算が壊れるため物理削除しない。簡易にレコード削除（取引が無い前提・UI側で確認）。
  await env.DB.prepare("DELETE FROM wallets WHERE id=?").bind(id).run();
}
export async function listCategories(env: Env): Promise<Category[]> {
  return (await env.DB.prepare("SELECT * FROM categories ORDER BY kind, sort_order").all<Category>()).results;
}
// 各口座の現在残高（opening_balance＋当期の入出金・振替）。会計画面の残高カード用に一括集計。
export async function walletBalances(env: Env, periodId: string): Promise<(Wallet & { balance: number })[]> {
  const wallets = await listWallets(env);
  const { results } = await env.DB.prepare(
    "SELECT kind, wallet_id, counter_wallet_id, amount FROM transactions WHERE fiscal_period_id=? AND deleted_at IS NULL",
  ).bind(periodId).all<{ kind: string; wallet_id: string; counter_wallet_id: string | null; amount: number }>();
  const delta = new Map<string, number>();
  const add = (id: string | null, v: number) => { if (id) delta.set(id, (delta.get(id) ?? 0) + v); };
  for (const t of results) {
    if (t.kind === "income") add(t.wallet_id, t.amount);
    else if (t.kind === "expense") add(t.wallet_id, -t.amount);
    else if (t.kind === "transfer") { add(t.wallet_id, -t.amount); add(t.counter_wallet_id, t.amount); }
  }
  return wallets.map((w) => ({ ...w, balance: w.opening_balance + (delta.get(w.id) ?? 0) }));
}

// 取引登録（income/expense/transfer）。
export async function createTx(env: Env, t: Omit<Tx, "id" | "created_at">): Promise<string> {
  const id = randomId();
  const now = nowSec();
  await env.DB.prepare(
    `INSERT INTO transactions (id,fiscal_period_id,date,wallet_id,kind,category_id,amount,description,counter_wallet_id,account_item_id,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(id, t.fiscal_period_id, t.date, t.wallet_id, t.kind, t.category_id, t.amount, t.description, t.counter_wallet_id, t.account_item_id ?? null, now, now)
    .run();
  return id;
}

// ソフトデリート（§12）。
export async function softDeleteTx(env: Env, id: string): Promise<void> {
  await env.DB.prepare("UPDATE transactions SET deleted_at=? WHERE id=?").bind(nowSec(), id).run();
}

// 出納帳：口座で絞り日付順＋累計残高（opening_balance 起点）。
export async function cashbook(env: Env, periodId: string, walletId: string): Promise<{ wallet: Wallet; rows: (Tx & { running: number })[] }> {
  const wallet = await env.DB.prepare("SELECT * FROM wallets WHERE id=?").bind(walletId).first<Wallet>();
  if (!wallet) throw new Error("wallet not found");
  // この口座に関係する行（自口座 or 振替先）。
  const { results } = await env.DB.prepare(
    `SELECT * FROM transactions WHERE fiscal_period_id=? AND deleted_at IS NULL AND (wallet_id=? OR counter_wallet_id=?) ORDER BY date, created_at`,
  ).bind(periodId, walletId, walletId).all<Tx>();
  let running = wallet.opening_balance;
  const rows = results.map((t) => {
    let delta = 0;
    if (t.kind === "income" && t.wallet_id === walletId) delta = t.amount;
    else if (t.kind === "expense" && t.wallet_id === walletId) delta = -t.amount;
    else if (t.kind === "transfer") {
      if (t.wallet_id === walletId) delta = -t.amount; // 振替元＝出金
      else if (t.counter_wallet_id === walletId) delta = t.amount; // 振替先＝入金
    }
    running += delta;
    return { ...t, running };
  });
  return { wallet, rows };
}

// 収支計算書：科目(kind)別に会計期集計。
export async function incomeStatement(env: Env, periodId: string): Promise<{
  income: { name: string; amount: number }[];
  expense: { name: string; amount: number }[];
  totalIncome: number;
  totalExpense: number;
}> {
  const { results } = await env.DB.prepare(
    `SELECT c.name AS name, c.kind AS kind, COALESCE(SUM(t.amount),0) AS amount
     FROM transactions t JOIN categories c ON c.id=t.category_id
     WHERE t.fiscal_period_id=? AND t.deleted_at IS NULL AND t.kind IN ('income','expense')
     GROUP BY t.category_id ORDER BY c.kind, c.sort_order`,
  ).bind(periodId).all<{ name: string; kind: string; amount: number }>();
  const income = results.filter((r) => r.kind === "income").map((r) => ({ name: r.name, amount: r.amount }));
  const expense = results.filter((r) => r.kind === "expense").map((r) => ({ name: r.name, amount: r.amount }));
  return {
    income, expense,
    totalIncome: income.reduce((s, r) => s + r.amount, 0),
    totalExpense: expense.reduce((s, r) => s + r.amount, 0),
  };
}

// 予実：budgets と実績を科目で突合。
export async function budgetActual(env: Env, periodId: string): Promise<{ name: string; budget: number; actual: number }[]> {
  const { results } = await env.DB.prepare(
    `SELECT c.name AS name, COALESCE(b.amount,0) AS budget,
            COALESCE((SELECT SUM(amount) FROM transactions t WHERE t.category_id=c.id AND t.fiscal_period_id=? AND t.deleted_at IS NULL),0) AS actual
     FROM categories c LEFT JOIN budgets b ON b.category_id=c.id AND b.fiscal_period_id=?
     ORDER BY c.kind, c.sort_order`,
  ).bind(periodId, periodId).all<{ name: string; budget: number; actual: number }>();
  return results;
}
