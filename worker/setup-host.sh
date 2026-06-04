#!/usr/bin/env bash
# 【ホスト側 / CP】署名・配信専用Workerを“別Worker”としてデプロイする。
#   - baku-office-host を deploy（顧客データなし・LINEなし・cronなし）。
#   - Ed25519鍵ペアを発行：SIGNING_JWK はホストだけが保持（本番はKMS）。
#   - クライアントには公開検証鍵 VERIFY_PUBLIC_JWK と PROVISION_KEY だけを配る。
#   - /admin で lease/config に署名し、クライアントの /provision へ push 配信。
# 前提：先に setup-client.sh でクライアントWorker(baku-office)を作成・デプロイ済みであること。
# 使い方： bash setup-host.sh
set -uo pipefail
cd "$(dirname "$0")"

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$1"; }

say "前提チェック"
command -v node >/dev/null || { echo "node が必要です"; exit 1; }
command -v npx >/dev/null || { echo "npx が必要です"; exit 1; }
[ -f wrangler.client.toml ] || { echo "wrangler.client.toml がありません。先に bash setup-client.sh を実行してください。"; exit 1; }
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

# クライアントWorkerのURL（配信先）。client側 wrangler.client.toml の PUBLIC_BASE_URL から取得。
CLIENT_URL=$(grep -E '^PUBLIC_BASE_URL' wrangler.client.toml | head -1 | sed -E 's/.*"(.*)".*/\1/')
{ [ -z "$CLIENT_URL" ] || [ "$CLIENT_URL" = "__PUBLIC_BASE_URL__" ]; } && read -r -p "クライアントWorkerの公開URL (https://...workers.dev): " CLIENT_URL
echo "配信先クライアント: $CLIENT_URL"

say "テナント台帳 TENANTS KV を作成"
TEN_OUT=$(npx wrangler kv namespace create TENANTS 2>&1 || true); echo "$TEN_OUT"
TEN_ID=$(echo "$TEN_OUT" | grep -oE '[a-f0-9]{32}' | head -1)
[ -z "$TEN_ID" ] && read -r -p "TENANTS の KV id を貼り付け: " TEN_ID

say "ホスト用 wrangler.host.toml を生成"
cp wrangler.host.toml.example wrangler.host.toml
sed -i.bak -e "s|__CLIENT_BASE_URL__|$CLIENT_URL|" -e "s|__TENANTS_KV_ID__|$TEN_ID|" wrangler.host.toml
rm -f wrangler.host.toml.bak

say "ホストWorkerを初回デプロイ（baku-office-host）"
npx wrangler deploy -c wrangler.host.toml >/dev/null 2>&1 && echo "host deployed"

say "鍵・配信シークレットを発行"
PRIV=$(node scripts/genkey.mjs)
PUB=$(printf '%s' "$PRIV" | node scripts/pubkey.mjs)
PROVISION_KEY=$(openssl rand -hex 16 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
ADMIN_KEY=$(openssl rand -hex 16 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')

say "ホスト側 secret を登録（SIGNING_JWK / ADMIN_KEY / PROVISION_KEY）"
# 【本番】SIGNING_JWK は KMS へ。クライアントWorkerには絶対に置かない。
printf '%s' "$PRIV"          | npx wrangler secret put SIGNING_JWK   -c wrangler.host.toml
printf '%s' "$ADMIN_KEY"     | npx wrangler secret put ADMIN_KEY     -c wrangler.host.toml
printf '%s' "$PROVISION_KEY" | npx wrangler secret put PROVISION_KEY -c wrangler.host.toml
npx wrangler deploy -c wrangler.host.toml >/dev/null 2>&1
HOST_URL=$(npx wrangler deploy -c wrangler.host.toml 2>&1 | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
echo "ホストWorker: ${HOST_URL:-(URL取得失敗)}"

say "クライアント側へ公開検証鍵と配信鍵を配布（VERIFY_PUBLIC_JWK / PROVISION_KEY）"
# 別アカウント構成では、この2つを顧客に渡して顧客自身が登録する（秘密鍵は渡さない）。
printf '%s' "$PUB"           | npx wrangler secret put VERIFY_PUBLIC_JWK -c wrangler.client.toml
printf '%s' "$PROVISION_KEY" | npx wrangler secret put PROVISION_KEY     -c wrangler.client.toml

say "初期 config / lease を署名→クライアントへ配信"
sleep 2
ADMIN_KEY="$ADMIN_KEY" WORKER_URL="$HOST_URL" node scripts/admin.mjs config v1
ADMIN_KEY="$ADMIN_KEY" WORKER_URL="$HOST_URL" node scripts/admin.mjs lease 30

say "ホスト側 完了"
cat <<EOF
ホストWorker     = $HOST_URL
クライアントWorker = $CLIENT_URL
ADMIN_KEY        = $ADMIN_KEY   ← lease/config 操作に使う。安全に保管（クライアントへ渡さない）。
公開検証鍵        = $PUB

管理コマンド（ホスト側で実行・admin はホストWorkerに対して叩く）:
  ADMIN_KEY=$ADMIN_KEY WORKER_URL=$HOST_URL node scripts/admin.mjs lease 30   # 30日有効化→配信
  ADMIN_KEY=$ADMIN_KEY WORKER_URL=$HOST_URL node scripts/admin.mjs lease -1   # 期限切れ→配信（停止デモ）
  ADMIN_KEY=$ADMIN_KEY WORKER_URL=$HOST_URL node scripts/admin.mjs config v2  # 人格切替→配信

本番（別アカウントの顧客）へ割る時:
  1) SIGNING_JWK は KMS/HSM（署名のみ）。素のSecretから外す。
  2) 顧客には VERIFY_PUBLIC_JWK と PROVISION_KEY だけ渡す（顧客が自分のWorkerに登録）。
  3) admin(lease/config) はホスト専用＋JITアクセスに限定。
EOF
