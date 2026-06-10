// 適合性テスト（P0-2）：本番（ENV未設定）では dev-confirm/checkout が無認証昇格URLを発行しない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { GET as devConfirm } from "../src/pages/api/billing/dev-confirm.ts";
import { POST as checkout } from "../src/pages/api/billing/checkout.ts";

function fakeEnv(extra: Record<string, unknown>, sqlite?: DatabaseSync) {
  const db = sqlite && {
    prepare: (sql: string) => {
      const mk = (bound: unknown[] = []) => ({
        bind: (...v: unknown[]) => mk(v),
        run: async () => { sqlite.prepare(sql).run(...(bound as never[])); return { success: true }; },
        all: async () => ({ results: sqlite.prepare(sql).all(...(bound as never[])) }),
        first: async () => sqlite.prepare(sql).get(...(bound as never[])) ?? null,
      });
      return mk();
    },
  };
  return { DB: db, ...extra } as never;
}
const locals = (env: unknown) => ({ runtime: { env } }) as never;
const devUrl = (env: unknown) =>
  devConfirm({ url: new URL("https://host/api/billing/dev-confirm?license_id=L1&plan=plus"), locals: locals(env) } as never);
const checkoutReq = (env: unknown) =>
  checkout({ request: new Request("https://host/api/billing/checkout", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ licenseId: "L1", plan: "plus" }) }), locals: locals(env) } as never);

test("dev-confirm：ENV未設定（本番）かつ Stripe未設定 → 403（fail-closed）", async () => {
  const r = await devUrl(fakeEnv({}));
  assert.equal(r.status, 403);
});

test("dev-confirm：ENV=development かつ Stripe設定済み → 403（Webhook経由に限定）", async () => {
  const r = await devUrl(fakeEnv({ ENV: "development", STRIPE_SECRET_KEY: "sk_test" }));
  assert.equal(r.status, 403);
});

test("checkout：ENV未設定（本番）かつ Stripe未設定 → 503（dev URLを発行しない）", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE licenses (license_id TEXT, status TEXT)");
  db.prepare("INSERT INTO licenses VALUES ('L1','active')").run();
  const r = await checkoutReq(fakeEnv({}, db));
  assert.equal(r.status, 503);
});

test("checkout：ENV=development かつ Stripe未設定 → dev URLを返す（mode=dev）", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE licenses (license_id TEXT, status TEXT)");
  db.prepare("INSERT INTO licenses VALUES ('L1','active')").run();
  const r = await checkoutReq(fakeEnv({ ENV: "development" }, db));
  assert.equal(r.status, 200);
  const j = (await r.json()) as { mode?: string; url?: string };
  assert.equal(j.mode, "dev");
  assert.match(j.url ?? "", /dev-confirm/);
});
