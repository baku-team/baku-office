// 会計拡張の契約テスト：勘定科目マスタの冪等seed・橋渡し（単式→仕訳）・試算表の借貸一致・仕訳の整合検証。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeD1 } from "./node-sqlite-adapter.ts";
import { ensureChartOfAccounts, ensureCategoryAccountLinks, listAccountItems, getAccountItemByCode } from "../src/lib/account-items.ts";
import { createTx } from "../src/lib/accounting.ts";
import { buildEntriesForPeriod, trialBalance, createJournalEntry } from "../src/lib/journal.ts";
import { depreciationSchedule } from "../src/lib/fixed-assets.ts";

const SCHEMA = `
CREATE TABLE account_items (id TEXT PRIMARY KEY, code TEXT NOT NULL, name TEXT NOT NULL, major TEXT NOT NULL, normal_balance TEXT NOT NULL, summary_group TEXT, freee_account_item_id TEXT, builtin INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX idx_account_items_code ON account_items (code);
CREATE TABLE wallets (id TEXT PRIMARY KEY, name TEXT, type TEXT, opening_balance INTEGER DEFAULT 0, sort_order INTEGER, account_item_id TEXT);
CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT, kind TEXT, parent_id TEXT, sort_order INTEGER, account_item_id TEXT);
CREATE TABLE fiscal_periods (id TEXT PRIMARY KEY, name TEXT, start_date TEXT, end_date TEXT, status TEXT);
CREATE TABLE transactions (id TEXT PRIMARY KEY, fiscal_period_id TEXT, date TEXT, wallet_id TEXT, kind TEXT, category_id TEXT, amount INTEGER, description TEXT, counter_wallet_id TEXT, account_item_id TEXT, created_by TEXT, receipt_ref TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);
CREATE TABLE journal_entries (id TEXT PRIMARY KEY, fiscal_period_id TEXT, date TEXT, description TEXT, source TEXT, source_ref TEXT, created_by TEXT, created_at INTEGER, updated_at INTEGER, deleted_at INTEGER);
CREATE TABLE journal_lines (id TEXT PRIMARY KEY, entry_id TEXT, side TEXT, account_item_id TEXT, amount INTEGER, memo TEXT, sort_order INTEGER);
`;

function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA);
  const env = { DB: nodeD1(db) } as unknown as Env;
  db.prepare("INSERT INTO fiscal_periods VALUES ('p1','2026年度','2026-04-01','2027-03-31','open')").run();
  db.prepare("INSERT INTO wallets (id,name,type,opening_balance,sort_order) VALUES ('w-cash','現金','cash',0,0)").run();
  db.prepare("INSERT INTO categories (id,name,kind,sort_order) VALUES ('c-sales','売上高','income',0)").run();
  db.prepare("INSERT INTO categories (id,name,kind,sort_order) VALUES ('c-supply','消耗品費','expense',1)").run();
  return { db, env };
}

test("勘定科目マスタは冪等にseedされる（2回呼んでも増えない）", async () => {
  const { env } = setup();
  await ensureChartOfAccounts(env);
  const n1 = (await listAccountItems(env)).length;
  await ensureChartOfAccounts(env);
  const n2 = (await listAccountItems(env)).length;
  assert.ok(n1 > 0);
  assert.equal(n1, n2);
  assert.equal((await getAccountItemByCode(env, "111"))?.name, "現金");
});

test("口座・科目に勘定科目が紐付く（現金→111・売上高→501・消耗品費→611）", async () => {
  const { env, db } = setup();
  await ensureChartOfAccounts(env);
  await ensureCategoryAccountLinks(env);
  const cash = db.prepare("SELECT account_item_id FROM wallets WHERE id='w-cash'").get() as { account_item_id: string };
  const sales = db.prepare("SELECT account_item_id FROM categories WHERE id='c-sales'").get() as { account_item_id: string };
  const supply = db.prepare("SELECT account_item_id FROM categories WHERE id='c-supply'").get() as { account_item_id: string };
  assert.equal((await getAccountItemByCode(env, "111"))?.id, cash.account_item_id);
  assert.equal((await getAccountItemByCode(env, "501"))?.id, sales.account_item_id);
  assert.equal((await getAccountItemByCode(env, "611"))?.id, supply.account_item_id);
});

test("単式の入金が借方:現金/貸方:売上高に橋渡しされ、試算表は借貸一致", async () => {
  const { env } = setup();
  await ensureChartOfAccounts(env);
  await ensureCategoryAccountLinks(env);
  await createTx(env, { fiscal_period_id: "p1", date: "2026-05-01", wallet_id: "w-cash", kind: "income", category_id: "c-sales", amount: 1000, description: "会費", counter_wallet_id: null });
  const entries = await buildEntriesForPeriod(env, "p1");
  assert.equal(entries.length, 1);
  const debit = entries[0].lines.find((l) => l.side === "debit");
  const credit = entries[0].lines.find((l) => l.side === "credit");
  assert.equal(debit?.code, "111");
  assert.equal(credit?.code, "501");
  const tb = await trialBalance(env, "p1");
  const sumD = tb.reduce((s, r) => s + r.debit, 0);
  const sumC = tb.reduce((s, r) => s + r.credit, 0);
  assert.equal(sumD, 1000);
  assert.equal(sumD, sumC);
});

test("定額法の償却スケジュール（取得100万/5年/残0→各年20万・簿価逓減）", () => {
  const s = depreciationSchedule({ acquisition_cost: 1_000_000, useful_life_years: 5, method: "straight_line", residual_value: 0, rate: null });
  assert.equal(s.length, 5);
  assert.deepEqual(s.map((x) => x.amount), [200000, 200000, 200000, 200000, 200000]);
  assert.equal(s[0].bookValue, 800000);
  assert.equal(s[4].bookValue, 0);
  assert.equal(s.reduce((a, x) => a + x.amount, 0), 1_000_000);
});

test("手動仕訳は借貸一致を強制（不一致は例外）", async () => {
  const { env } = setup();
  await ensureChartOfAccounts(env);
  const cash = (await getAccountItemByCode(env, "111"))!.id;
  const sales = (await getAccountItemByCode(env, "501"))!.id;
  await assert.rejects(() => createJournalEntry(env, { fiscal_period_id: "p1", date: "2026-05-02", lines: [
    { side: "debit", account_item_id: cash, amount: 1000 },
    { side: "credit", account_item_id: sales, amount: 900 },
  ] }));
  const id = await createJournalEntry(env, { fiscal_period_id: "p1", date: "2026-05-02", description: "手動", lines: [
    { side: "debit", account_item_id: cash, amount: 1000 },
    { side: "credit", account_item_id: sales, amount: 1000 },
  ] });
  assert.ok(id);
  const entries = await buildEntriesForPeriod(env, "p1");
  assert.equal(entries.length, 1);
  assert.equal(entries[0].source, "manual");
});
