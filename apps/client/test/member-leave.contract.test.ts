// 適合性テスト（GA・会員セルフサービス）：本人の脱退申請→管理者承認の配線を静的に保証する。
// 業務データは団体帰属＝削除しない（アカウント無効化のみ）。開示/エクスポートは提供しない方針。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const C = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(join(C, "..", p), "utf8");

test("migration 0026 が MIGRATIONS に登録されている", () => {
  const src = read("src/lib/migrate.ts");
  assert.ok(src.includes("0026_user_leave"), "0026 を適用順に追加");
});

test("users.ts に脱退申請ロジックと最終管理者ガードがある", () => {
  const src = read("src/lib/users.ts");
  assert.ok(/export async function requestLeave/.test(src), "requestLeave");
  assert.ok(/export async function cancelLeave/.test(src), "cancelLeave");
  assert.ok(/export async function activeAdminCount/.test(src), "activeAdminCount（最終管理者ガード用）");
  assert.ok(/leave_requested_at=NULL/.test(src), "承認(rejectUser)で申請フラグを解消");
});

test("自己脱退申請APIは本人セッション必須・最終管理者/ブートストラップを保護", () => {
  const src = read("src/pages/api/me/leave-request.ts");
  assert.ok(/getSession/.test(src), "セッション必須");
  assert.ok(/uid === "org"/.test(src), "ブートストラップ管理者を保護");
  assert.ok(/activeAdminCount/.test(src), "最後の管理者の脱退を拒否");
});

test("管理者は脱退申請を承認できる（leave_approve）", () => {
  assert.ok(/leave_approve/.test(read("src/pages/api/members.ts")), "members API に leave_approve");
});
