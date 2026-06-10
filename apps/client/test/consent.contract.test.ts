// 適合性テスト（GA要件）：導入時の規約同意ゲート。未記録/版違いで needsConsent=true、
// recordConsent 後は現行版に一致して false。middleware が org admin の未同意を /consent へ誘導する配線も静的確認。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { needsConsent, recordConsent, consentedVersion, CONSENT_VERSION } from "../src/lib/consent.ts";

function makeEnv(initial?: string) {
  const store = new Map<string, string>();
  if (initial !== undefined) store.set("host_terms_consent", initial);
  return { LICENSE: { get: async (k: string) => store.get(k) ?? null, put: async (k: string, v: string) => void store.set(k, v) } } as unknown as Env;
}

test("未記録は未同意（needsConsent=true）", async () => {
  assert.equal(await needsConsent(makeEnv()), true);
});

test("旧バージョン記録は未同意（改訂後の再同意）", async () => {
  assert.equal(await needsConsent(makeEnv("2000-01-01")), true);
});

test("recordConsent 後は現行版に一致して同意済み", async () => {
  const env = makeEnv();
  await recordConsent(env);
  assert.equal(await consentedVersion(env), CONSENT_VERSION);
  assert.equal(await needsConsent(env), false);
});

test("middleware が org admin の未同意を /consent へ誘導する", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/middleware.ts"), "utf8");
  assert.ok(src.includes("needsConsent"), "needsConsent を参照");
  assert.ok(/redirect\("\/consent"/.test(src), "/consent へ誘導");
  assert.ok(/role === "admin"/.test(src), "admin 限定");
});
