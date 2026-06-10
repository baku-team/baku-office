// 適合性テスト（§4-2）：公開LPレイアウトの CSP が nonce ベースで多層化されており、
// script-src から 'unsafe-inline' を外していること、唯一のインライン script に nonce が付くことを静的に保証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/layouts/SitePublic.astro"), "utf8");

test("CSP の script-src は nonce を使い 'unsafe-inline' を含まない", () => {
  const m = /script-src ([^;]+);/.exec(src);
  assert.ok(m, "script-src ディレクティブがある");
  assert.ok(m[1].includes("'nonce-"), "nonce ベース");
  assert.ok(!m[1].includes("'unsafe-inline'"), "script-src に 'unsafe-inline' を残さない");
});

test("リクエストごとに nonce を生成し、インライン script に付与している", () => {
  assert.ok(/const nonce = .*getRandomValues/.test(src), "nonce をランダム生成");
  assert.ok(/<script is:inline nonce=\{nonce\}>/.test(src), "インライン script に nonce 付与");
});

test("style-src は管理者HTMLの style 属性を壊さないため 'unsafe-inline' を維持", () => {
  const m = /style-src ([^;]+);/.exec(src);
  assert.ok(m && m[1].includes("'unsafe-inline'"), "style-src は 'unsafe-inline' 維持");
});
