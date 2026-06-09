#!/usr/bin/env bash
set -euo pipefail

# Google 連携(OAuth)の前段を自動化するヘルパー（技術者向け）。
#   ・GCP プロジェクト作成（または既存を使用）
#   ・必要 API の有効化（Calendar / Gmail / Meet）
# OAuth クライアントID/シークレットの発行は Google がプログラム生成を許可していないため手動。
# 本スクリプトは最後に、残りの手動ステップへのリンクと貼り付け用のリダイレクト URI を表示する。
#
# 使い方:
#   scripts/google-oauth-setup.sh [PROJECT_ID] [APP_ORIGIN]
#     PROJECT_ID  省略時は baku-office-XXXX を自動生成（6〜30字・英小文字始まり）
#     APP_ORIGIN  省略時は本番 client の URL（リダイレクト URI の生成に使用）
#
# 前提: gcloud CLI がインストール済みで `gcloud auth login` 済みであること。

APP_ORIGIN="${2:-https://baku-office-app.baku-027.workers.dev}"
PROJECT_ID="${1:-baku-office-$(printf '%04d' $((RANDOM % 10000)))}"
REDIRECT_URI="${APP_ORIGIN%/}/api/google/callback"

# 有効化する API（使う機能に応じて取捨選択可。既定は全部）。
APIS=(
  "calendar-json.googleapis.com"  # Google Calendar API
  "gmail.googleapis.com"          # Gmail API
  "meet.googleapis.com"           # Google Meet API
)

echo "==> 前提チェック"
if ! command -v gcloud >/dev/null 2>&1; then
  echo "✗ gcloud が見つかりません。Google Cloud SDK をインストールしてください: https://cloud.google.com/sdk/docs/install" >&2
  exit 1
fi
ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null || true)"
if [ -z "${ACTIVE_ACCOUNT}" ]; then
  echo "✗ gcloud にログインしていません。まず実行してください: gcloud auth login" >&2
  exit 1
fi
echo "  アカウント : ${ACTIVE_ACCOUNT}"
echo "  プロジェクト: ${PROJECT_ID}"
echo "  アプリ URL : ${APP_ORIGIN}"
echo

echo "==> プロジェクトの作成（既存ならスキップ）"
if gcloud projects describe "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "  既存プロジェクトを使用します: ${PROJECT_ID}"
else
  if ! gcloud projects create "${PROJECT_ID}" --name="baku-office Google連携"; then
    echo "✗ プロジェクト作成に失敗しました。プロジェクトID重複・組織ポリシー・割当上限などをご確認ください。" >&2
    echo "  既存プロジェクトを使う場合は: scripts/google-oauth-setup.sh <既存PROJECT_ID> ${APP_ORIGIN}" >&2
    exit 1
  fi
  echo "  作成しました: ${PROJECT_ID}"
fi
echo

echo "==> API を有効化（数十秒かかる場合があります）"
gcloud services enable "${APIS[@]}" --project="${PROJECT_ID}"
echo "  有効化済み: ${APIS[*]}"
echo

cat <<EOF
============================================================
✅ 自動化はここまで完了しました（プロジェクト作成 + API 有効化）。
   以降は Google の仕様上、手動操作が必要です。
------------------------------------------------------------
1) OAuth 同意画面の設定
   https://console.cloud.google.com/apis/credentials/consent?project=${PROJECT_ID}
   - User Type：組織内のみなら「内部」、外部利用なら「外部」
   - アプリ名・サポートメールを入力
   - スコープ（使う機能の分だけ）:
       https://www.googleapis.com/auth/calendar.events
       https://www.googleapis.com/auth/gmail.modify        ← Restricted（審査対象）
       https://www.googleapis.com/auth/gmail.send          ← Restricted（審査対象）
       https://www.googleapis.com/auth/meetings.space.created
       https://www.googleapis.com/auth/meetings.space.readonly
   - テスト段階は「テストユーザー」に連携する Google アカウントを追加

2) OAuth クライアント ID（ウェブ アプリケーション）の作成
   https://console.cloud.google.com/apis/credentials/oauthclient?project=${PROJECT_ID}
   - 種類：ウェブ アプリケーション
   - 承認済みのリダイレクト URI（下をそのまま貼り付け）:
       ${REDIRECT_URI}

3) 発行された クライアントID / シークレット を baku-office に登録
   設定 → 連携設定、または「Google 連携セットアップ」画面で貼り付けて保存
   （暗号化保存・再デプロイ不要）
============================================================
EOF
