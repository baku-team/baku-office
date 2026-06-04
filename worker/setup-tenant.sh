#!/usr/bin/env bash
# 【ホスト側】新しい顧客(テナント)を1社オンボードする。
#   - テナント用の PROVISION_KEY を発行し、ホスト台帳(TENANTS KV)に {url, provisionKey} を登録。
#   - 初期 config / lease を署名 → そのテナントの配信先URLへ push。
#   - 顧客に渡す3点（VERIFY_PUBLIC_JWK / PROVISION_KEY / TENANT_ID）を出力。
# 前提：ホストWorkerが TENANTS KV をバインドしてデプロイ済み（wrangler.host.toml の TENANTS）。
#       顧客のクライアントWorkerは配信先URL（カスタムドメイン推奨。別アカウントのworkers.devは可・同一アカウントは不可）で到達できること。
# 使い方： ADMIN_KEY=xxx WORKER_URL=https://<host>.workers.dev bash setup-tenant.sh <tenant-id> <client-url>
set -uo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }

TENANT="${1:-}"; CLIENT_URL="${2:-}"
[ -z "$TENANT" ] && read -r -p "テナントID（例: acme）: " TENANT
[ -z "$CLIENT_URL" ] && read -r -p "顧客クライアントの配信先URL（https://...）: " CLIENT_URL
: "${WORKER_URL:?ホストWorkerのURLを WORKER_URL に設定してください}"
: "${ADMIN_KEY:?ADMIN_KEY を設定してください}"
export WORKER_URL ADMIN_KEY

PROVKEY=$(openssl rand -hex 24 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(24).toString("hex"))')

say "公開検証鍵を取得"
PUB=$(node scripts/admin.mjs pubkey | sed -E 's/^[0-9]+ //')
echo "$PUB"

say "台帳に登録（tenant=$TENANT → $CLIENT_URL）"
node scripts/admin.mjs tenant "$TENANT" "$CLIENT_URL" "$PROVKEY"

say "初期 config / lease を署名→配信"
node scripts/admin.mjs config v1 "$TENANT"
node scripts/admin.mjs lease 30 "$TENANT"

say "顧客へ渡す値（顧客が自分のWorkerに登録）"
cat <<EOF
TENANT_ID         = $TENANT
VERIFY_PUBLIC_JWK = $PUB
PROVISION_KEY     = $PROVKEY

顧客側の作業：
  bash setup-client.sh   # 途中の VERIFY_PUBLIC_JWK / PROVISION_KEY / TENANT_ID に上記を入力
  ※ 配信先URLは同一アカウントの workers.dev では不可（CFが遮断）。カスタムドメイン推奨。
更新/停止（ホスト側）：
  ADMIN_KEY=$ADMIN_KEY WORKER_URL=$WORKER_URL node scripts/admin.mjs lease 30 $TENANT
  ADMIN_KEY=$ADMIN_KEY WORKER_URL=$WORKER_URL node scripts/admin.mjs lease -1 $TENANT   # 停止
EOF
