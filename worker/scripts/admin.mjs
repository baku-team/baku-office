// admin操作（ホスト側）：署名済みリース/configを発行→対象テナントへ配信。テナント台帳・公開鍵取得も。
// 使い方（WORKER_URL は“ホスト”Worker・既定は self 配信先）：
//   ADMIN_KEY=xxx node scripts/admin.mjs lease 30            # selfに30日リース
//   ADMIN_KEY=xxx node scripts/admin.mjs lease 30 acme       # テナントacmeに30日リース
//   ADMIN_KEY=xxx node scripts/admin.mjs config v2 acme      # acmeの人格をv2に
//   ADMIN_KEY=xxx node scripts/admin.mjs tenant acme https://acme.example.com PROVKEY  # 台帳に登録
//   ADMIN_KEY=xxx node scripts/admin.mjs tenants             # テナント一覧
//   ADMIN_KEY=xxx node scripts/admin.mjs pubkey              # 公開検証鍵（顧客へ配る VERIFY_PUBLIC_JWK）
const WORKER_URL = process.env.WORKER_URL || "https://baku-office-host.fragrant-sun-78f3.workers.dev";
const ADMIN_KEY = process.env.ADMIN_KEY;
const [, , cmd, a1, a2, a3] = process.argv;

if (!ADMIN_KEY) {
  console.error("ADMIN_KEY env が必要です：ADMIN_KEY=xxx node scripts/admin.mjs <cmd> ...");
  process.exit(1);
}

const q = (o) => new URLSearchParams(o).toString();
let path;
let method = "POST";
if (cmd === "lease") path = `/admin/lease?${q({ days: a1 ?? "30", ...(a2 ? { tenant: a2 } : {}) })}`;
else if (cmd === "config") path = `/admin/config?${q({ version: a1 ?? "v1", ...(a2 ? { tenant: a2 } : {}) })}`;
else if (cmd === "tenant") {
  if (!a1 || !a2) {
    console.error("使い方: tenant <id> <url> [provisionKey]");
    process.exit(1);
  }
  path = `/admin/tenant?${q({ id: a1, url: a2, ...(a3 ? { provisionKey: a3 } : {}) })}`;
} else if (cmd === "tenants") {
  path = "/admin/tenants";
  method = "GET";
} else if (cmd === "pubkey") {
  path = "/admin/pubkey";
  method = "GET";
} else {
  console.error("cmd は lease|config|tenant|tenants|pubkey。例: node scripts/admin.mjs lease 30 acme");
  process.exit(1);
}

const res = await fetch(WORKER_URL + path, { method, headers: { "x-admin-key": ADMIN_KEY } });
console.log(res.status, await res.text());
