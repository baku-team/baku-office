// 適合性テスト：アプリ内通知（lib/notifications.ts）が Node+SQLite で動き、owner 分離・未読数・既読化が成立する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { nodeSqlStore } from "./node-sqlite-adapter.ts";
import { addNotification, listNotifications, countUnread, markNotificationsRead } from "../src/lib/notifications.ts";

const SCHEMA = `
CREATE TABLE notifications (id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, link TEXT, read_at INTEGER, created_at INTEGER NOT NULL);
`;

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(SCHEMA);
  return { ctx: { profile: "node", db: nodeSqlStore(sqlite), env: {} } };
}

test("notifications：追加・一覧・未読数・既読化（owner 分離）", async () => {
  const { ctx } = setup();
  await addNotification(ctx, { owner: "org", kind: "reminder", body: "請求書A 期日", link: "/invoices" });
  await addNotification(ctx, { owner: "org", kind: "reminder", body: "請求書B 期日" });
  await addNotification(ctx, { owner: "line:u1", kind: "reminder", body: "個人用" });

  // 未読数は owner ごとに分離。
  assert.equal(await countUnread(ctx, "org"), 2);
  assert.equal(await countUnread(ctx, "line:u1"), 1);
  assert.equal(await countUnread(ctx, "line:none"), 0);

  const orgItems = await listNotifications(ctx, "org");
  assert.equal(orgItems.length, 2);
  assert.deepEqual(orgItems.map((n) => n.body).sort(), ["請求書A 期日", "請求書B 期日"]);
  const a = orgItems.find((n) => n.body === "請求書A 期日")!;
  assert.equal(a.link, "/invoices");

  // 1件だけ既読化。
  await markNotificationsRead(ctx, "org", a.id);
  assert.equal(await countUnread(ctx, "org"), 1);
  assert.equal((await listNotifications(ctx, "org", { unreadOnly: true })).length, 1);

  // 全既読化は他 owner に波及しない。
  await markNotificationsRead(ctx, "org");
  assert.equal(await countUnread(ctx, "org"), 0);
  assert.equal(await countUnread(ctx, "line:u1"), 1);
});
