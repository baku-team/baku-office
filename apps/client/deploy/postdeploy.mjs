// 初回デプロイ自動点灯（deploy仕様§2.4）：
//   report.json（ホストが個別リポに注入した {code,host}）と deploy.log（wrangler の出力）から
//   公開URLを抽出し、当社ホストの /api/deploy-report へ {code,url} を直接POSTする。
//   report.json が無い（共有リポ）→ 何もしない＝初回 Google ログイン時の捕捉に委ねる（§2.7）。
//   ホストへ送るのは公開URLのみ（原則1：CF/GitHub トークンや Deploy Hook は送らない）。
import { readFileSync } from "node:fs";

let code, host, url;
try {
  const r = JSON.parse(readFileSync("report.json", "utf8"));
  code = r.code;
  host = String(r.host || "").replace(/\/$/, "");
} catch {
  process.exit(0); // report.json 無し（共有リポ）
}
try {
  url = (readFileSync("deploy.log", "utf8").match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i) || [])[0];
} catch {}
if (!code || !host || !url) process.exit(0);

for (let i = 0; i < 6; i++) {
  try {
    const r = await fetch(host + "/api/deploy-report", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, url }),
    });
    if (r.ok) break;
  } catch {}
  await new Promise((s) => setTimeout(s, 10000)); // 初回 523/DNS伝播を吸収
}
