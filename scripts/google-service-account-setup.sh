#!/usr/bin/env bash
set -euo pipefail

# Google 連携（サービスアカウント＋ドメイン全体の委任 / DWD）の資格情報をほぼ自動で用意するヘルパー。
#   ・GCP プロジェクト作成（または既存を使用）
#   ・必要 API の有効化（Calendar / Gmail / Meet）
#   ・サービスアカウント作成 ＋ 鍵(JSON) 発行
#   ・最後に、設定画面に貼る鍵ファイルと、管理コンソールの「ドメイン全体の委任」に登録する
#     クライアントID・スコープ・手順を表示する。
# OAuth クライアントID/シークレットや同意画面は不要。残る手動は管理コンソールでの委任承認 1 回のみ。
#
# 使い方:
#   scripts/google-service-account-setup.sh [PROJECT_ID] [SA_NAME]
#     PROJECT_ID  省略時は baku-office-XXXX を自動生成
#     SA_NAME     省略時は baku-office-bot（6〜30字・英小文字始まり）
#
# 前提: gcloud CLI 導入済み・`gcloud auth login` 済み・課金/権限が有効なこと。

PROJECT_ID="${1:-baku-office-$(printf '%04d' $((RANDOM % 10000)))}"
SA_NAME="${2:-baku-office-bot}"
KEY_FILE="${SA_NAME}-key.json"

# 委任するスコープ（設定画面で選んだ機能に合わせて取捨選択可。既定は Calendar + Meet）。
SCOPES="https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/meetings.space.created,https://www.googleapis.com/auth/meetings.space.readonly"
APIS=(
  "calendar-json.googleapis.com"  # Google Calendar API
  "gmail.googleapis.com"          # Gmail API
  "meet.googleapis.com"           # Google Meet API
)

echo "==> 前提チェック"
if ! command -v gcloud >/dev/null 2>&1; then
  echo "✗ gcloud が見つかりません。Google Cloud SDK を入れてください: https://cloud.google.com/sdk/docs/install" >&2
  exit 1
fi
ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
if [ -z "${ACTIVE_ACCOUNT}" ]; then
  echo "✗ gcloud にログインしていません。まず実行: gcloud auth login" >&2
  exit 1
fi
echo "  アカウント     : ${ACTIVE_ACCOUNT}"
echo "  プロジェクト   : ${PROJECT_ID}"
echo "  サービスアカウント: ${SA_NAME}"

echo "==> プロジェクトの用意"
if ! gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "  作成: ${PROJECT_ID}"
  gcloud projects create "${PROJECT_ID}" --name="baku-office" >/dev/null
else
  echo "  既存を使用: ${PROJECT_ID}"
fi
gcloud config set project "${PROJECT_ID}" >/dev/null

echo "==> API の有効化"
gcloud services enable "${APIS[@]}" >/dev/null
echo "  有効化: ${APIS[*]}"

SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
echo "==> サービスアカウントの用意"
if ! gcloud iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SA_NAME}" --display-name="baku-office bot" >/dev/null
  echo "  作成: ${SA_EMAIL}"
else
  echo "  既存を使用: ${SA_EMAIL}"
fi

echo "==> 鍵(JSON)の発行"
gcloud iam service-accounts keys create "${KEY_FILE}" --iam-account="${SA_EMAIL}" >/dev/null
echo "  鍵を書き出し: ${KEY_FILE}（取扱注意・第三者に渡さない）"

CLIENT_ID="$(gcloud iam service-accounts describe "${SA_EMAIL}" --format='value(oauth2ClientId)')"

cat <<EOF

============================================================
 セットアップ完了。あと 2 つの操作で連携できます。
============================================================

【A】baku-office の「Google連携セットアップ」画面（方法：サービスアカウント）で:
  1. 鍵ファイル  : ${KEY_FILE} を選択
  2. 代理ユーザー: Google の予定/メールを操作する Workspace ユーザーのメール（例 admin@yourdomain）
  3. 利用する機能（スコープ）を選んで「この内容で登録」

【B】Google Workspace 管理コンソール（超管理者）で「ドメイン全体の委任」を 1 回承認:
  URL    : https://admin.google.com/ac/owl/domainwidedelegation
  クライアントID : ${CLIENT_ID}
  スコープ       : ${SCOPES}
  （画面の値が最優先。利用機能を増やしたら、その分のスコープも委任に追加してください）

承認後、設定画面の「接続テスト」が成功すれば連携完了です。
============================================================
EOF
