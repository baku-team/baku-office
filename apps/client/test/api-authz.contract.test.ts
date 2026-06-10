// 適合性テスト（レビュー003 §4・action#4）：状態変更API（POST/PUT/DELETE/PATCH）は
// 必ず「認可シグナル」を持つこと。middleware が /api/ を認可対象外にしている設計上、
// 各ルートに認可が分散するため、抜けを静的に検出する（新規ルートの未認証露出を回帰防止）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/pages/api");

// 認可とみなすシグナル（いずれかを含めば可）：セッション／署名検証／共有秘密／dev限定。
const AUTH_SIGNALS = [
  /getSession\s*\(/,            // ユーザーセッション
  /requireOrgAdmin\s*\(/,      // 組織管理者ゲート（getSession ラッパ）
  /verifyEnvelope\s*\(/,       // A2A 署名
  /verifyStripeSig\s*\(/,      // Stripe Webhook 署名
  /verifyLineSignature\s*\(/,  // LINE Webhook 署名
  /verifyPending\s*\(/,        // 署名付き pending（招待引き継ぎ）
  /INTERNAL_KEY/,              // スケジューラ共有秘密
  /isDevEnv\s*\(/,             // dev 限定
];

// 設計上「公開」が正しいエンドポイント（理由つき allowlist）。ここに無い未認証ルートは fail。
const PUBLIC_ALLOWLIST: Record<string, string> = {
  "login.ts": "ログイン自体（id/pass・OAuth開始）",
  "join.ts": "招待コード参加（verifyPending で OAuth 引き継ぎは署名検証）",
  "site/join.ts": "公開会員申込フォーム（未認証の来訪者が送信）",
};

const MUT = /export\s+const\s+(POST|PUT|DELETE|PATCH)\b/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("状態変更APIは認可シグナルを持つ（公開は明示allowlistのみ）", () => {
  const offenders: string[] = [];
  for (const file of walk(API_DIR)) {
    const src = readFileSync(file, "utf8");
    if (!MUT.test(src)) continue;
    const rel = relative(API_DIR, file).replace(/\\/g, "/");
    const hasAuth = AUTH_SIGNALS.some((re) => re.test(src));
    const isPublic = rel in PUBLIC_ALLOWLIST;
    if (!hasAuth && !isPublic) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `認可シグナルの無い状態変更API（未認証露出の疑い）: ${offenders.join(", ")}`);
});

test("PUBLIC_ALLOWLIST は実在ファイルだけを指す（古い除外を残さない）", () => {
  const files = new Set(walk(API_DIR).map((f) => relative(API_DIR, f).replace(/\\/g, "/")));
  const stale = Object.keys(PUBLIC_ALLOWLIST).filter((k) => !files.has(k));
  assert.deepEqual(stale, [], `実在しない allowlist エントリ: ${stale.join(", ")}`);
});
