#!/usr/bin/env bash
# 【クライアント側】顧客Workerの立ち上げ：インフラ(KV/D1)・BYOK・LINE・デプロイ・Webhook。
# 設定は wrangler.client.toml（クライアント＝検証のみ。署名秘密鍵 SIGNING_JWK は一切扱わない）。
#   - 公開検証鍵 VERIFY_PUBLIC_JWK と配信鍵 PROVISION_KEY は、この後 setup-host.sh が別Worker(ホスト)を建てて配布・登録する。
# 使い方： bash setup-client.sh
set -uo pipefail
cd "$(dirname "$0")"
TOML=wrangler.client.toml

say() { printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$1"; }

say "前提チェック"
command -v node >/dev/null || { echo "node が必要です"; exit 1; }
command -v npx >/dev/null || { echo "npx が必要です"; exit 1; }
echo "node $(node -v)"

cat <<'EOF'

【クライアント側セットアップ】事前に用意するもの:
  1) Cloudflare アカウント（無料枠でOK・カード登録は不要。MEDIAはKV運用）
  2) LINE公式アカウント＋Messaging APIチャネル（チャネルシークレット／アクセストークン）
  3) Anthropic APIキー（任意：Gemini＝音声/無料スタック、Google OAuth＝Drive大容量）
  4) 公開検証鍵/配信鍵はこの後 setup-host.sh（別Worker）が配布するため、ここでは不要
準備ができたら Enter（中断は Ctrl-C）
EOF
read -r _

say "依存インストール"
npm install

say "Cloudflare ログイン"
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

say "$TOML を生成"
if [ -f "$TOML" ]; then
  read -r -p "既存 $TOML を上書きしますか? (y/N): " ow
  [ "${ow:-N}" = "y" ] && cp wrangler.client.toml.example "$TOML" || echo "既存を使用します"
else
  cp wrangler.client.toml.example "$TOML"
fi

say "KV 作成（HISTORY＝履歴/設定 ・ MEDIA＝画像/書類本体）"
KVH_OUT=$(npx wrangler kv namespace create HISTORY 2>&1 || true); echo "$KVH_OUT"
KVH_ID=$(echo "$KVH_OUT" | grep -oE '[a-f0-9]{32}' | head -1)
[ -z "$KVH_ID" ] && read -r -p "HISTORY の KV id を貼り付け: " KVH_ID
sed -i.bak "s|__KV_HISTORY_ID__|$KVH_ID|" "$TOML"

KVM_OUT=$(npx wrangler kv namespace create MEDIA 2>&1 || true); echo "$KVM_OUT"
KVM_ID=$(echo "$KVM_OUT" | grep -oE '[a-f0-9]{32}' | head -1)
[ -z "$KVM_ID" ] && read -r -p "MEDIA の KV id を貼り付け: " KVM_ID
sed -i.bak "s|__KV_MEDIA_ID__|$KVM_ID|" "$TOML"

say "D1 作成"
D1_OUT=$(npx wrangler d1 create baku-office-db 2>&1 || true); echo "$D1_OUT"
D1_ID=$(echo "$D1_OUT" | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
[ -z "$D1_ID" ] && read -r -p "database_id を貼り付け: " D1_ID
sed -i.bak "s|__D1_ID__|$D1_ID|" "$TOML"
rm -f "$TOML.bak"

say "D1 スキーマ適用（schema.sql は現行フル構成）"
npx wrangler d1 execute baku-office-db --remote --file=schema.sql
# 既存DBを引き継ぐ場合のみ、未適用の差分があれば migrate_*.sql を個別適用する：
#   npx wrangler d1 execute baku-office-db --remote --file=migrate_<name>.sql

say "初回デプロイ（Workerを作成して公開URLを確定）"
DEPLOY_OUT=$(npx wrangler deploy -c "$TOML" 2>&1); echo "$DEPLOY_OUT"
WORKER_URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1)
[ -z "$WORKER_URL" ] && read -r -p "Worker の公開URL (https://...workers.dev) を貼り付け: " WORKER_URL

say "PUBLIC_BASE_URL を埋めて再デプロイ"
sed -i.bak "s|__PUBLIC_BASE_URL__|$WORKER_URL|" "$TOML"
rm -f "$TOML.bak"
npx wrangler deploy -c "$TOML" >/dev/null 2>&1 && echo "PUBLIC_BASE_URL = $WORKER_URL"

