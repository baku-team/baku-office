// 適合性テスト（P1-1）：CSRF 多層防御。sameOrigin 判定の挙動と、
// middleware が webhook/cron/A2A 以外の状態変更 /api/ を同一オリジン必須にしていること（静的）を確認する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { sameOrigin } from "../src/lib/auth.ts";

const req = (headers: Record<string, string>) =>
  new Request("https://app.example.com/api/members", { method: "POST", headers });

test("Sec-Fetch-Site: same-origin は通過", () => {
  assert.equal(sameOrigin(req({ "sec-fetch-site": "same-origin" })), true);
});

test("Sec-Fetch-Site: cross-site / same-site は拒否", () => {
  assert.equal(sameOrigin(req({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(sameOrigin(req({ "sec-fetch-site": "same-site" })), false);
});

test("Sec-Fetch-Site 無し・別オリジン Origin は拒否", () => {
  assert.equal(sameOrigin(req({ origin: "https://evil.example.net" })), false);
});

test("Sec-Fetch-Site 無し・同一オリジン Origin は通過", () => {
  assert.equal(sameOrigin(req({ origin: "https://app.example.com" })), true);
});

test("Origin も Sec-Fetch-Site も無い変更系は安全側で拒否", () => {
  assert.equal(sameOrigin(req({})), false);
});

// middleware 側の構成（exempt 拡張子 allowlist・CSRF 中央化）が後退していないかを静的に確認。
test("middleware は CSRF を中央化し exempt を拡張子allowlistに限定している", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/middleware.ts"), "utf8");
  assert.ok(src.includes("sameOrigin"), "sameOrigin による CSRF ガードがある");
  assert.ok(src.includes("STATIC_EXT"), "exempt は拡張子 allowlist 方式");
  assert.ok(!src.includes('pathname.includes(".")'), "旧 includes('.') 方式を残さない");
  for (const p of ["/api/site/stripe-webhook", "/api/line/webhook", "/api/a2a/inbound", "/api/cron/drain"]) {
    assert.ok(src.includes(p), `CSRF 除外に ${p} を含む`);
  }
});
