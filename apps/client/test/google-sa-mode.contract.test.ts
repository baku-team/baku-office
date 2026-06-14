// 契約テスト（キーレスWIF P3）：sa_mode(key|wif) のデータモデルと保存。
// wif 保存→configured/info が正、key 方式は後退なし、clear で全消去、を確認（ネットワーク不要）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateMasterKey } from "@baku-office/shared";
import {
  saveWifConfig, saveServiceAccount, serviceAccountConfigured, getServiceAccountInfo, clearServiceAccount,
  type WifConfig,
} from "../src/lib/google-sa.ts";

function fakeEnv() {
  const kv = new Map<string, string>();
  const LICENSE = {
    get: async (k: string) => (kv.has(k) ? kv.get(k)! : null),
    put: async (k: string, v: string) => { kv.set(k, v); },
    delete: async (k: string) => { kv.delete(k); },
    list: async () => ({ keys: [] as { name: string }[] }),
  };
  return { LICENSE, MASTER_KEY: generateMasterKey() } as never;
}

const WIF: WifConfig = {
  sa_email: "bot@proj.iam.gserviceaccount.com", client_id: "123456789",
  project_number: "987654321", pool: "baku-pool", provider: "baku-prov",
  issuer: "https://tenant.example.workers.dev",
};

test("saveWifConfig→wif で configured 真・info が mode=wif と client 情報を返す", async () => {
  const env = fakeEnv();
  assert.equal(await serviceAccountConfigured(env), false, "初期は未設定");
  const r = await saveWifConfig(env, WIF, "admin@tenant.co.jp");
  assert.equal(r.ok, true);
  assert.equal(await serviceAccountConfigured(env), true);
  const info = await getServiceAccountInfo(env);
  assert.equal(info?.mode, "wif");
  assert.equal(info?.clientId, "123456789");
  assert.equal(info?.clientEmail, "bot@proj.iam.gserviceaccount.com");
  assert.equal(info?.subject, "admin@tenant.co.jp");
});

test("saveWifConfig：subject 不正・必須欠落・project_number 非数値は拒否", async () => {
  const env = fakeEnv();
  assert.equal((await saveWifConfig(env, WIF, "not-an-email")).ok, false);
  assert.equal((await saveWifConfig(env, { ...WIF, pool: "" }, "a@b.co")).ok, false);
  assert.equal((await saveWifConfig(env, { ...WIF, project_number: "abc" }, "a@b.co")).ok, false);
});

test("key 方式は後退なし：saveServiceAccount→configured 真・info が mode=key", async () => {
  const env = fakeEnv();
  const keyJson = JSON.stringify({ client_email: "sa@p.iam.gserviceaccount.com", private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n", client_id: "555" });
  const r = await saveServiceAccount(env, keyJson, "admin@tenant.co.jp");
  assert.equal(r.ok, true);
  assert.equal(await serviceAccountConfigured(env), true);
  const info = await getServiceAccountInfo(env);
  assert.equal(info?.mode, "key");
  assert.equal(info?.clientId, "555");
});

test("clearServiceAccount：wif 設定・mode・subject を全消去し未設定へ戻す", async () => {
  const env = fakeEnv();
  await saveWifConfig(env, WIF, "admin@tenant.co.jp");
  await clearServiceAccount(env);
  assert.equal(await serviceAccountConfigured(env), false);
  assert.equal(await getServiceAccountInfo(env), null);
});
