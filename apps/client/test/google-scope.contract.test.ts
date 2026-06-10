// 適合性テスト（P0-3）：Google OAuth の用途別 scope 分割（incremental auth）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { googleAuthUrl, normalizeGroups, SCOPE_GROUPS } from "../src/lib/google.ts";

const ENV = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "sec" } as never;
const scopesOf = (url: string) => new URL(url).searchParams.get("scope")!.split(" ").sort();
const authUrl = async (groups: string[], state = "st") => (await googleAuthUrl(ENV, "https://x.example", state, groups as never))!;

test("normalizeGroups：不正値を除去／空は非Restrictedの既定のみ（Gmailは含めない・P1-1）", () => {
  assert.deepEqual(normalizeGroups(["calendar", "bogus"]), ["calendar"]);
  // 空/null は Restricted(Gmail)を除く既定（calendar/meet）のみ。
  assert.deepEqual(normalizeGroups([]).sort(), ["calendar", "meet"]);
  assert.deepEqual(normalizeGroups(null).sort(), ["calendar", "meet"]);
  // Gmail は明示指定したときだけ含まれる。
  assert.deepEqual(normalizeGroups(["gmail_read"]), ["gmail_read"]);
});

test("googleAuthUrl：選んだグループの scope だけを要求（gmail_readはreadonly・送信を含めない）", async () => {
  const url = await authUrl(["gmail_read"]);
  assert.deepEqual(scopesOf(url), ["https://www.googleapis.com/auth/gmail.readonly"]);
  assert.ok(!scopesOf(url).includes("https://www.googleapis.com/auth/gmail.send"), "送信scopeは含まれない");
  assert.ok(!scopesOf(url).includes("https://www.googleapis.com/auth/gmail.modify"), "modifyは要求しない（読取のみ）");
  // 閲覧＋送信
  const url2 = await authUrl(["gmail_read", "gmail_send"]);
  assert.deepEqual(scopesOf(url2), ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"]);
});

test("googleAuthUrl：offline + consent + state を設定", async () => {
  const u = new URL(await authUrl(["calendar"], "STATE"));
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("prompt"), "consent");
  assert.equal(u.searchParams.get("state"), "STATE");
});

test("Restricted scope の識別：gmail_read/gmail_send は restricted、calendar/meet は非restricted", () => {
  assert.equal(SCOPE_GROUPS.gmail_read.restricted, true);
  assert.equal(SCOPE_GROUPS.gmail_send.restricted, true);
  assert.equal(SCOPE_GROUPS.calendar.restricted, false);
  assert.equal(SCOPE_GROUPS.meet.restricted, false);
});
