// 適合性テスト（§4-3）：deploy-report は「仮登録」、activate-by-email（Googleログイン突合）が「確定」。
// unauth な deploy-report が確定済み(verified)を上書きしないこと、確定経路が verified=1 を立てることを静的に保証する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(root, "../src/pages/api", p), "utf8");

test("deploy-report は確定済み(verified)を上書きしない（仮登録のみ）", () => {
  const src = read("deploy-report.ts");
  assert.ok(src.includes("deploy_url_verified"), "verified を参照する");
  assert.ok(/deploy_url_verified = 0/.test(src), "未確定(=0)のときのみ更新する WHERE 条件");
  assert.ok(/!lic\.v && !lic\.u/.test(src), "確定済み or 既設定なら書かない");
});

test("deploy-report は IP レート制限を持つ", () => {
  assert.ok(/cf-connecting-ip/.test(read("deploy-report.ts")), "IP取得");
  assert.ok(/429/.test(read("deploy-report.ts")), "上限時 429");
});

test("activate-by-email は deploy_url を確定（verified=1）として上書きする", () => {
  const src = read("activate-by-email.ts");
  assert.ok(/deploy_url_verified = 1/.test(src), "verified=1 を立てる");
  assert.ok(/SET deploy_url = \?, deploy_url_verified = 1/.test(src), "確定として上書き");
});
