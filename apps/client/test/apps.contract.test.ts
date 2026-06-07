// 適合性テスト：アプリ基盤（レジストリ／導入／必須アプリ／アプリ間連動＋権限）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import "../src/parts/index.ts"; // アプリ登録
import { appCatalog, installApp, uninstallApp, installedAppIds, makeAppsApi, MANDATORY_APPS } from "../src/core/apps.ts";
import { nodeSqlStore, memKv } from "./node-sqlite-adapter.ts";

test("カタログにマニフェスト（version/permissions）が載る・chatは必須", () => {
  const chat = appCatalog().find((a) => a.id === "chat");
  assert.ok(chat, "chat アプリが公開カタログにある");
  assert.equal(chat.version, "1.0.0");
  assert.deepEqual([...chat.permissions].sort(), ["agent", "ai", "db:read"]);
  assert.ok(MANDATORY_APPS.includes("chat"));
});

test("導入/削除：最小化できる・必須(chat)は削除不可", async () => {
  const ctx = { storage: { kv: memKv() } } as never;
  // 既定（未設定）は全導入＝chat 含む。
  assert.ok((await installedAppIds(ctx)).includes("chat"));
  // memo を削除 → 一覧から消える。
  await uninstallApp(ctx, "memo");
  assert.ok(!(await installedAppIds(ctx)).includes("memo"));
  // 再導入で戻る。
  await installApp(ctx, "memo");
  assert.ok((await installedAppIds(ctx)).includes("memo"));
  // 必須アプリ(chat)は削除できない。
  await assert.rejects(() => uninstallApp(ctx, "chat"), /必須/);
  assert.ok((await installedAppIds(ctx)).includes("chat"));
});

test("アプリ間連動：knowledge.search を権限内で呼べる／権限外は拒否", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE knowledge (id TEXT PRIMARY KEY, title TEXT, body TEXT, file_ref TEXT, tags TEXT, created_by TEXT, created_at INTEGER, deleted_at INTEGER)");
  sqlite.prepare("INSERT INTO knowledge (id,title,body,created_at) VALUES (?,?,?,?)").run("k1", "会則", "会費は月500円", 0);
  const ctx = { db: nodeSqlStore(sqlite), storage: { kv: memKv() } } as Record<string, unknown>;
  ctx.apps = makeAppsApi(ctx as never);
  const apps = ctx.apps as ReturnType<typeof makeAppsApi>;

  // caller 指定なし＝権限チェックなしで実行できる。
  assert.match(String(await apps.call("knowledge", "search", { query: "会費" })), /会則/);
  // accounting は db:read を保有 → 許可。
  assert.match(String(await apps.call("knowledge", "search", { query: "会費" }, "accounting")), /会則/);
  // memo は db:read を持たない → 拒否。
  await assert.rejects(() => apps.call("knowledge", "search", { query: "x" }, "memo"), /権限がありません/);
  // 存在しない操作。
  await assert.rejects(() => apps.call("knowledge", "nope", {}), /操作が見つかりません/);
});
