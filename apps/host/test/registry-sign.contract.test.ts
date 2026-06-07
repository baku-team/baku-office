// 適合性テスト：署名付きアプリ配布（ホスト署名→クライアント検証／改竄拒否）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { importVerifyKey, verifyEnvelope, payloadOf } from "@baku-office/shared";
import { registerApp, setAppStatus, getApp, signAppPackage } from "../src/lib/registry.ts";

function fakeEnv(sqlite: DatabaseSync, jwk: unknown) {
  const mk = (sql: string, bound: unknown[] = []) => ({
    bind: (...v: unknown[]) => mk(sql, v),
    run: async () => { sqlite.prepare(sql).run(...(bound as never[])); return { success: true }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...(bound as never[])) }),
    first: async () => sqlite.prepare(sql).get(...(bound as never[])) ?? null,
  });
  return { DB: { prepare: (sql: string) => mk(sql) }, SIGNING_JWK: JSON.stringify(jwk) } as never;
}
const SCHEMA = "CREATE TABLE registry_apps (id TEXT PRIMARY KEY, name TEXT, version TEXT, repo_url TEXT, publisher TEXT, category TEXT, permissions TEXT, description TEXT, definition TEXT, submitted_by TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER, updated_at INTEGER);";

test("ホスト署名パッケージをクライアント公開鍵で検証して取り込める／改竄は拒否", async () => {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey); // x（公開部）＋ d（秘密）を含む＝SIGNING_JWK
  const db = new DatabaseSync(":memory:"); db.exec(SCHEMA);
  const env = fakeEnv(db, jwk);

  await registerApp(env, { id: "inventory", name: "在庫", version: "1.0.0", permissions: ["db:read", "db:write"], definition: { tools: ["record_stock"] } });
  await setAppStatus(env, "inventory", "approved");

  const pkgB64 = await signAppPackage(env, (await getApp(env, "inventory"))!);
  const envlp = JSON.parse(atob(pkgB64));

  // クライアント側：公開鍵（x のみ）で検証。
  const vpub = await importVerifyKey({ kty: "OKP", crv: "Ed25519", x: jwk.x } as never);
  assert.equal(await verifyEnvelope(vpub, envlp), true, "正規署名は検証成功");
  const p = payloadOf(envlp) as { id: string; permissions: string[]; definition: unknown };
  assert.equal(p.id, "inventory");
  assert.deepEqual(p.permissions, ["db:read", "db:write"]);

  // 改竄（body 差し替え）→ 検証失敗。
  const tampered = { ...envlp, body: btoa("tampered") };
  assert.equal(await verifyEnvelope(vpub, tampered), false, "改竄は検証失敗");
});
