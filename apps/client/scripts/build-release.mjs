// 配布用リリースビルド（設計書§3.1）：
//   apps/client を本番ビルド（Astro=minify済JS。TSソースは含まれない）し、
//   配布リポジトリ用の release/ を組み立てる（dist + wrangler.jsonc + migrations + README）。
//   ※ 真の難読化（変数名mangle等）を強化する場合はここに難読化ツールを挟む。
import { execSync } from "node:child_process";
import { cpSync, rmSync, mkdirSync, copyFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "release");
// 配布バージョン（第2層更新の日和見ローダが同梱 VERSION として比較・§3.2）。
const VERSION = "0.1.0";

console.log("1) Astro 本番ビルド（minify）…");
execSync("npx astro build", { cwd: root, stdio: "inherit" });

console.log("2) release/ を組み立て…");
// .git は残す（配布リポへの再push用）。それ以外を掃除。
if (existsSync(out)) {
  for (const f of readdirSync(out)) if (f !== ".git") rmSync(join(out, f), { recursive: true, force: true });
} else {
  mkdirSync(out, { recursive: true });
}
// ビルド成果物（_worker.js + 静的アセット）をそのまま配布物のルートへ。
cpSync(join(root, "dist"), out, { recursive: true });
// D1 マイグレーション（Deploy工程で自動適用）。
cpSync(join(root, "migrations"), join(out, "migrations"), { recursive: true });
// 配布用 wrangler.jsonc（リソースIDなし＝CFが複製先に自動作成）。
copyFileSync(join(root, "deploy", "wrangler.release.jsonc"), join(out, "wrangler.jsonc"));
// Deployボタン付き README。
copyFileSync(join(root, "deploy", "README.template.md"), join(out, "README.md"));
// 静的アセットから _worker.js を除外する .assetsignore（公開Worker保護）。
if (existsSync(join(root, "public", ".assetsignore"))) {
  copyFileSync(join(root, "public", ".assetsignore"), join(out, ".assetsignore"));
}

// deploy スクリプト群（§2.4・§3.2）：
//   deploy = prebuild-update（日和見ローダ）→ wrangler deploy（deploy.log へ出力）→ postdeploy（初回URL報告）。
//   report.json は焼き込まない＝ホストが個別リポ生成時に注入する（共有リポでは無し＝初回ログイン捕捉に委ねる）。
writeFileSync(
  join(out, "package.json"),
  JSON.stringify(
    {
      private: true,
      scripts: { deploy: "node prebuild-update.mjs; npx wrangler deploy 2>&1 | tee deploy.log; node postdeploy.mjs" },
    },
    null,
    2,
  ) + "\n",
);
copyFileSync(join(root, "deploy", "prebuild-update.mjs"), join(out, "prebuild-update.mjs"));
copyFileSync(join(root, "deploy", "postdeploy.mjs"), join(out, "postdeploy.mjs"));
writeFileSync(join(out, "VERSION"), VERSION + "\n");

console.log(`完了：${out}`);
console.log("→ この release/ の内容を 公開配布リポジトリ（例 baku-team/baku-office-app）へ push すると Deploy ボタンが機能します。");
console.log("  ※ 公開リポジトリにはクライアント配布物のみ。ホスト/ソースは絶対に含めないこと（§3.1）。");
