// 適合性テスト（P0-1 再発防止）：pages/ 配下の動的エンドポイント（.ts ルート・api/ 以外）も
// 認可シグナルを必ず持つこと。export.csv のような「.astro 以外のページ系ルート」が
// middleware の認可対象外に落ちて未認証露出するのを静的に検出する。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const PAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../src/pages");
const API_DIR = join(PAGES_DIR, "api");

// 認可とみなすシグナル（getSession を必ず通す設計）。
const AUTH_SIGNALS = [/getSession\s*\(/, /requireOrgAdmin\s*\(/, /getFileForSession\s*\(/];

// 設計上「公開」が正しいページ系ルート（理由つき allowlist）。
const PUBLIC_ALLOWLIST: Record<string, string> = {};

const HANDLER = /export\s+const\s+(GET|POST|PUT|DELETE|PATCH)\b/;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (p.startsWith(API_DIR)) continue; // api/ は api-authz.contract.test.ts が担当
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (e.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("pages/（api以外）の.tsルートは認可シグナルを持つ", () => {
  const offenders: string[] = [];
  for (const file of walk(PAGES_DIR)) {
    const src = readFileSync(file, "utf8");
    if (!HANDLER.test(src)) continue;
    const rel = relative(PAGES_DIR, file).replace(/\\/g, "/");
    const hasAuth = AUTH_SIGNALS.some((re) => re.test(src));
    if (!hasAuth && !(rel in PUBLIC_ALLOWLIST)) offenders.push(rel);
  }
  assert.deepEqual(offenders, [], `認可シグナルの無いページ系ルート（未認証露出の疑い）: ${offenders.join(", ")}`);
});