say "クライアント秘密情報を登録（入力は画面に表示されません）"
read -r -s -p "Anthropic API Key: " V; echo; printf '%s' "$V" | npx wrangler secret put ANTHROPIC_API_KEY -c "$TOML"
read -r -s -p "LINE Channel Secret: " LS; echo; printf '%s' "$LS" | npx wrangler secret put LINE_CHANNEL_SECRET -c "$TOML"
read -r -s -p "LINE Channel Access Token: " LT; echo; printf '%s' "$LT" | npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN -c "$TOML"
read -r -s -p "Gemini API Key（音声/無料スタック・任意・不要ならEnter）: " GK; echo
[ -n "$GK" ] && printf '%s' "$GK" | npx wrangler secret put GEMINI_API_KEY -c "$TOML"
read -r -s -p "Google OAuth Client ID（Drive大容量・任意・不要ならEnter）: " GCID; echo
if [ -n "$GCID" ]; then
  printf '%s' "$GCID" | npx wrangler secret put GOOGLE_CLIENT_ID -c "$TOML"
  read -r -s -p "Google OAuth Client Secret: " GCS; echo; printf '%s' "$GCS" | npx wrangler secret put GOOGLE_CLIENT_SECRET -c "$TOML"
fi
# 自己連鎖Cron（/internal/drain）保護用の内部秘密
INTERNAL_KEY=$(openssl rand -hex 16 2>/dev/null || node -e 'console.log(require("crypto").randomBytes(16).toString("hex"))')
printf '%s' "$INTERNAL_KEY" | npx wrangler secret put INTERNAL_KEY -c "$TOML"

# 開発バイパス（任意）：ここに載せたLINE userId だけ認証(lease/config)を飛ばす。本番は空Enterで無効。
read -r -p "開発バイパスする LINE userId（カンマ区切り・任意・本番は空Enter）: " DEVIDS
[ -n "$DEVIDS" ] && printf '%s' "$DEVIDS" | npx wrangler secret put DEV_USER_IDS -c "$TOML"

# --- 検証鍵/配信鍵 ---
# 同一アカウント運用：ホスト側 setup-host.sh が後でまとめて登録するので、ここは空Enterでよい。
# 別アカウント運用（顧客が自分のアカウントで構築）：ホストから渡された値をここで登録する。
read -r -s -p "VERIFY_PUBLIC_JWK（ホスト配布の公開検証鍵・同一アカウントなら空Enter）: " VPK; echo
[ -n "$VPK" ] && printf '%s' "$VPK" | npx wrangler secret put VERIFY_PUBLIC_JWK -c "$TOML"
read -r -s -p "PROVISION_KEY（ホスト配布の配信鍵・同一アカウントなら空Enter）: " CPK; echo
[ -n "$CPK" ] && printf '%s' "$CPK" | npx wrangler secret put PROVISION_KEY -c "$TOML"
read -r -p "TENANT_ID（自テナントID・別アカウント運用で推奨・同一アカウントなら空Enter）: " TID
[ -n "$TID" ] && printf '%s' "$TID" | npx wrangler secret put TENANT_ID -c "$TOML"

say "LINE Webhook 設定"
if [ -n "$WORKER_URL" ]; then
  curl -sS -X PUT https://api.line.me/v2/bot/channel/webhook/endpoint \
    -H "Authorization: Bearer $LT" -H "Content-Type: application/json" \
    -d "{\"endpoint\":\"$WORKER_URL/webhook\"}" && echo
  echo "Webhook URL = $WORKER_URL/webhook を設定しました。"
else
  warn "Worker URL を自動取得できませんでした。LINE Developers で手動設定: <worker-url>/webhook"
fi

say "クライアント側 完了"
cat <<EOF
WORKER_URL = $WORKER_URL

次の手動確認（LINE Developers Console / Messaging API設定）:
  - 「Webhookの利用」ON
  - 「応答メッセージ」OFF

次の手順:
  - 次に【ホスト側】 bash setup-host.sh を実行 → 別Worker(baku-office-host)を建て、検証鍵/配信鍵を本Workerへ配布し、初期lease/configを配信します。
  - それまでは通常アカウントは「未承認」応答（DEV_USER_IDS のアカウントのみ動作）。
  - 任意：Drive大容量連携は $WORKER_URL/oauth/start をブラウザで開いて連携。
EOF
