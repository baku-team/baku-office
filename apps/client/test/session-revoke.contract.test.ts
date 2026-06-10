// 適合性テスト（§3-3）：セッション即時失効。権限変更・除名で revokeSessions を呼ぶと、
// それ以前に発行されたセッションが getSession で無効化される（再ログイン強制）こと。
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeSessionCookie, getSession, revokeSessions, type Session } from "../src/lib/auth.ts";

// 最小の env モック：MASTER_KEY（base64 32byte）＋ Map ベースの LICENSE KV。
function makeEnv() {
  const store = new Map<string, string>();
  const mk = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");
  return {
    MASTER_KEY: mk,
    LICENSE: {
      get: async (k: string) => store.get(k) ?? null,
      put: async (k: string, v: string) => void store.set(k, v),
      delete: async (k: string) => void store.delete(k),
    },
  } as unknown as Env;
}

const reqWith = (cookie: string) => new Request("https://app/x", { headers: { cookie } });
const ses = (uid: string): Session => ({ uid, role: "admin", ctx: "org", exp: Math.floor(Date.now() / 1000) + 3600 });

test("通常セッションは getSession で復元できる", async () => {
  const env = makeEnv();
  const cookie = await makeSessionCookie(env, ses("u1"));
  const got = await getSession(env, reqWith(cookie));
  assert.equal(got?.uid, "u1");
});

test("revokeSessions 後、それ以前発行のセッションは無効化される", async () => {
  const env = makeEnv();
  const cookie = await makeSessionCookie(env, ses("u1"));
  assert.ok(await getSession(env, reqWith(cookie)), "失効前は有効");
  // 1秒先の失効時刻にして iat(発行) < cut を確実にする。
  await env.LICENSE.put("revoke:u1", String(Math.floor(Date.now() / 1000) + 1));
  assert.equal(await getSession(env, reqWith(cookie)), null, "失効後は無効");
});

test("失効は uid 単位（別ユーザーには影響しない）", async () => {
  const env = makeEnv();
  const c1 = await makeSessionCookie(env, ses("u1"));
  const c2 = await makeSessionCookie(env, ses("u2"));
  await env.LICENSE.put("revoke:u1", String(Math.floor(Date.now() / 1000) + 1));
  assert.equal(await getSession(env, reqWith(c1)), null, "u1 は失効");
  assert.ok(await getSession(env, reqWith(c2)), "u2 は有効のまま");
});

test("revokeSessions は失効レコードを書き込む", async () => {
  const env = makeEnv();
  await revokeSessions(env, "u9");
  assert.ok(await env.LICENSE.get("revoke:u9"), "revoke:u9 が記録される");
});
