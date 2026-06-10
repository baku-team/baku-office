// 適合性テスト（§7・action#7）：本番 env 点検が必須/任意の欠落を正しく検出する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkProdEnv } from "../src/lib/boot-check.ts";

const keys = (env: unknown) => checkProdEnv(env as never).map((f) => f.key).sort();

test("非本番（ENVIRONMENT!=production）は点検しない", () => {
  assert.deepEqual(keys({ ENVIRONMENT: "development", MASTER_KEY: undefined }), []);
  assert.deepEqual(keys({}), []);
});

test("本番で全設定済みなら指摘なし", () => {
  assert.deepEqual(keys({
    ENVIRONMENT: "production", MASTER_KEY: "k", VERIFY_PUBLIC_JWK: "j",
    INTERNAL_KEY: "i", GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s",
  }), []);
});

test("本番で MASTER_KEY 欠落は error", () => {
  const f = checkProdEnv({ ENVIRONMENT: "production" } as never);
  const mk = f.find((x) => x.key === "MASTER_KEY");
  assert.ok(mk && mk.level === "error");
});

test("本番で任意設定の欠落は warn として列挙", () => {
  assert.deepEqual(
    keys({ ENVIRONMENT: "production", MASTER_KEY: "k" }),
    ["GOOGLE_OAUTH", "INTERNAL_KEY", "VERIFY_PUBLIC_JWK"],
  );
});
